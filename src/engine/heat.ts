// Transient heat transfer: the thermal layer marched through lab time.
//
// The steady layer (thermal.ts) says where temperatures end up; this one says how they get there. The hydraulics stay
// quasi-steady — flows come from the last solve — and heat rides on them:
//   · every pipe is a row of cells; water (and the pipe wall it has to warm) is advected cell to cell, upwind and
//     implicit, so any time step is stable; lagged or bare pipes leak heat to the room along the way
//   · junctions mix what arrives; a stagnant point remembers its temperature
//   · a tank is one stirred volume, with an optional immersion heater on a thermostat and a standing loss
//   · boilers and emitters have a thermal mass, so they answer with a lag instead of instantly
// What this buys: warm-up and cool-down curves, the wait for hot water at the end of a dead leg, a cylinder
// recovering after a bath, and thermostats that have something real to control.
import { area, tankVolume } from '../model/physics'
import type { Model, ModelNode, Props, Results } from '../model/types'
import { AMBIENT, CP, deviceOutlet, isBoiler, pipeUA, sourceTemp, thermalActive, thermalNetwork, thermalView, type Carrier, type Thermal } from './thermal'

export interface HeatState {
  /** °C along each pipe, source → target */
  cells: Record<string, number[]>
  /** °C at mixing points */
  points: Record<string, number>
  /** °C of each tank's contents */
  tanks: Record<string, number>
  /** °C leaving each inline part with thermal mass */
  devices: Record<string, number>
  /** stratified tanks: °C of each layer, bottom first */
  layers: Record<string, number[]>
  balance: NonNullable<Thermal['balance']>
}

export const emptyHeat = (): HeatState => ({ cells: {}, points: {}, tanks: {}, devices: {}, layers: {}, balance: { input: 0, emitted: 0, pipeLoss: 0, tankLoss: 0, stored: 0 } })

/** A stratified tank is this many stirred layers, stacked. */
export const LAYERS = 10

/** Pipes are cut into cells about this long; short enough to show a front, long enough to stay cheap. */
const CELL = 1.5
export const cellCount = (length: number) => Math.min(40, Math.max(2, Math.ceil(length / CELL)))

/** Heat capacity of the pipe wall per metre, J/m·K — cold metal takes its share before the far end gets warm. */
function wallCapacity(p: Props): number {
  const t = Math.max(0.0015, 0.06 * p.diameter)
  const rhoC = p.material === 'copper' ? 3.4e6 : p.material === 'pvc' || p.material === 'pex' || p.material === 'hose' ? 1.8e6 : 3.6e6
  return Math.PI * (p.diameter + t) * t * rhoC
}
/** Thermal mass of a boiler or emitter, J/K: its water content plus its metal, scaled from the rated output. */
function deviceCapacity(n: ModelNode): number {
  const p = n.data.props
  if (n.data.kind !== 'fitting') return 0
  if (isBoiler(n)) return (p.waterContent ?? 0.012) * 1000 * CP + 40 * 460 // a small boiler: 12 L and 40 kg of steel
  return p.ratedHeat > 0 ? (p.ratedHeat / 1000) * 34e3 : 0 // panel radiator: ~6 L of water and ~20 kg of steel per kW
}

