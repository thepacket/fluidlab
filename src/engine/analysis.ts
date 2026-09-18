// Derived analyses built on top of repeated solves.
import { G, pipeHeadloss, pumpHead, pumpMaxFlow } from '../model/physics'
import { isInline, type Fluid, type Model, type Props, type Results } from '../model/types'
import type { HydraulicEngine } from './epanet'

export interface XY {
  x: number
  y: number
}

/**
 * System curve seen by a pump. Every operating point lies on the system curve,
 * so sweeping the pump's speed traces it out — no matter how tangled the network.
 */
export function systemCurve(engine: HydraulicEngine, model: Model, pumpId: string): XY[] {
  const pts: XY[] = []
  for (let s = 0.15; s <= 1.8; s += 0.11) {
    const forced: Model = {
      ...model,
      controls: { ...model.controls, [pumpId]: true },
      nodes: model.nodes.map((n) => (n.id === pumpId ? { ...n, data: { ...n.data, props: { ...n.data.props, on: true } } } : n)),
    }
    const r = engine.solve(forced, { pumpSpeed: { [pumpId]: s } })
    const d = r.devices[pumpId]
    if (r.ok && d && d.flow > 1e-7) pts.push({ x: d.flow, y: d.dH })
  }
  return pts.sort((a, b) => a.x - b.x)
}

export function pumpCurve(props: Model['nodes'][0]['data']['props'], speed: number): XY[] {
  const qMax = pumpMaxFlow(props, speed)
  return Array.from({ length: 41 }, (_, i) => {
    const q = (qMax * i) / 40
    return { x: q, y: Math.max(0, pumpHead(q, props, speed)) }
  })
}

/** ΔP(Q) for a single pipe — pure Darcy–Weisbach, no solver needed. */
export function pipeCurve(props: Props, fluid: Fluid, qNow: number): XY[] {
  const qMax = Math.max(Math.abs(qNow) * 2, 0.0002)
  return Array.from({ length: 61 }, (_, i) => {
    const q = (qMax * i) / 60
    return { x: q, y: pipeHeadloss(q, props, fluid) * fluid.density * G }
  })
}

export interface ProfilePoint {
  dist: number
  head: number
  elevation: number
  label: string
  id: string
}

/** Walk downstream from the strongest source along the largest flows: the hydraulic grade line. */
export function gradeLine(model: Model, results: Results, throughId?: string): ProfilePoint[] {
  if (!results.ok) return []
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]))
  type Hop = { to: string; edgeId: string; flow: number; length: number }
  const out = new Map<string, Hop[]>()
  for (const e of model.edges) {
    const r = results.links[e.id]
    if (!r || !e.data || Math.abs(r.flow) < 1e-9) continue
    const [from, to] = r.flow > 0 ? [e.source, e.target] : [e.target, e.source]
    if (!out.has(from)) out.set(from, [])
    out.get(from)!.push({ to, edgeId: e.id, flow: Math.abs(r.flow), length: e.data.props.length })
  }
  const sources = model.nodes
    .filter((n) => (n.data.kind === 'reservoir' || n.data.kind === 'tank') && out.has(n.id))
    .sort((a, b) => (results.nodes[a.id]?.outflow ?? 0) - (results.nodes[b.id]?.outflow ?? 0))

  const walk = (start: string): ProfilePoint[] => {
    const pts: ProfilePoint[] = []
    const seen = new Set<string>()
    let cur = start
    let dist = 0
    while (!seen.has(cur)) {
      seen.add(cur)
      const n = nodeById.get(cur)
      if (!n) break
      if (isInline(n.data.kind)) {
        const d = results.devices[cur]
        if (!d) break
        const [h1, h2] = d.flow >= 0 ? [d.headIn, d.headOut] : [d.headOut, d.headIn]
        pts.push({ dist, head: h1, elevation: n.data.props.elevation, label: n.data.label, id: cur })
        pts.push({ dist, head: h2, elevation: n.data.props.elevation, label: '', id: cur })
      } else {
        const r = results.nodes[cur]
        if (!r) break
        pts.push({ dist, head: r.head, elevation: n.data.kind === 'reservoir' ? r.head : r.elevation, label: n.data.label, id: cur })
      }
      const hops = (out.get(cur) ?? []).sort((a, b) => b.flow - a.flow)
      const next = hops[0]
      if (!next) break
      dist += next.length
      cur = next.to
    }
    return pts
  }

  const paths = sources.map((s) => walk(s.id))
  const chosen = (throughId && paths.find((p) => p.some((pt) => pt.id === throughId))) || paths[0]
  return chosen ?? []
}
