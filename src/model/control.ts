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
  weir: { quantity: 'flow', name: 'Flow', tag: 'F' },
  thermo: { quantity: 'temperature', name: 'Temperature', tag: 'T' },
  fitting: { quantity: 'temperature', name: 'Room temperature', tag: 'T' },
}
/** controllers that read a measurement */
export const PV_CONSUMERS: Kind[] = ['switch', 'pid']
/** control blocks that read other controllers' outputs */
export const SIGNAL_CONSUMERS: Kind[] = ['logic', 'lamp', 'stager', 'sequence']
/** control blocks with an output */
export const SIGNAL_SOURCES: Kind[] = ['timer', 'manual', 'switch', 'pid', 'logic', 'stager', 'schedule', 'sequence']

/** Day/night value of a setpoint scheduler at lab time t. */
export function scheduleValue(p: Props, t: number): number {
  const h = (((t / 3600) % 24) + 24) % 24
  const day = p.dayStart <= p.dayEnd ? h >= p.dayStart && h < p.dayEnd : h >= p.dayStart || h < p.dayEnd
  return Math.min(1, Math.max(0, day ? p.dayValue : p.nightValue))
}

// ---- event sequence --------------------------------------------------------------

/** One line of an event sequence: at `at` seconds, take `target` (a wired device's id, or 'all') to `value`, over `ramp` seconds. */
export interface SequenceStep {
  at: number
  target: string
  value: number
  ramp: number
}
/** Lab time as the sequence sees it: it may loop. */
export const sequenceClock = (p: Props, t: number) => (p.repeat && p.period > 0 ? ((t % p.period) + p.period) % p.period : t)
/**
 * Command a sequence is giving one device at lab time t. Before its first step a device is left exactly as it is
 * configured (100 %); each step starts from wherever the previous ones had brought it, so ramps can be interrupted.
 */
