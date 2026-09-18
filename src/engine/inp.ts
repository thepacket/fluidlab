// EPANET adapter, part 1: translate a FluidLab model into an EPANET .inp file.
// Units: LPS / SI  →  flow L/s, length m, diameter mm, roughness mm (D-W), pressure m.
import { demandFactor, dischargeDevice, lossDevice } from '../model/catalog'
import { G, area, sourceHead, wellDrawdown, pumpShape, elementK, fittingK, ratedDp, tankHeight, valveK, vesselPressure, vesselWater } from '../model/physics'
import { isControl, isInline, type Model, type Warning } from '../model/types'

export interface Compiled {
  inp: string
  /** FluidLab node id → EPANET node id (plain nodes) */
  nodeIds: Record<string, string>
  /** inline device id → EPANET ids */
  deviceIds: Record<string, { a: string; b: string; link: string }>
  pipeIds: Record<string, string>
  excluded: string[]
  warnings: Warning[]
  empty: boolean
}

export interface Overrides {
  pumpSpeed?: Record<string, number>
}

const n = (v: number) => (Math.abs(v) < 1e-12 ? '0' : Number(v.toPrecision(8)).toString())

/** A controller's 0‥1 command for this device; 1 when nothing is wired to it. It scales the device's own setting. */
export const command = (model: Model, id: string) => model.controls?.[id] ?? 1
/**
 * A float valve closes as the tank it feeds fills: wide open a band below its closing level, shut at it.
 * "The tank it feeds" is whichever tank sits on the far end of a pipe from its outlet port.
 */
export function floatTank(model: Model, valveId: string) {
  for (const e of model.edges) {
    if (e.type === 'signal') continue
    const other = e.source === valveId && e.sourceHandle === 'out' ? e.target : e.target === valveId && e.targetHandle === 'out' ? e.source : undefined
    const tank = other && model.nodes.find((x) => x.id === other && x.data.kind === 'tank')
    if (tank) return tank
  }
  return undefined
}

/** Where a throttling valve's plug actually is, 0‥1: its own opening, scaled by a controller or by its float. */
export function valvePosition(model: Model, id: string): number {
  const nd = model.nodes.find((x) => x.id === id)
  if (!nd) return 0
  const p = nd.data.props
  let pos = p.opening * command(model, id)
  if (p.valveType === 'float') {
    const tank = floatTank(model, id)
    if (tank) {
      const level = model.levels?.[tank.id] ?? tank.data.props.initLevel
      // an altitude valve is the on/off cousin: shut at the level, open again a band below it (the latch lives with the levels)
      pos *= p.floatMode === 'altitude' ? (model.levels?.[`${id}:shut`] ? 0 : 1) : Math.min(1, Math.max(0, (p.closeLevel - level) / Math.max(1e-6, p.band)))
    }
  }
  return pos
}

/** Held off / shut by its controller. */
export const commandedOff = (model: Model, id: string) => command(model, id) < 0.5

