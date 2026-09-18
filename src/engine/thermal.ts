// Thermal layer for heating and cooling loops. Hydraulics first, heat second: once the flows are known, water
// temperature is carried along them — mixed at every junction, reset by a boiler, given up by emitters.
//
// An emitter (radiator, coil, exchanger) facing a room at constant temperature behaves like a heat exchanger with
// one side held still:  T_out = T_room + (T_in − T_room)·e^(−UA / ṁc).  UA comes from the datasheet output, quoted
// at a 50 K excess (the usual 75/65/20 °C rating). Starve a radiator of flow and it returns cold: that is what an
// unbalanced loop feels like.
import { lossDevice } from '../model/catalog'
import { isControl, isInline, type Model, type Results } from '../model/types'

export interface Thermal {
  /** °C at plain nodes */
  nodes: Record<string, number>
  /** °C either side of inline parts, and the heat they put into (+) or take out of (−) the water, W */
  devices: Record<string, { tIn: number; tOut: number; heat: number }>
  /** °C at the two ends of each pipe */
  links: Record<string, { tStart: number; tEnd: number }>
  tMin: number
  tMax: number
}

const CP = 4186 // J/kg·K
const MAKE_UP = 15 // °C, anything arriving from a reservoir or tank

export function solveThermal(model: Model, results: Results): Thermal | undefined {
  const heaters = model.nodes.filter((n) => n.data.kind === 'fitting' && lossDevice(n.data.props.variant).id === 'boiler' && results.devices[n.id])
  if (!results.ok || !heaters.length) return undefined
  const rhoCp = model.fluid.density * CP

  // temperatures live on the same hydraulic points the solver uses
  const T = new Map<string, number>()
  const fixed = new Set<string>()
  for (const n of model.nodes) {
    if (isControl(n.data.kind) || results.excluded.includes(n.id)) continue
    if (isInline(n.data.kind)) {
      if (!results.devices[n.id]) continue
      T.set(`${n.id}:in`, 40)
      T.set(`${n.id}:out`, 40)
    } else if (results.nodes[n.id]) {
      T.set(n.id, 40)
      if (n.data.kind === 'reservoir' || n.data.kind === 'tank') {
        T.set(n.id, MAKE_UP)
        fixed.add(n.id)
      }
    }
  }
  const key = (id: string, handle?: string | null) => (T.has(id) ? id : `${id}:${handle === 'out' ? 'out' : 'in'}`)

  // every carrier of water: pipes as they are, inline parts from inlet to outlet
  type Carrier = { from: string; to: string; q: number; through?: string }
  const carriers: Carrier[] = []
  for (const e of model.edges) {
    const r = results.links[e.id]
    if (!r || Math.abs(r.flow) < 1e-9) continue
    const a = key(e.source, e.sourceHandle)
    const b = key(e.target, e.targetHandle)
    if (T.has(a) && T.has(b)) carriers.push(r.flow > 0 ? { from: a, to: b, q: r.flow } : { from: b, to: a, q: -r.flow })
  }
  for (const n of model.nodes) {
    const d = results.devices[n.id]
    if (!d || Math.abs(d.flow) < 1e-9) continue
    const [from, to] = d.flow > 0 ? [`${n.id}:in`, `${n.id}:out`] : [`${n.id}:out`, `${n.id}:in`]
    carriers.push({ from, to, q: Math.abs(d.flow), through: n.id })
  }
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const outletOf = (c: Carrier, tIn: number): number => {
    if (!c.through) return tIn
    const p = byId.get(c.through)!.data.props
    if (byId.get(c.through)!.data.kind !== 'fitting') return tIn
    if (lossDevice(p.variant).id === 'boiler') return p.supplyTemp ?? 70
    if (!(p.ratedHeat > 0)) return tIn
    const room = p.roomTemp ?? 20
    return room + (tIn - room) * Math.exp(-(p.ratedHeat / 50) / (c.q * rhoCp))
  }

  // Gauss–Seidel round the loop: each point takes the flow-weighted mix of what arrives
  const inflows = new Map<string, Carrier[]>()
  for (const c of carriers) inflows.set(c.to, [...(inflows.get(c.to) ?? []), c])
  for (let sweep = 0; sweep < 200; sweep++) {
    let change = 0
    for (const [k, list] of inflows) {
      if (fixed.has(k)) continue
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

  const out: Thermal = { nodes: {}, devices: {}, links: {}, tMin: Infinity, tMax: -Infinity }
  for (const [k, t] of T) {
    if (!k.includes(':')) out.nodes[k] = t
    out.tMin = Math.min(out.tMin, t)
    out.tMax = Math.max(out.tMax, t)
  }
  for (const n of model.nodes) {
    const d = results.devices[n.id]
    if (!d) continue
    const [a, b] = d.flow >= 0 ? [`${n.id}:in`, `${n.id}:out`] : [`${n.id}:out`, `${n.id}:in`]
    const tIn = T.get(a)!
    const tOut = T.get(b)!
    out.devices[n.id] = { tIn, tOut, heat: Math.abs(d.flow) * rhoCp * (tOut - tIn) }
  }
  for (const e of model.edges) {
    if (!results.links[e.id]) continue
    const a = T.get(key(e.source, e.sourceHandle))
    const b = T.get(key(e.target, e.targetHandle))
    if (a !== undefined && b !== undefined) out.links[e.id] = { tStart: a, tEnd: b }
  }
  if (out.tMax - out.tMin < 1) out.tMax = out.tMin + 1
  return out
}
