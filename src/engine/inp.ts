// EPANET adapter, part 1: translate a FluidLab model into an EPANET .inp file.
// Units: LPS / SI  →  flow L/s, length m, diameter mm, roughness mm (D-W), pressure m.
import { G, area, elementK, valveK } from '../model/physics'
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
    if (nd.data.kind === 'reservoir' || nd.data.kind === 'tank') queue.push(nodeIds[nd.id])
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
    if (k === 'reservoir') R.push(`${nodeIds[nd.id]} ${n(p.head)}`)
    else if (k === 'tank') {
      const min = Math.max(0, p.minLevel)
      const max = Math.max(min + 0.01, p.maxLevel)
      const lvl = Math.min(max, Math.max(min, model.levels?.[nd.id] ?? p.initLevel))
      T.push(`${nodeIds[nd.id]} ${n(p.elevation)} ${n(lvl)} ${n(min)} ${n(max)} ${n(Math.max(0.05, p.diameter))} 0`)
    } else if (k === 'junction' || k === 'gauge') {
      J.push(`${nodeIds[nd.id]} ${n(p.elevation)} ${n((p.demand ?? 0) * 1000)}`)
    } else if (k === 'outlet') {
      if (off(nd.id)) J.push(`${nodeIds[nd.id]} ${n(p.elevation)} 0`)
      else if (p.mode === 'demand') J.push(`${nodeIds[nd.id]} ${n(p.elevation)} ${n(p.demand * 1000)}`)
      else {
        J.push(`${nodeIds[nd.id]} ${n(p.elevation)} 0`)
        const c = p.cd * area(p.nozzleDiameter) * Math.sqrt(2 * G) * 1000
        EM.push(`${nodeIds[nd.id]} ${n(Math.max(c, 1e-6))}`)
      }
    } else {
      const d = deviceIds[nd.id]
      J.push(`${d.a} ${n(p.elevation)} 0`, `${d.b} ${n(p.elevation)} 0`)
      if (k === 'pump') {
        const speed = overrides.pumpSpeed?.[nd.id] ?? p.speed * command(model, nd.id)
        CU.push(`C${d.link} ${n(p.designFlow * 1000)} ${n(p.designHead)}`)
        PU.push(`${d.link} ${d.a} ${d.b} HEAD C${d.link} SPEED ${n(Math.max(speed, 0.01))}`)
        if (!p.on || speed < 0.01) ST.push(`${d.link} CLOSED`)
      } else if (k === 'meter') {
        P.push(`${d.link} ${d.a} ${d.b} 0.05 ${n(p.diameter * 1000)} 0.0015 0 OPEN`)
      } else if (k === 'element') {
        P.push(`${d.link} ${d.a} ${d.b} 0.05 ${n(p.diameter * 1000)} 0.0015 ${n(elementK(p))} OPEN`)
      } else if (k === 'dpgauge') {
        P.push(`${d.link} ${d.a} ${d.b} 0.05 10 0.0015 0 CLOSED`)
      } else {
        const dia = n(p.diameter * 1000)
        const shut = off(nd.id)
        if (shut && p.valveType !== 'check' && p.valveType !== 'throttle') ST.push(`${d.link} CLOSED`)
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
            const K = valveK(p.opening * command(model, nd.id), p.kOpen)
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
