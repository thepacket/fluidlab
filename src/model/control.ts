// Control layer: components that don't carry fluid but watch and switch the ones that do.
//
// Two kinds of signal wire, both stored source → target:
//   measurement  instrument `pv` port  → controller `cin` port   (an engineering value: m, Pa, m³/s)
//   command      controller `sig` port → device `ctl` port       (0‥1)
//                                      → logic / lamp `cin` port
// A command *scales the device's own setting*: a pump runs at speed × command, a throttle valve opens to
// opening × command, anything else is simply on (≥ 0.5) or off. So a digital 1 means "run as configured".
import type { Kind, ModelEdge, ModelNode, Props, Results } from './types'
import type { Quantity } from './units'

// ---- what can be wired to what -------------------------------------------------

/** instruments that can transmit their reading, and the quantity they transmit */
export const PV_SOURCES: Partial<Record<Kind, { quantity: Quantity; name: string; tag: string }>> = {
  tank: { quantity: 'length', name: 'Level', tag: 'L' },
  gauge: { quantity: 'pressure', name: 'Pressure', tag: 'P' },
  vessel: { quantity: 'pressure', name: 'Pressure', tag: 'P' },
  meter: { quantity: 'flow', name: 'Flow', tag: 'F' },
  dpgauge: { quantity: 'pressure', name: 'Differential', tag: 'dP' },
}
/** controllers that read a measurement */
export const PV_CONSUMERS: Kind[] = ['switch', 'pid']
/** control blocks that read other controllers' outputs */
export const SIGNAL_CONSUMERS: Kind[] = ['logic', 'lamp']
/** control blocks with an output */
export const SIGNAL_SOURCES: Kind[] = ['timer', 'manual', 'switch', 'pid', 'logic']

// ---- timer -----------------------------------------------------------------------

export interface TimerState {
  on: boolean
  /** seconds until the output next changes; null = it never will */
  next: number | null
  /** 0‥1 progress through the current on/off segment (or towards the one-shot) */
  progress: number
}

/** Output of a timer at lab time `t` (seconds). Pure, so the schedule can be plotted ahead of time. */
export function timerState(p: Props, t: number): TimerState {
  if (p.mode === 'once') {
    const delay = Math.max(0, p.delay)
    const fired = t >= delay
    return { on: fired === (p.action === 'on'), next: fired ? null : delay - t, progress: delay > 0 ? Math.min(1, t / delay) : 1 }
  }
  const on = Math.max(0, p.onTime)
  const off = Math.max(0, p.offTime)
  const period = on + off
  if (period <= 0) return { on: !!p.startOn, next: null, progress: 1 }
  const local = t % period
  // the cycle starts with whichever segment `startOn` names
  const [first, second] = p.startOn ? [on, off] : [off, on]
  const inFirst = local < first
  const span = inFirst ? first : second
  const into = inFirst ? local : local - first
  return { on: inFirst === !!p.startOn, next: span - into, progress: span > 0 ? into / span : 1 }
}

// ---- the control scan --------------------------------------------------------------

export interface ControlState {
  /** output of every control block, 0‥1 */
  out: Record<string, number>
  /** measurement currently seen by each switch / PID (SI), if it is wired and the network is solved */
  pv: Record<string, number>
  /** controller memory: PID integral, last error */
  mem: Record<string, { integral: number; lastError: number }>
  /** where each commanded actuator actually is — lags the command when the device has a stroke time */
  actuators: Record<string, number>
  /** what the solver is told: effective command per device */
  commands: Record<string, number>
}
export const EMPTY_CONTROL: ControlState = { out: {}, pv: {}, mem: {}, actuators: {}, commands: {} }