/** Advance the temperatures by dt seconds of lab time on the flows in `results`. Pure: returns a new state. */
export function stepHeat(model: Model, results: Results, prev: HeatState | null, dt: number): HeatState | null {
  if (!results.ok || !thermalActive(model)) return null
  const rhoCp = model.fluid.density * CP
  const net = thermalNetwork(model, results)
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const edges = new Map(model.edges.map((e) => [e.id, e]))
  const old = prev ?? emptyHeat()
  const st: HeatState = { cells: {}, points: {}, tanks: {}, devices: {}, layers: {}, balance: { input: 0, emitted: 0, pipeLoss: 0, tankLoss: 0, stored: 0 } }

  // ---- carry the old state over; anything new starts at room temperature (pipes) or its own initial value ----
  for (const c of net.carriers) {
    if (c.edge) {
      const n = cellCount(edges.get(c.edge)!.data!.props.length)
      const had = old.cells[c.edge]
      st.cells[c.edge] = had && had.length === n ? [...had] : new Array(n).fill(AMBIENT)
    } else if (c.through && deviceCapacity(byId.get(c.through)!) > 0) st.devices[c.through] = old.devices[c.through] ?? AMBIENT
  }
  for (const [k, n] of net.fixed)
    if (n.data.kind === 'tank' && n.data.props.stratified) st.layers[k] = old.layers[k]?.length === LAYERS ? [...old.layers[k]] : new Array(LAYERS).fill(old.tanks[k] ?? n.data.props.initTemp ?? 15)
  for (const [k, n] of net.fixed) st.tanks[k] = n.data.kind === 'tank' ? (old.tanks[k] ?? n.data.props.initTemp ?? 15) : sourceTemp(n)
  for (const k of net.points) st.points[k] = net.fixed.has(k) ? st.tanks[k] : (old.points[k] ?? AMBIENT)
  if (dt <= 0) return st

  // ---- sub-steps: keep the Courant number of the fastest cell near one so fronts stay reasonably sharp ----
  let courant = 0
  for (const c of net.carriers)
    if (c.edge && c.q > 0) {
      const p = edges.get(c.edge)!.data!.props
      courant = Math.max(courant, (c.q * dt) / ((area(p.diameter) * p.length) / st.cells[c.edge].length))
    }
  const steps = Math.min(40, Math.max(1, Math.ceil(courant)))
  const h = dt / steps
  const inflows = new Map<string, Carrier[]>()
  for (const c of net.carriers) if (c.q > 0) inflows.set(c.to, [...(inflows.get(c.to) ?? []), c])
  const bal = st.balance
  // water leaving a stratified tank comes from the layer its port sits in: the top connection draws the hottest water
  const leaving = (c: Carrier) => (st.layers[c.from] ? st.layers[c.from][c.fromHandle === 't' ? LAYERS - 1 : 0] : st.points[c.from])

  for (let s = 0; s < steps; s++) {
    // 1. what each carrier delivers at its downstream end right now
    const delivered = new Map<Carrier, number>()
    for (const c of net.carriers) {
      if (c.edge) {
        const cells = st.cells[c.edge]
        delivered.set(c, c.forward ? cells[cells.length - 1] : cells[0])
      } else delivered.set(c, st.devices[c.through!] ?? deviceOutlet(byId.get(c.through!)!, st.points[c.from], c.q, rhoCp))
    }
    // 2. pipes: implicit upwind, cell by cell in the direction of flow, with the wall's mass and the loss to the room
    for (const c of net.carriers) {
      if (!c.edge) continue
      const p = edges.get(c.edge)!.data!.props
      const cells = st.cells[c.edge]
      const dx = p.length / cells.length
      const cap = rhoCp * area(p.diameter) * dx + wallCapacity(p) * dx
      const a = (c.q * rhoCp * h) / cap
      const b = (pipeUA(p) * dx * h) / cap
      let upstream = leaving(c)
      for (let i = 0; i < cells.length; i++) {
        const j = c.forward ? i : cells.length - 1 - i
        cells[j] = (cells[j] + a * upstream + b * AMBIENT) / (1 + a + b)
        bal.pipeLoss += (pipeUA(p) * dx * (cells[j] - AMBIENT)) / steps
        upstream = cells[j]
      }
    }
    // 3. inline parts with thermal mass relax towards their steady outlet temperature
    for (const c of net.carriers) {
      if (!c.through) continue
      const n = byId.get(c.through)!
      const tIn = leaving(c)
      const target = deviceOutlet(n, tIn, c.q, rhoCp)
      const cap = deviceCapacity(n)
      const before = st.devices[c.through]
      if (cap > 0) {
        const ua = isBoiler(n) ? 0 : (n.data.props.ratedHeat ?? 0) / 50
        const rate = (c.q * rhoCp + ua) / cap
        st.devices[c.through] = target + (st.devices[c.through] - target) * Math.exp(-rate * h)
      }
      const tOut = st.devices[c.through] ?? target
      const duty = c.q * rhoCp * (tOut - tIn)
      // what an emitter takes from the water first warms its own metal; only the rest reaches the room
      const soaking = cap > 0 && !isBoiler(n) ? (cap * (st.devices[c.through] - before)) / h : 0
      if (isBoiler(n)) bal.input += duty / steps
      else if (n.data.kind === 'fitting' && n.data.props.ratedHeat > 0) bal.emitted += (-duty - soaking) / steps
    }
    // 4. tanks: one stirred volume each
    for (const [k, n] of net.fixed) {
      if (n.data.kind !== 'tank') continue
      const p = n.data.props
      const vol = Math.max(1e-4, tankVolume(p, model.levels?.[k] ?? p.initLevel))
      const cap = vol * rhoCp
      if (st.layers[k]) {
        const T = st.layers[k]
        const vl = vol / LAYERS
        const hl = Math.max(0.01, (model.levels?.[k] ?? p.initLevel) / LAYERS)
        const ins = inflows.get(k) ?? []
        const outs = net.carriers.filter((c) => c.from === k && c.q > 0)
        const atTop = (handle?: string | null) => handle === 't'
        // water entering or leaving low down drives a slow plug flow up (or down) through the stack
        const up = ins.filter((c) => !atTop(c.toHandle)).reduce((s, c) => s + c.q, 0) - outs.filter((c) => !atTop(c.fromHandle)).reduce((s, c) => s + c.q, 0)
        const heaterLayer = Math.min(LAYERS - 1, Math.floor((p.heaterHeight ?? 0.2) * LAYERS))
        const set = p.heaterSetpoint ?? 60
        const inner = Math.max(1, Math.ceil((2 * h * (Math.abs(up) + ins.reduce((s, c) => s + c.q, 0))) / vl))
        const hh = h / inner
        for (let k2 = 0; k2 < inner; k2++) {
          const old2 = [...T]
          for (const c of ins) {
            const i = atTop(c.toHandle) ? LAYERS - 1 : 0
            T[i] += ((c.q * hh) / vl) * (delivered.get(c)! - old2[i])
          }
          for (let i = 0; i < LAYERS; i++) {
            if (up > 0 && i > 0) T[i] += ((up * hh) / vl) * (old2[i - 1] - old2[i])
            if (up < 0 && i < LAYERS - 1) T[i] += ((-up * hh) / vl) * (old2[i + 1] - old2[i])
            // a little conduction and plume mixing between neighbours
            const mix = (5e-7 * hh) / (hl * hl)
            if (i > 0) T[i] += mix * (old2[i - 1] - old2[i])
            if (i < LAYERS - 1) T[i] += mix * (old2[i + 1] - old2[i])
            const loss = ((p.heatLoss ?? 0) / LAYERS) * (old2[i] - AMBIENT)
            T[i] -= (loss * hh) / (vl * rhoCp)
            bal.tankLoss += loss / steps / inner
          }
          if (p.heaterPower > 0 && T[heaterLayer] < set) {
            const want = Math.min(p.heaterPower, ((set - T[heaterLayer]) * vl * rhoCp) / hh)
            T[heaterLayer] += (want * hh) / (vl * rhoCp)
            bal.input += want / steps / inner
          }
          // warm water will not sit under cold: wherever a layer is hotter than the one above, they turn over and mix
          for (let pass = 0; pass < LAYERS; pass++) for (let i = 0; i < LAYERS - 1; i++) if (T[i] > T[i + 1]) T[i] = T[i + 1] = (T[i] + T[i + 1]) / 2
        }
        st.tanks[k] = T.reduce((s, t) => s + t, 0) / LAYERS
        st.points[k] = st.tanks[k]
        continue
      }
      let t = st.tanks[k]
      for (const c of inflows.get(k) ?? []) t += ((c.q * h) / vol) * (delivered.get(c)! - t)
      const loss = (p.heatLoss ?? 0) * (t - AMBIENT)
      const want = p.heaterPower > 0 && t < (p.heaterSetpoint ?? 60) ? Math.min(p.heaterPower, (((p.heaterSetpoint ?? 60) - t) * cap) / h + loss) : 0
      t += ((want - loss) * h) / cap
      bal.input += want / steps
      bal.tankLoss += loss / steps
      st.tanks[k] = t
      st.points[k] = t
    }
    // 5. junctions take the flow-weighted mix of what arrives
    for (const [k, list] of inflows) {
      if (net.fixed.has(k)) continue
      let sum = 0
      let q = 0
      for (const c of list) {
        sum +=
          c.q *
          (c.edge ? (c.forward ? st.cells[c.edge][st.cells[c.edge].length - 1] : st.cells[c.edge][0]) : (st.devices[c.through!] ?? deviceOutlet(byId.get(c.through!)!, st.points[c.from], c.q, rhoCp)))
        q += c.q
      }
      st.points[k] = sum / q
    }
  }
  // a point nothing flows into sits in dead water: it drifts to the temperature of the pipe cell beside it
  for (const c of net.carriers) {
    if (!c.edge || c.q > 0) continue
    const cells = st.cells[c.edge]
    for (const [pt, t] of [
      [c.from, cells[0]],
      [c.to, cells[cells.length - 1]],
    ] as [string, number][])
      if (!net.fixed.has(pt) && !inflows.has(pt)) st.points[pt] = t
  }
  bal.stored = bal.input - bal.emitted - bal.pipeLoss - bal.tankLoss
  return st
}

/** The live temperatures, packaged the way the steady layer reports its own. */
export function heatView(model: Model, results: Results, st: HeatState): Thermal {
  const view = thermalView(model, results, (k) => st.points[k], model.fluid.density * CP, st.cells)
  // an inline part with thermal mass reports the outlet temperature it has actually reached
  for (const [id, tOut] of Object.entries(st.devices)) {
    const d = results.devices[id]
    const v = view.devices[id]
    if (d && v) view.devices[id] = { ...v, tOut, heat: Math.abs(d.flow) * model.fluid.density * CP * (tOut - v.tIn) }
  }
  view.balance = st.balance
  if (Object.keys(st.layers).length) view.layers = st.layers
  return view
}