export function sequenceValue(p: Props, target: string, t: number): number {
  const steps = ((p.steps ?? []) as SequenceStep[]).filter((s) => s.target === target || s.target === 'all').sort((a, b) => a.at - b.at)
  const chain = (start: number) => {
    let cur = (_tt: number): number => start
    for (const s of steps) {
      const before = cur
      const from = before(s.at)
      cur = (tt) => (tt < s.at ? before(tt) : s.ramp > 0 ? from + (clamp01(s.value) - from) * Math.min(1, (tt - s.at) / s.ramp) : clamp01(s.value))
    }
    return cur
  }
  // a repeating sequence picks each cycle up where the last one left off, so a ramp can carry across the wrap
  const start = p.repeat && p.period > 0 && steps.length ? chain(1)(p.period) : 1
  return chain(start)(sequenceClock(p, t))
}

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
  /** blocks that tell each device something different (a pump sequencer): output per wire */
  wire: Record<string, number>
}
export const EMPTY_CONTROL: ControlState = { out: {}, pv: {}, mem: {}, actuators: {}, commands: {}, wire: {} }

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
  if (src.data.kind === 'thermo') return results.thermal?.nodes[src.id]
  if (src.data.kind === 'fitting') return results.thermal?.rooms?.[src.id]
  if (src.data.kind === 'weir') return results.nodes[src.id]?.extra?.flow
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
  const next: ControlState = { out: {}, pv: {}, mem: {}, actuators: {}, commands: {}, wire: {} }
  const live = (n: ModelNode) => n.data.props.enabled !== false

  // 1. blocks whose output depends only on time, the operator, or a measurement
  for (const n of nodes) {
    const p = n.data.props
    if (n.data.kind === 'timer') next.out[n.id] = timerState(p, t).on ? 1 : 0
    else if (n.data.kind === 'manual') next.out[n.id] = p.on ? 1 : 0
    else if (n.data.kind === 'schedule') next.out[n.id] = scheduleValue(p, t)
  }
  for (const n of nodes) {
    const p = n.data.props
    const kind = n.data.kind
    if (kind === 'switch' || kind === 'pid') {
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
          // a remote setpoint (0‥1 of the span) overrides the one typed on the faceplate
          const rsp = wires.find((w) => w.target === n.id && w.targetHandle === 'rsp' && next.out[w.source] !== undefined)
          const setpoint = rsp ? next.out[rsp.source] * p.span : p.setpoint
          const e = ((setpoint - pv) / Math.max(1e-9, p.span)) * (p.reverse ? -1 : 1)
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
      if (op === 'latch') {
        // set / reset memory: reset wins, and with neither input on it remembers
        const reset = wires.some((w) => w.target === n.id && w.targetHandle === 'cin2' && live(byId.get(w.source)!) && (next.out[w.source] ?? 0) >= 0.5)
        next.out[n.id] = reset ? 0 : ins.some(Boolean) ? 1 : (prev.out[n.id] ?? 0)
        continue
      }
      const v = !ins.length ? false : op === 'and' ? ins.every(Boolean) : op === 'not' ? !ins.some(Boolean) : ins.some(Boolean)
      next.out[n.id] = v ? 1 : 0
    }

  // 2b. pump sequencers: turn a demand (0‥1) into "how many, and which", rotating the lead so wear is shared
  for (const n of nodes) {
    if (n.data.kind !== 'stager') continue
    const p = n.data.props
    const ins = wires.filter((w) => w.target === n.id && w.targetHandle === 'cin' && live(byId.get(w.source)!)).map((w) => next.out[w.source] ?? 0)
    const demand = ins.length ? Math.max(...ins) : 0
    next.out[n.id] = demand
    const outs = wires.filter((w) => w.source === n.id && w.targetHandle === 'ctl')
    const N = outs.length
    if (!N) continue
    // stage up as soon as the running pumps are not enough; stage down only once there is clear room to spare,
    // so a demand sitting on a boundary doesn't make a pump start and stop every scan
    const was = outs.filter((w) => (prev.wire[w.id] ?? 0) > 0.01).length
    const wanted = demand <= 0.02 ? 0 : Math.min(N, Math.ceil(demand * N - 1e-9))
    const running = wanted >= was ? wanted : demand * N < was - 1 - 0.25 ? wanted : was
    const lead = p.rotateEvery > 0 ? Math.floor(t / p.rotateEvery) % N : 0
    for (let k = 0; k < N; k++) {
      const w = outs[(lead + k) % N]
      // Staged pumps share one speed. Trimming only the last one in doesn't work in parallel: a pump much slower
      // than its neighbours can't open its check valve. So all of them ride between a floor and full speed.
      const floor = p.minSpeed ?? 0.75
      const share = Math.min(1, Math.max(0, demand * N - (running - 1)))
      next.wire[w.id] = k >= running ? 0 : p.trim ? floor + (1 - floor) * share : 1
    }
  }

  // 2b. event sequences. Left alone, a sequence runs on the lab clock. With something wired to its input it waits for
  // that signal: 'start' lets it run on once triggered, 'run' lets its clock advance only while the signal is on —
  // so "when the tank reaches 2 m, then…" is a limit switch wired to a sequence.
  for (const n of nodes) {
    if (n.data.kind !== 'sequence') continue
    const p = n.data.props
    const gate = wires.find((w) => w.target === n.id && w.targetHandle === 'cin')
    const was = prev.mem[n.id] ?? { integral: 0, lastError: 0 }
    const on = gate ? (next.out[gate.source] ?? 0) >= 0.5 : true
    const started = !gate || on || (p.trigger !== 'run' && was.lastError === 1)
    const running = gate ? (p.trigger === 'run' ? on : started) : true
    const elapsed = gate ? was.integral + (running ? dt : 0) : t
    next.mem[n.id] = { integral: elapsed, lastError: started ? 1 : 0 }
    // every wired device gets its own command; the block's own output is their average, for the trend
    const mine = wires.filter((w) => w.source === n.id)
    for (const w of mine) next.wire[w.id] = live(n) ? sequenceValue(p, w.target, elapsed) : 1
    next.out[n.id] = mine.length ? mine.reduce((s, w) => s + next.wire[w.id], 0) / mine.length : 0
  }

  // 3. commands: the strongest live signal arriving at each device wins
  for (const w of wires) {
    if (w.targetHandle !== 'ctl') continue
    const src = byId.get(w.source)!
    if (!live(src) || next.out[w.source] === undefined) continue
    next.commands[w.target] = Math.max(next.commands[w.target] ?? 0, next.wire[w.id] ?? next.out[w.source])
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
