// Control layer: components that don't carry fluid but switch the ones that do.
// Signals travel along 'signal' edges from a controller's `sig` port to a device's `ctl` port.
import type { ModelEdge, ModelNode, Props } from './types'

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

/**
 * Resolve every signal wire into an on/off command per controlled device.
 * A device with no (enabled) controller attached is absent from the map and runs on its own settings;
 * with several controllers, any one being on is enough.
 */
export function computeControls(nodes: ModelNode[], edges: ModelEdge[], t: number): Record<string, boolean> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: Record<string, boolean> = {}
  for (const e of edges) {
    if (e.type !== 'signal') continue
    const ctrl = byId.get(e.source)
    if (!ctrl || ctrl.data.kind !== 'timer' || !ctrl.data.props.enabled || !byId.has(e.target)) continue
    out[e.target] = (out[e.target] ?? false) || timerState(ctrl.data.props, t).on
  }
  return out
}

export const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`
}
