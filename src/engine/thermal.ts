// Thermal layer for heating and cooling loops. Hydraulics first, heat second: once the flows are known, water
// temperature is carried along them — mixed at every junction, reset by a boiler, given up by emitters.
//
// An emitter (radiator, coil, exchanger) facing a room at constant temperature behaves like a heat exchanger with
// one side held still:  T_out = T_room + (T_in − T_room)·e^(−UA / ṁc).  UA comes from the datasheet output, quoted
// at a 50 K excess (the usual 75/65/20 °C rating). Starve a radiator of flow and it returns cold: that is what an
// unbalanced loop feels like.
import { lossDevice } from '../model/catalog'
import { pipeHeatLoss } from '../model/steam'
import { isControl, isInline, type Model, type ModelNode, type Props, type Results } from '../model/types'

export interface Thermal {
  /** °C at plain nodes */
  nodes: Record<string, number>
  /** °C either side of inline parts, and the heat they put into (+) or take out of (−) the water, W */
  devices: Record<string, { tIn: number; tOut: number; heat: number }>
  /** °C at the two ends of each pipe */
  links: Record<string, { tStart: number; tEnd: number; /** live mode: °C along the pipe, source → target */ cells?: number[] }>
  /** live mode: where the heat is going right now, W */
  balance?: { input: number; emitted: number; pipeLoss: number; tankLoss: number; stored: number }
  tMin: number
  tMax: number
}

export const CP = 4186 // J/kg·K
export const AMBIENT = 20 // °C round the pipework

/** Temperature a fixed-temperature source holds in the steady layer: a reservoir's supply, a tank's contents. */
export const sourceTemp = (n: ModelNode) => (n.data.kind === 'tank' ? (n.data.props.heaterPower > 0 ? (n.data.props.heaterSetpoint ?? 60) : (n.data.props.initTemp ?? 15)) : (n.data.props.temp ?? 15))
export const isBoiler = (n: ModelNode) => n.data.kind === 'fitting' && lossDevice(n.data.props.variant).id === 'boiler'
/** Is there anything on the bench that makes water temperature worth following? */
export const thermalActive = (model: Model) =>
  !model.fluid.gas &&
  model.nodes.some(
    (n) => isBoiler(n) || (n.data.kind === 'tank' && (n.data.props.heaterPower > 0 || (n.data.props.initTemp ?? 15) !== 15)) || (n.data.kind === 'reservoir' && (n.data.props.temp ?? 15) !== 15),
  )
/** W/K lost per metre of pipe; zero unless the pipe has been told what it is wrapped in. */
export const pipeUA = (p: Props) => (p.insulation === undefined || p.insulation === 'none' ? 0 : pipeHeatLoss(p, AMBIENT + 1, AMBIENT))

export interface Carrier {
  from: string
  to: string
  q: number
  /** inline part the water passes through … */
  through?: string
  /** … or the pipe it runs along, and whether it runs source → target */
  edge?: string
  forward?: boolean
}
/** The thermal network: temperature points (plain nodes, and the two ends of inline parts) and what carries water between them. */
export function thermalNetwork(model: Model, results: Results) {
  const points = new Set<string>()
  const fixed = new Map<string, ModelNode>()
  for (const n of model.nodes) {
    if (isControl(n.data.kind) || results.excluded.includes(n.id)) continue
    if (isInline(n.data.kind)) {
      if (!results.devices[n.id]) continue
      points.add(`${n.id}:in`)
      points.add(`${n.id}:out`)
    } else if (results.nodes[n.id]) {
      points.add(n.id)
      if (n.data.kind === 'reservoir' || n.data.kind === 'tank') fixed.set(n.id, n)
    }
  }
  const key = (id: string, handle?: string | null) => (points.has(id) ? id : `${id}:${handle === 'out' ? 'out' : 'in'}`)
  const carriers: Carrier[] = []
  for (const e of model.edges) {
    const r = results.links[e.id]
    if (!r || e.type === 'signal' || results.channel?.reaches[e.id]) continue
    const a = key(e.source, e.sourceHandle)
    const b = key(e.target, e.targetHandle)
    if (!points.has(a) || !points.has(b)) continue
    const q = Math.abs(r.flow) < 1e-9 ? 0 : r.flow
    carriers.push(q >= 0 ? { from: a, to: b, q, edge: e.id, forward: true } : { from: b, to: a, q: -q, edge: e.id, forward: false })
  }
  for (const n of model.nodes) {
    const d = results.devices[n.id]
    if (!d) continue
    const q = Math.abs(d.flow) < 1e-9 ? 0 : d.flow
    const [from, to] = q >= 0 ? [`${n.id}:in`, `${n.id}:out`] : [`${n.id}:out`, `${n.id}:in`]
    carriers.push({ from, to, q: Math.abs(q), through: n.id })
  }
  return { points, fixed, key, carriers }
}