export function compile(full: Model, overrides: Overrides = {}): Compiled {
  // controllers and their signal wires are not part of the hydraulic network
  const model: Model = { ...full, nodes: full.nodes.filter((nd) => !isControl(nd.data.kind)), edges: full.edges.filter((e) => e.type !== 'signal') }
  const off = (id: string) => commandedOff(model, id)
  const warnings: Warning[] = []
  const nodeIds: Compiled['nodeIds'] = {}
  const deviceIds: Compiled['deviceIds'] = {}
  const pipeIds: Compiled['pipeIds'] = {}
  const byId = new Map(model.nodes.map((nd) => [nd.id, nd]))

  model.nodes.forEach((nd, i) => {
    if (isInline(nd.data.kind)) deviceIds[nd.id] = { a: `N${i}a`, b: `N${i}b`, link: `D${i}` }
    else nodeIds[nd.id] = `N${i}`
  })

  const port = (nodeId: string, handle?: string | null): string | undefined => {
    if (nodeIds[nodeId]) return nodeIds[nodeId]
    const d = deviceIds[nodeId]
    if (!d) return undefined
    return handle === 'out' ? d.b : d.a
  }

  // ---- connectivity: keep only what can reach a fixed-head source ----
  const adj = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, [])
    if (!adj.has(b)) adj.set(b, [])
    adj.get(a)!.push(b)
    adj.get(b)!.push(a)
  }
  const edges = model.edges.map((e) => ({ e, a: port(e.source, e.sourceHandle), b: port(e.target, e.targetHandle) })).filter((x) => x.a && x.b && x.a !== x.b) as {
    e: Model['edges'][0]
    a: string
    b: string
  }[]
  edges.forEach((x) => link(x.a, x.b))
  // a differential gauge is a permanently closed link: its two sides must each reach a source on their own
  model.nodes.forEach((nd) => {
    const d = deviceIds[nd.id]
    if (d && nd.data.kind !== 'dpgauge') link(d.a, d.b)
  })

  const reached = new Set<string>()
  const queue: string[] = []
  model.nodes.forEach((nd) => {
    if (nd.data.kind === 'reservoir' || nd.data.kind === 'tank' || nd.data.kind === 'vessel') queue.push(nodeIds[nd.id])
  })
  while (queue.length) {
    const cur = queue.pop()!
    if (reached.has(cur)) continue
    reached.add(cur)
    ;(adj.get(cur) ?? []).forEach((m) => !reached.has(m) && queue.push(m))
  }

  const excluded: string[] = []
  const emitted = new Set<string>()
  const live = model.nodes.filter((nd) => {
    const d = deviceIds[nd.id]
    const ids = d ? [d.a, d.b] : [nodeIds[nd.id]]
    const wired = (id: string) => reached.has(id) && (adj.get(id)?.length ?? 0) > 0
    const ok = nd.data.kind === 'dpgauge' ? ids.every(wired) : wired(ids[0])
    if (ok) ids.forEach((id) => emitted.add(id))
    else excluded.push(nd.id)
    return ok
  })
  const liveEdges = edges.filter((x) => emitted.has(x.a) && emitted.has(x.b))
  model.edges.forEach((e) => {
    if (!liveEdges.find((x) => x.e.id === e.id)) excluded.push(e.id)
  })

  const rhoG = model.fluid.density * G
  const J: string[] = []
  const R: string[] = []
  const T: string[] = []
  const P: string[] = []
  const PU: string[] = []
  const V: string[] = []
  const EM: string[] = []
  const CU: string[] = []
  const ST: string[] = []

  for (const nd of live) {
    const p = nd.data.props
    const k = nd.data.kind
    if (k === 'reservoir' && p.sourceType === 'well') {
      // aquifer at its static level, then a head-loss curve standing in for drawdown; the node is the pumping level
      const id = nodeIds[nd.id]
      R.push(`${id}aq ${n(p.staticLevel)}`)
      J.push(`${id} ${n(p.staticLevel - 200)} 0`)
      for (const f of [0, 1, 4]) CU.push(`C${id}w ${n(p.ratedYield * f * 1000)} ${n(wellDrawdown(p, p.ratedYield * f))}`)
      V.push(`${id}w ${id}aq ${id} 300 GPV C${id}w 0`)
    } else if (k === 'reservoir') R.push(`${nodeIds[nd.id]} ${n(sourceHead(p, rhoG))}`)
    else if (k === 'tank') {
      const min = Math.max(0, p.minLevel)
      const max = Math.max(min + 0.01, tankHeight(p))
      const lvl = Math.min(max, Math.max(min, model.levels?.[nd.id] ?? p.initLevel))
      // a tank that may overflow must never look "full" to the solver, or it would shut the inlet instead of spilling
      T.push(`${nodeIds[nd.id]} ${n(p.elevation)} ${n(lvl)} ${n(min)} ${n(p.overflow ? max + 1000 : max)} ${n(Math.max(0.05, p.diameter))} 0`)
    } else if (k === 'vessel') {
      // A fixed-head node whose head is set by the gas cushion. The stub pipe lets an empty vessel refuse to give
      // water (check valve towards the vessel) exactly as an empty tank would.
      const id = nodeIds[nd.id]
      const water = model.levels?.[nd.id] ?? vesselWater(p, p.initPressure)
      J.push(`${id} ${n(p.elevation)} 0`)
      R.push(`${id}gas ${n(p.elevation + vesselPressure(p, water) / rhoG)}`)
      P.push(`${id}s ${id} ${id}gas 0.05 100 0.0015 0 ${water <= 1e-9 ? 'CV' : 'OPEN'}`)
    } else if (k === 'leak') {
      J.push(`${nodeIds[nd.id]} ${n(p.elevation)} 0`)
      if (p.active !== false) EM.push(`${nodeIds[nd.id]} ${n(Math.max(p.cd * area(p.holeDiameter) * Math.sqrt(2 * G) * 1000, 1e-6))}`)
    } else if (k === 'relief') {
      // A PSV holds its upstream side at the set pressure by venting — exactly a modulating relief valve.
      // EPANET won't join a valve straight to a reservoir, hence the stub pipe to "atmosphere".
      const id = nodeIds[nd.id]
      J.push(`${id} ${n(p.elevation)} 0`, `${id}m ${n(p.elevation)} 0`)
      R.push(`${id}atm ${n(p.elevation)}`)
      V.push(`${id}v ${id} ${id}m ${n(p.diameter * 1000)} PSV ${n(p.setPressure / rhoG)} 0`)
      P.push(`${id}s ${id}m ${id}atm 0.05 ${n(Math.max(p.diameter, 0.05) * 1000)} 0.0015 0 CV`)
    } else if (k === 'junction' || k === 'gauge') {
      J.push(`${nodeIds[nd.id]} ${n(p.elevation)} ${n((p.demand ?? 0) * demandFactor(p.pattern, model.time ?? 0) * 1000)}`)
    } else if (k === 'outlet') {
      // a sprinkler head is a plugged hole until its bulb breaks
      const sealed = dischargeDevice(p.variant)?.glyph === 'sprinkler' && !p.fused
      if (off(nd.id) || sealed) J.push(`${nodeIds[nd.id]} ${n(p.elevation)} 0`)
      else if (p.mode === 'demand') J.push(`${nodeIds[nd.id]} ${n(p.elevation)} ${n(p.demand * demandFactor(p.pattern, model.time ?? 0) * 1000)}`)
      else {
        J.push(`${nodeIds[nd.id]} ${n(p.elevation)} 0`)
        // Q = K·√p is the emitter law; a plain nozzle is the same thing with K = Cd·A·√(2/ρ)
        const c = p.mode === 'kfactor' ? p.kFactor * Math.sqrt(rhoG) * 1000 : p.cd * area(p.nozzleDiameter) * Math.sqrt(2 * G) * 1000
        EM.push(`${nodeIds[nd.id]} ${n(Math.max(c, 1e-6))}`)
      }
    } else {
      const d = deviceIds[nd.id]
      J.push(`${d.a} ${n(p.elevation)} 0`, `${d.b} ${n(p.elevation)} 0`)
      if (k === 'pump') {
        const speed = overrides.pumpSpeed?.[nd.id] ?? p.speed * command(model, nd.id)
        // shut-off, duty and run-out: EPANET fits H = H₀ − B·Qᶜ through them, the same form pumpHead() uses
        const { r0, rMax } = pumpShape(p)
        CU.push(`C${d.link} 0 ${n(p.designHead * r0)}`, `C${d.link} ${n(p.designFlow * 1000)} ${n(p.designHead)}`, `C${d.link} ${n(p.designFlow * rMax * 1000)} 0`)
        PU.push(`${d.link} ${d.a} ${d.b} HEAD C${d.link} SPEED ${n(Math.max(speed, 0.01))}`)
        if (!p.on || speed < 0.01) ST.push(`${d.link} CLOSED`)
      } else if (k === 'meter') {
        P.push(`${d.link} ${d.a} ${d.b} 0.05 ${n(p.diameter * 1000)} 0.0015 0 OPEN`)
      } else if (k === 'element') {
        P.push(`${d.link} ${d.a} ${d.b} 0.05 ${n(p.diameter * 1000)} 0.0015 ${n(elementK(p))} OPEN`)
      } else if (k === 'fitting') {
        const dev = lossDevice(p.variant)
        if (dev.model === 'k') {
          const { bore, K } = fittingK(p, dev.byDiameters)
          P.push(`${d.link} ${d.a} ${d.b} 0.05 ${n(bore * 1000)} 0.0015 ${n(K)} OPEN`)
        } else {
          // head-loss curve out to 4× the rated flow; the solver interpolates between the points
          for (let i = 0; i <= 16; i++) {
            const q = (p.ratedFlow * 4 * i) / 16
            CU.push(`C${d.link} ${n(q * 1000)} ${n(ratedDp(q, p) / rhoG)}`)
          }
          V.push(`${d.link} ${d.a} ${d.b} ${n(p.diameter * 1000)} GPV C${d.link} 0`)
        }
      } else if (k === 'dpgauge') {
        P.push(`${d.link} ${d.a} ${d.b} 0.05 10 0.0015 0 CLOSED`)
      } else {
        const dia = n(p.diameter * 1000)
        const shut = off(nd.id)
        if (shut && p.valveType !== 'check' && p.valveType !== 'throttle' && p.valveType !== 'float') ST.push(`${d.link} CLOSED`)
        switch (p.valveType) {
          case 'check':
            P.push(`${d.link} ${d.a} ${d.b} 0.05 ${dia} 0.0015 ${n(p.kOpen)} ${shut ? 'CLOSED' : 'CV'}`)
            break
          case 'prv':
            V.push(`${d.link} ${d.a} ${d.b} ${dia} PRV ${n(p.pressureSetting / rhoG)} ${n(p.kOpen)}`)
            break
          case 'psv':
            V.push(`${d.link} ${d.a} ${d.b} ${dia} PSV ${n(p.pressureSetting / rhoG)} ${n(p.kOpen)}`)
            break
          case 'fcv':
            V.push(`${d.link} ${d.a} ${d.b} ${dia} FCV ${n(p.flowSetting * 1000)} ${n(p.kOpen)}`)
            break
          default: {
            const K = valveK(valvePosition(model, nd.id), p.kOpen, p.trim)
            V.push(`${d.link} ${d.a} ${d.b} ${dia} TCV ${n(isFinite(K) ? K : 1e9)} 0`)
            if (!isFinite(K)) ST.push(`${d.link} CLOSED`)
          }
        }
      }
    }
  }

  liveEdges.forEach((x, i) => {
    const p = x.e.data?.props
    if (!p) return
    const id = `P${i}`
    pipeIds[x.e.id] = id
    P.push(`${id} ${x.a} ${x.b} ${n(Math.max(0.01, p.length))} ${n(Math.max(1, p.diameter * 1000))} ${n(Math.max(1e-5, p.roughness * 1000))} ${n(p.minorK || 0)} OPEN`)
    const src = byId.get(x.e.source)
    if (!src) warnings.push({ id: x.e.id, level: 'warn', text: 'Pipe has a missing end' })
  })

  const nu = model.fluid.dynamicViscosity / model.fluid.density
  const inp = [
    '[TITLE]',
    'FluidLab',
    '[JUNCTIONS]',
    ...J,
    '[RESERVOIRS]',
    ...R,
    '[TANKS]',
    ...T,
    '[PIPES]',
    ...P,
    '[PUMPS]',
    ...PU,
    '[VALVES]',
    ...V,
    '[EMITTERS]',
    ...EM,
    '[CURVES]',
    ...CU,
    '[STATUS]',
    ...ST,
    '[OPTIONS]',
    'Units LPS',
    'Headloss D-W',
    `Specific Gravity ${n(model.fluid.density / 1000)}`,
    `Viscosity ${n(nu / 1.022e-6)}`,
    'Trials 200',
    'Accuracy 0.00001',
    'Unbalanced Continue 20',
    'Emitter Exponent 0.5',
    '[TIMES]',
    'Duration 0',
    '[REPORT]',
    'Status No',
    'Summary No',
    '[END]',
    '',
  ].join('\n')

  return { inp, nodeIds, deviceIds, pipeIds, excluded, warnings, empty: R.length + T.length === 0 || P.length + PU.length + V.length === 0 }
}
