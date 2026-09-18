// EPANET adapter, part 2: run the WebAssembly solver and lift raw results
// back into FluidLab's vocabulary (SI, element ids, educational extras).
import { LinkProperty, NodeProperty, Project, Workspace } from 'epanet-js'
import { lossDevice } from '../model/catalog'
import { G, P_ATM, area, fittingK, kvOf, ratedDp, elementInferredFlow, elementTapDp, frictionFactor, pumpEfficiency, pumpMaxFlow, regimeOf, reynolds, valveK } from '../model/physics'
import { EMPTY_RESULTS, isControl, type Model, type Results, type Warning } from '../model/types'
import { command, commandedOff, compile, type Overrides } from './inp'

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

  solve(model: Model, overrides: Overrides = {}): Results {
    const t0 = performance.now()
    if (!this.ws) return { ...EMPTY_RESULTS, error: 'Solver still loading' }
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
          const elevation = kind === 'reservoir' ? p.head : p.elevation
          const demand = project.getNodeValue(idx, NodeProperty.Demand) / 1000
          const pressure = kind === 'reservoir' ? 0 : (h - elevation) * rhoG
          const vented = kind === 'relief' ? flowOf(`${eid}v`) : 0
          res.nodes[nd.id] = { head: h, pressure, elevation, outflow: kind === 'relief' ? vented : demand }
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
              if (p.valveType === 'throttle') {
                dev.K = valveK(p.opening * command(model, nd.id), p.kOpen, p.trim)
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

      for (const e of model.edges) {
        if (!live.has(e.id) || !e.data) continue
        const p = e.data.props
        const q = flowOf(c.pipeIds[e.id])
        const hA = head(portId(c, e.source, e.sourceHandle))
        const hB = head(portId(c, e.target, e.targetHandle))
        const v = Math.abs(q) / area(p.diameter)
        const re = reynolds(v, p.diameter, fluid)
        const sign = q >= 0 ? 1 : -1
        const zA = elevationOf(model, e.source)
        const zB = elevationOf(model, e.target)
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
        if (v > 3) warnings.push({ id: e.id, level: 'info', text: `${e.data.label}: high velocity (${v.toFixed(1)} m/s) — noise and erosion territory` })
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
    res.solveMs = performance.now() - t0
    return res
  }
}

function portId(c: ReturnType<typeof compile>, nodeId: string, handle?: string | null) {
  if (c.nodeIds[nodeId]) return c.nodeIds[nodeId]
  const d = c.deviceIds[nodeId]
  return handle === 'out' ? d.b : d.a
}

function elevationOf(model: Model, id: string) {
  const nd = model.nodes.find((x) => x.id === id)
  if (!nd) return 0
  return nd.data.kind === 'reservoir' ? nd.data.props.head : nd.data.props.elevation
}

function cleanError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error\s*/i, '').trim() || 'The solver could not find a solution'
}

export const engine: HydraulicEngine = new EpanetEngine()