/** Steady outlet temperature of an inline part for water arriving at tIn. */
export function deviceOutlet(n: ModelNode, tIn: number, q: number, rhoCp: number): number {
  if (n.data.kind !== 'fitting') return tIn
  const p = n.data.props
  if (isBoiler(n)) {
    const set = p.supplyTemp ?? 70
    // a boiler with a rated output can only lift the water so far; a chiller only cool it so far
    return p.ratedHeat > 0 && q > 0 ? tIn + Math.max(-p.ratedHeat / (q * rhoCp), Math.min(p.ratedHeat / (q * rhoCp), set - tIn)) : set
  }
  if (!(p.ratedHeat > 0)) return tIn
  const room = p.roomTemp ?? 20
  return q > 0 ? room + (tIn - room) * Math.exp(-(p.ratedHeat / 50) / (q * rhoCp)) : room
}

export function solveThermal(model: Model, results: Results): Thermal | undefined {
  if (!results.ok || !thermalActive(model)) return undefined
  const rhoCp = model.fluid.density * CP
  const net = thermalNetwork(model, results)
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const edgeProps = new Map(model.edges.map((e) => [e.id, e.data?.props]))

  const T = new Map<string, number>()
  for (const k of net.points) T.set(k, 40)
  for (const [k, n] of net.fixed) T.set(k, sourceTemp(n))
  const carriers = net.carriers.filter((c) => c.q > 0)
  const outletOf = (c: Carrier, tIn: number): number => {
    if (c.through) return deviceOutlet(byId.get(c.through)!, tIn, c.q, rhoCp)
    const p = edgeProps.get(c.edge!)
    const ua = p ? pipeUA(p) * p.length : 0
    return ua > 0 ? AMBIENT + (tIn - AMBIENT) * Math.exp(-ua / (c.q * rhoCp)) : tIn
  }

  // Gauss–Seidel round the loop: each point takes the flow-weighted mix of what arrives
  const inflows = new Map<string, Carrier[]>()
  for (const c of carriers) inflows.set(c.to, [...(inflows.get(c.to) ?? []), c])
  for (let sweep = 0; sweep < 200; sweep++) {
    let change = 0
    for (const [k, list] of inflows) {
      if (net.fixed.has(k)) continue
      let sum = 0
      let q = 0
      for (const c of list) {
        sum += c.q * outletOf(c, T.get(c.from)!)
        q += c.q
      }
      const t = sum / q
      change = Math.max(change, Math.abs(t - T.get(k)!))
      T.set(k, t)
    }
    if (change < 1e-4) break
  }
  return thermalView(model, results, (k) => T.get(k), rhoCp)
}

/** Package point temperatures the way the UI reads them. */
export function thermalView(model: Model, results: Results, at: (key: string) => number | undefined, rhoCp: number, cells?: Record<string, number[]>): Thermal {
  const net = thermalNetwork(model, results)
  const out: Thermal = { nodes: {}, devices: {}, links: {}, tMin: Infinity, tMax: -Infinity }
  const seen = (t: number) => ((out.tMin = Math.min(out.tMin, t)), (out.tMax = Math.max(out.tMax, t)))
  for (const k of net.points) {
    const t = at(k)
    if (t === undefined) continue
    if (!k.includes(':')) out.nodes[k] = t
    seen(t)
  }
  for (const n of model.nodes) {
    const d = results.devices[n.id]
    if (!d) continue
    const [a, b] = d.flow >= 0 ? [`${n.id}:in`, `${n.id}:out`] : [`${n.id}:out`, `${n.id}:in`]
    const tIn = at(a)
    const tOut = at(b)
    if (tIn !== undefined && tOut !== undefined) out.devices[n.id] = { tIn, tOut, heat: Math.abs(d.flow) * rhoCp * (tOut - tIn) }
  }
  for (const e of model.edges) {
    if (!results.links[e.id] || e.type === 'signal') continue
    const a = at(net.key(e.source, e.sourceHandle))
    const b = at(net.key(e.target, e.targetHandle))
    if (a === undefined || b === undefined) continue
    const c = cells?.[e.id]
    out.links[e.id] = c ? { tStart: c[0], tEnd: c[c.length - 1], cells: c } : { tStart: a, tEnd: b }
    c?.forEach(seen)
  }
  if (!isFinite(out.tMin)) [out.tMin, out.tMax] = [AMBIENT, AMBIENT + 1]
  if (out.tMax - out.tMin < 1) out.tMax = out.tMin + 1
  return out
}