export interface ControlInput {
  nodes: ModelNode[]
  edges: ModelEdge[]
  /** lab time, s */
  t: number
  /** lab seconds since the previous scan; 0 = re-evaluate without advancing (an edit, not a tick) */
  dt: number
  results?: Results
  levels?: Record<string, number>
  prev?: ControlState
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function readPV(src: ModelNode, results?: Results, levels?: Record<string, number>): number | undefined {
  if (src.data.kind === 'tank') return levels?.[src.id] ?? src.data.props.initLevel
  if (!results?.ok) return undefined
  if (src.data.kind === 'gauge' || src.data.kind === 'vessel') return results.nodes[src.id]?.pressure
  const d = results.devices[src.id]
  if (!d) return undefined
  return src.data.kind === 'meter' ? Math.abs(d.flow) : d.pIn - d.pOut
}

/**
 * One scan of every controller, like a PLC cycle: read measurements, update each block, resolve commands,
 * move actuators. Pure and — with dt = 0 — idempotent, so it can safely be re-run whenever the rig is edited.
 */
export function stepControl({ nodes, edges, t, dt, results, levels, prev = EMPTY_CONTROL }: ControlInput): ControlState {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const wires = edges.filter((e) => e.type === 'signal' && byId.has(e.source) && byId.has(e.target))
  const next: ControlState = { out: {}, pv: {}, mem: {}, actuators: {}, commands: {} }
  const live = (n: ModelNode) => n.data.props.enabled !== false

  // 1. blocks whose output depends only on time, the operator, or a measurement
  for (const n of nodes) {
    const p = n.data.props
    const kind = n.data.kind
    if (kind === 'timer') next.out[n.id] = timerState(p, t).on ? 1 : 0
    else if (kind === 'manual') next.out[n.id] = p.on ? 1 : 0
    else if (kind === 'switch' || kind === 'pid') {
      const wire = wires.find((w) => w.target === n.id && w.targetHandle === 'cin')
      const pv = wire ? readPV(byId.get(wire.source)!, results, levels) : undefined
      if (pv !== undefined) next.pv[n.id] = pv
      const was = prev.out[n.id] ?? 0
      if (dt <= 0 && prev.out[n.id] !== undefined) {
        // Feedback blocks only act on the clock. Re-deciding on every re-solve would let a pressure switch and
        // its pump chase each other in zero time; between ticks they hold.
        next.out[n.id] = was
        if (prev.mem[n.id]) next.mem[n.id] = prev.mem[n.id]
        continue
      }
      if (kind === 'switch') {
        // hysteresis: between the two thresholds the contact stays where it was
        const lo = Math.min(p.low, p.high)
        const hi = Math.max(p.low, p.high)
        const fill = p.action !== 'drain'
        let on = was >= 0.5
        if (pv !== undefined) {
          if (pv <= lo) on = fill
          else if (pv >= hi) on = !fill
        }
        next.out[n.id] = on ? 1 : 0
      } else {
        const m = prev.mem[n.id] ?? { integral: clamp01(p.manualOut), lastError: 0 }
        if (!p.auto || pv === undefined) {
          // manual: the integral tracks the output so the switch back to auto is bumpless
          const held = p.auto ? was : clamp01(p.manualOut)
          next.out[n.id] = held
          next.mem[n.id] = { integral: held, lastError: 0 }
        } else {
          const e = ((p.setpoint - pv) / Math.max(1e-9, p.span)) * (p.reverse ? -1 : 1)
          // a scan longer than the integral time would overshoot in one step: limit it (slower, never wilder)
          const h = Math.min(dt, p.ti > 0 ? p.ti : dt)
          const unsat = clamp01(p.kp * e + m.integral)
          let integral = m.integral
          // conditional integration = anti-windup: stop winding once the output is pinned in that direction
          if (p.ti > 0 && !((unsat >= 1 && e > 0) || (unsat <= 0 && e < 0))) integral = clamp01(integral + (p.kp * e * h) / p.ti)
          const deriv = h > 0 && p.td > 0 ? (p.kp * p.td * (e - m.lastError)) / h : 0
          next.out[n.id] = clamp01(p.kp * e + integral + deriv)
          next.mem[n.id] = { integral, lastError: dt > 0 ? e : m.lastError }
        }
      }
    }
  }

  // 2. logic blocks read other blocks; a few passes settle chains (a loop just keeps its previous value)
  const logic = nodes.filter((n) => n.data.kind === 'logic' || n.data.kind === 'lamp')
  for (const n of logic) next.out[n.id] = prev.out[n.id] ?? 0
  for (let pass = 0; pass < 4; pass++)
    for (const n of logic) {
      const ins = wires.filter((w) => w.target === n.id && w.targetHandle === 'cin' && live(byId.get(w.source)!)).map((w) => (next.out[w.source] ?? 0) >= 0.5)
      const op = n.data.kind === 'lamp' ? 'or' : n.data.props.op
      const v = !ins.length ? false : op === 'and' ? ins.every(Boolean) : op === 'not' ? !ins.some(Boolean) : ins.some(Boolean)
      next.out[n.id] = v ? 1 : 0
    }

  // 3. commands: the strongest live signal arriving at each device wins
  for (const w of wires) {
    if (w.targetHandle !== 'ctl') continue
    const src = byId.get(w.source)!
    if (!live(src) || next.out[w.source] === undefined) continue
    next.commands[w.target] = Math.max(next.commands[w.target] ?? 0, next.out[w.source])
  }

  // 4. actuators with a stroke time travel towards their command instead of jumping
  for (const id of Object.keys(next.commands)) {
    const dev = byId.get(id)!
    const stroke = dev.data.kind === 'valve' && dev.data.props.valveType === 'throttle' ? (dev.data.props.strokeTime ?? 0) : 0
    const target = next.commands[id]
    const at = prev.actuators[id] ?? target
    const pos = stroke > 0 ? at + Math.sign(target - at) * Math.min(Math.abs(target - at), dt / stroke) : target
    next.actuators[id] = pos
    next.commands[id] = pos
  }
  return next
}

/** Commands for a rig whose controllers only need the clock (timers, manual switches). */
export const computeControls = (nodes: ModelNode[], edges: ModelEdge[], t: number) => stepControl({ nodes, edges, t, dt: 0 }).commands

export const sameControl = (a: ControlState, b: ControlState) => JSON.stringify(a) === JSON.stringify(b)

export const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`
}
