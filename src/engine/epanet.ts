// EPANET adapter, part 2: run the WebAssembly solver and lift raw results
// back into FluidLab's vocabulary (SI, element ids, educational extras).
import { LinkProperty, NodeProperty, Project, Workspace } from 'epanet-js'
import { lossDevice } from '../model/catalog'
import {
  G,
  P_ATM,
  jetMotiveFlow,
  jetN,
  area,
  sourceElevation,
  tankHeight,
  fittingK,
  kvOf,
  ratedDp,
  elementInferredFlow,
  elementTapDp,
  frictionFactor,
  pumpEfficiency,
  pumpMaxFlow,
  regimeOf,
  reynolds,
  valveK,
} from '../model/physics'
import { EMPTY_RESULTS, isControl, type Model, type Results, type Warning } from '../model/types'
import { solveGas } from './gas'
import { solveChannel } from './channel'
import { stripChannels } from '../model/openchannel'
import { solveThermal } from './thermal'
import { command, commandedOff, compile, floatTank, valvePosition, type JetState, type Overrides } from './inp'

/** Any solver FluidLab can plug in (EPANET today; water-hammer / gas later). */
export interface HydraulicEngine {
  name: string
  ready(): Promise<void>
  solve(model: Model, overrides?: Overrides): Results
}

class EpanetEngine implements HydraulicEngine {
  name = 'EPANET 2.2 · WebAssembly'
  private ws: Workspace | null = null
  private loading: Promise<void> | null = null

  ready() {
    if (!this.loading) {
      const ws = new Workspace()
      this.loading = ws.loadModule().then(() => {
        this.ws = ws
      })
    }
    return this.loading
  }

  /**
   * A jet pump's two links depend on heads elsewhere in the network (the nozzle sees motive − suction, the
   * entrainment curve scales with motive − discharge), which no single EPANET element can express. So: solve,
   * read those heads, update both links, solve again — a relaxed fixed point that settles in a handful of passes.
   */
  private convergeJets(model: Model, overrides: Overrides): Record<string, JetState> {
    const jets = model.nodes.filter((nd) => nd.data.kind === 'jetpump')
    const state: Record<string, JetState> = Object.fromEntries(jets.map((j) => [j.id, { q1: jetMotiveFlow(j.data.props, 30), dHmd: 20 }]))
    for (let pass = 0; pass < 30; pass++) {
      const c = compile(model, { ...overrides, jets: state })
      if (c.empty) break
      const project = new Project(this.ws!)
      let change = 0
      try {
        this.ws!.writeFile('jet.inp', c.inp)
        project.open('jet.inp', 'jet.rpt', 'jet.bin')
        project.solveH()
        const head = (id: string) => project.getNodeValue(project.getNodeIndex(id), NodeProperty.Head)
        for (const j of jets) {
          const ports = c.subPorts[j.id]
          if (c.excluded.includes(j.id) || !ports?.m) continue
          const Hm = head(ports.m)
          const Hd = head(c.nodeIds[j.id])
          const Hs = ports.s ? head(ports.s) : Hd
          const target = { q1: jetMotiveFlow(j.data.props, Hm - Hs), dHmd: Math.max(0.01, Hm - Hd) }
          const cur = state[j.id]
          change = Math.max(change, Math.abs(target.q1 - cur.q1) / Math.max(1e-9, target.q1), Math.abs(target.dHmd - cur.dHmd) / Math.max(0.01, target.dHmd))
          state[j.id] = { q1: cur.q1 + 0.6 * (target.q1 - cur.q1), dHmd: cur.dHmd + 0.6 * (target.dHmd - cur.dHmd) }
        }
      } catch {
        break
      } finally {
        try {
          project.close()
        } catch {
          /* already closed */
        }
      }
      if (change < 2e-3) break
    }
    return state
  }

  solve(full: Model, overrides: Overrides = {}): Results {
    const open = solveChannel(full)
    if (!open) return this.solvePressurised(full, overrides)
    // open channels and pipework share a bench but not (yet) any water: solve each, then lay one over the other
    const model = stripChannels(full)
    const piped = model.edges.some((e) => e.type !== 'signal')
    const press = piped ? this.solvePressurised(model, overrides) : { ...EMPTY_RESULTS, ok: true }
    return {
      ...press,
      ok: open.ok || (piped && press.ok),
      error: open.error ?? (piped ? press.error : undefined),
      warnings: [...open.warnings, ...press.warnings],
      nodes: { ...press.nodes, ...open.nodes },
      links: { ...press.links, ...open.links },
      excluded: [...press.excluded, ...open.excluded],
      channel: open.channel,
      solveMs: press.solveMs + open.solveMs,
      pMin: Math.min(press.pMin, open.pMin),
      pMax: piped && press.ok ? Math.max(press.pMax, open.pMax) : open.pMax,
      vMax: piped && press.ok ? Math.max(press.vMax, open.vMax) : open.vMax,
    }
  }

  private solvePressurised(model: Model, overrides: Overrides = {}): Results {
    if (model.fluid.gas) return solveGas(model, overrides) // a different physics altogether: see engine/gas.ts
    const t0 = performance.now()
    if (!this.ws) return { ...EMPTY_RESULTS, error: 'Solver still loading' }
    if (model.nodes.some((nd) => nd.data.kind === 'jetpump')) overrides = { ...overrides, jets: this.convergeJets(model, overrides) }
    const c = compile(model, overrides)
    const warnings: Warning[] = [...c.warnings]
    if (c.empty) {
      return {
        ...EMPTY_RESULTS,
        excluded: c.excluded,
        error: model.nodes.length ? 'Connect a reservoir or tank to something with a pipe' : undefined,
      }
    }

    const project = new Project(this.ws)
    const res: Results = { ...EMPTY_RESULTS, ok: true, warnings, nodes: {}, links: {}, devices: {}, excluded: c.excluded }
    try {
      this.ws.writeFile('net.inp', c.inp)
      project.open('net.inp', 'net.rpt', 'net.bin')
      project.solveH()

      const { fluid } = model
      const rhoG = fluid.density * G
      const head = (id: string) => project.getNodeValue(project.getNodeIndex(id), NodeProperty.Head)
      // below a nanolitre-ish per second is solver noise (dead legs, sensing lines): call it still
      const flowOf = (id: string) => {
        const q = project.getLinkValue(project.getLinkIndex(id), LinkProperty.Flow) / 1000
        return Math.abs(q) < 1e-9 ? 0 : q
      }
      const live = new Set(Object.keys(c.pipeIds))
      const excluded = new Set(c.excluded)

      for (const nd of model.nodes) {
        if (excluded.has(nd.id) || isControl(nd.data.kind)) continue
        const p = nd.data.props
        const kind = nd.data.kind
        if (c.nodeIds[nd.id]) {
          const eid = c.nodeIds[nd.id]
          const idx = project.getNodeIndex(eid)
          const h = project.getNodeValue(idx, NodeProperty.Head)
          const elevation = kind === 'reservoir' ? sourceElevation(p, h) : p.elevation
          const rawDemand = project.getNodeValue(idx, NodeProperty.Demand) / 1000
          const demand = Math.abs(rawDemand) < 1e-7 ? 0 : rawDemand // residual seepage through "closed" links is solver noise
          const pressure = (h - elevation) * rhoG
          if (kind === 'jetpump') {
            const ports = c.subPorts[nd.id] ?? {}
            const q1 = ports.m ? flowOf(`${ports.m}s`) : 0
            const q2 = ports.s ? flowOf(`${ports.s}s`) : 0
            const hm = ports.m ? head(ports.m) : h
            const hs = ports.s ? head(ports.s) : h
            const M = q1 > 1e-9 ? q2 / q1 : 0
            res.nodes[nd.id] = {
              head: h,
              pressure,
              elevation,
              outflow: 0,
              extra: { q1, q2, M, N: hm - h > 1e-6 ? (h - hs) / (hm - h) : 0, Nmodel: jetN(M, p), pMotive: (hm - elevation) * rhoG, pSuction: (hs - elevation) * rhoG },
            }
            if ((hs - elevation) * rhoG + P_ATM < fluid.vaporPressure * 1.5)
              warnings.push({ id: nd.id, level: 'error', text: `${nd.data.label}: suction chamber is at vapour pressure — the jet is cavitating` })
            else if (ports.m && q1 > 1e-8 && q2 < 1e-8)
              warnings.push({ id: nd.id, level: 'warn', text: `${nd.data.label}: motive jet running but nothing is entrained — the discharge head is too high for this area ratio` })
            continue
          }
          if (kind === 'threeway') {
            const leg = (h: string) => (c.subPorts[nd.id]?.[h] ? flowOf(`${c.subPorts[nd.id][h]}s`) : 0)
            res.nodes[nd.id] = { head: h, pressure, elevation, outflow: 0, extra: { flowA: leg('a'), flowB: leg('b') } }
            continue
          }
          if (kind === 'airvalve' && pressure < -500 && p.mode !== 'release')
            warnings.push({ id: nd.id, level: 'info', text: `${nd.data.label}: line is below atmospheric here — this valve would be admitting air` })
          const vented = kind === 'relief' ? flowOf(`${eid}v`) : 0
          if (kind === 'tank' && p.overflow && demand > 1e-7 && (model.levels?.[nd.id] ?? p.initLevel) >= tankHeight(p) - 1e-6)
            warnings.push({ id: nd.id, level: 'warn', text: `${nd.data.label}: overflowing — spilling ${(demand * 60000).toFixed(0)} L/min` })
          // a vessel's "outflow" follows the tank convention: positive = filling
          res.nodes[nd.id] = {
            head: h,
            pressure,
            elevation,
            outflow: kind === 'relief' ? vented : kind === 'vessel' ? flowOf(`${eid}s`) : kind === 'reservoir' && p.sourceType === 'well' ? -flowOf(`${eid}w`) : demand,
          }
          if (vented > 1e-8)
            warnings.push({ id: nd.id, level: 'warn', text: `${nd.data.label}: lifting — venting ${(vented * 60000).toFixed(0)} L/min to hold ${(p.setPressure / 1000).toFixed(0)} kPa` })
          if (kind !== 'reservoir' && kind !== 'tank' && pressure + P_ATM < fluid.vaporPressure)
            warnings.push({ id: nd.id, level: 'error', text: `${nd.data.label}: pressure below vapour pressure — the liquid would boil` })
          else if (kind !== 'reservoir' && kind !== 'tank' && pressure < -1000) warnings.push({ id: nd.id, level: 'warn', text: `${nd.data.label}: sub-atmospheric pressure` })
        } else {
          const d = c.deviceIds[nd.id]
          const hIn = head(d.a)
          const hOut = head(d.b)
          const q = flowOf(d.link)
          const pIn = (hIn - p.elevation) * rhoG
          const pOut = (hOut - p.elevation) * rhoG
          const dev: Results['devices'][string] = { flow: q, headIn: hIn, headOut: hOut, pIn, pOut, dH: hOut - hIn, status: 'open' }
          if (kind === 'pump') {
            const speed = p.speed * command(model, nd.id) // a controller trims the drive's own speed setting
            const running = p.on && speed >= 0.01
            dev.status = running ? 'open' : 'closed'
            if (running) {
              dev.efficiency = pumpEfficiency(q, p, speed)
              dev.hydraulicPower = rhoG * q * Math.max(0, dev.dH)
              dev.shaftPower = dev.hydraulicPower / dev.efficiency
              dev.npsha = (pIn + P_ATM - fluid.vaporPressure) / rhoG
              if (q > 1e-7 && dev.npsha < p.npshr) warnings.push({ id: nd.id, level: 'error', text: `${nd.data.label}: cavitation risk — NPSHa ${dev.npsha.toFixed(1)} m < NPSHr ${p.npshr} m` })
              if (q >= pumpMaxFlow(p, speed) * 0.98) warnings.push({ id: nd.id, level: 'warn', text: `${nd.data.label}: running off the end of its curve` })
              else if (q < 1e-7) warnings.push({ id: nd.id, level: 'warn', text: `${nd.data.label}: dead-headed — no flow` })
            } else dev.dH = 0
          } else if (kind === 'dpgauge') {
            dev.flow = 0
          } else if (kind === 'fitting') {
            const spec = lossDevice(p.variant)
            if (spec.model === 'k') {
              const { bore, K } = fittingK(p, spec.byDiameters)
              dev.K = K
              dev.velocity = Math.abs(q) / area(bore)
            } else {
              dev.velocity = Math.abs(q) / area(p.diameter)
              dev.ratedShare = Math.abs(q) / Math.max(1e-9, p.ratedFlow)
              if (dev.ratedShare > 4) warnings.push({ id: nd.id, level: 'warn', text: `${nd.data.label}: far beyond its rated flow — the Δp curve is being extrapolated` })
              else if ((p.fouling ?? 0) >= 0.6 && Math.abs(q) > 1e-8)
                warnings.push({ id: nd.id, level: 'info', text: `${nd.data.label}: heavily fouled (Δp ${(ratedDp(q, p) / 1000).toFixed(0)} kPa) — due for cleaning` })
            }
          } else {
            dev.velocity = Math.abs(q) / area(p.diameter)
            if (kind === 'element') {
              dev.tapDp = elementTapDp(q, p, fluid)
              dev.permanentLoss = Math.abs(pIn - pOut)
              dev.throatVelocity = Math.abs(q) / area(Math.min(p.throat, p.diameter))
              dev.inferredFlow = elementInferredFlow(dev.tapDp, p, fluid)
              const pThroat = Math.min(pIn, pOut) + dev.permanentLoss - dev.tapDp
              if (pThroat + P_ATM < fluid.vaporPressure) warnings.push({ id: nd.id, level: 'error', text: `${nd.data.label}: throat pressure below vapour pressure — it would cavitate` })
            }
            if (kind === 'valve' && p.valveType !== 'throttle' && commandedOff(model, nd.id)) dev.status = 'closed'
            else if (kind === 'valve') {
              if (p.valveType === 'throttle' || p.valveType === 'float') {
                dev.position = valvePosition(model, nd.id)
                dev.K = valveK(dev.position, p.kOpen, p.trim)
                if (p.valveType === 'float' && !floatTank(model, nd.id)) warnings.push({ id: nd.id, level: 'warn', text: `${nd.data.label}: a float valve needs a tank piped to its outlet` })
                dev.kv = kvOf(dev.K, p.diameter)
                dev.status = isFinite(dev.K) ? 'open' : 'closed'
              } else if (p.valveType === 'check') dev.status = q > 1e-9 ? 'open' : 'closed'
              else {
                const s = project.getLinkValue(project.getLinkIndex(d.link), LinkProperty.Status)
                const setting = Math.abs(hIn - hOut) > 1e-4 && Math.abs(q) > 1e-9
                dev.status = s === 0 ? 'closed' : setting ? 'active' : 'open'
              }
            }
          }
          res.devices[nd.id] = dev
        }
      }

      const fast: { id: string; label: string; v: number }[] = []
      for (const e of model.edges) {
        if (!live.has(e.id) || !e.data) continue
        const p = e.data.props
        const q = flowOf(c.pipeIds[e.id])
        const hA = head(portId(c, e.source, e.sourceHandle))
        const hB = head(portId(c, e.target, e.targetHandle))
        const v = Math.abs(q) / area(p.diameter)
        const re = reynolds(v, p.diameter, fluid)
        const sign = q >= 0 ? 1 : -1
        // plain nodes already know the elevation their pressure is quoted at (a free surface: its own head)
        const zA = res.nodes[e.source]?.elevation ?? elevationOf(model, e.source)
        const zB = res.nodes[e.target]?.elevation ?? elevationOf(model, e.target)
        res.links[e.id] = {
          flow: q,
          velocity: v,
          headloss: (hA - hB) * sign,
          dp: ((hA - zA) * rhoG - (hB - zB) * rhoG) * sign,
          re,
          f: frictionFactor(re, p.roughness / p.diameter),
          regime: regimeOf(re),
          pStart: (hA - zA) * rhoG,
          pEnd: (hB - zB) * rhoG,
        }
        if (v > 3) fast.push({ id: e.id, label: e.data.label, v })
      }

      if (fast.length) {
        // one note for the lot — a sprinkler branch can have a dozen fast pipes
        const worst = fast.reduce((m, x) => (x.v > m.v ? x : m))
        warnings.push({
          id: worst.id,
          level: 'info',
          text: `${fast.length > 1 ? `${fast.length} pipes run above 3 m/s; fastest is ${worst.label}` : `${worst.label}: high velocity`} (${worst.v.toFixed(1)} m/s) — noise and erosion territory`,
        })
      }
      const ps = [...Object.values(res.nodes).map((x) => x.pressure), ...Object.values(res.devices).flatMap((x) => [x.pIn, x.pOut])]
      res.pMin = Math.min(0, ...ps)
      res.pMax = Math.max(1000, ...ps)
      res.vMax = Math.max(0.5, ...Object.values(res.links).map((x) => x.velocity))
      if (c.excluded.length) warnings.push({ level: 'info', text: 'Greyed-out parts are not connected to a reservoir or tank' })
    } catch (err) {
      res.ok = false
      res.error = cleanError(err)
    } finally {
      try {
        project.close()
      } catch {
        /* already closed */
      }
    }
    if (res.ok) res.thermal = solveThermal(model, res)
    res.solveMs = performance.now() - t0
    return res
  }
}

function portId(c: ReturnType<typeof compile>, nodeId: string, handle?: string | null) {
  if (handle && c.subPorts[nodeId]?.[handle]) return c.subPorts[nodeId][handle]
  if (c.nodeIds[nodeId]) return c.nodeIds[nodeId]
  const d = c.deviceIds[nodeId]
  return handle === 'out' ? d.b : d.a
}

function elevationOf(model: Model, id: string) {
  const nd = model.nodes.find((x) => x.id === id)
  if (!nd) return 0
  return nd.data.props.elevation ?? 0
}

function cleanError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error\s*/i, '').trim() || 'The solver could not find a solution'
}

export const engine: HydraulicEngine = new EpanetEngine()
