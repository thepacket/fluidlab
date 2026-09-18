// Sequential ramps for the canvas overlays: one hue each, dark → bright on the dark surface.
type RGB = [number, number, number]
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

const PRESSURE = ['#1b3a8a', '#1f66d6', '#2a9dff', '#4fd4ff', '#a5f6ff'].map(hex)
const VELOCITY = ['#5c2410', '#a8431a', '#e8692c', '#ffa25e', '#ffe0b8'].map(hex)

function ramp(stops: RGB[], t: number) {
  const x = Math.min(1, Math.max(0, isFinite(t) ? t : 0)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const f = x - i
  const c = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

// signal wires: commands are violet, measurements green, anything idle a dim slate
export const SIGNAL_ON = '#b7a9ff'
export const SIGNAL_OFF = '#4a4f7a'
export const SIGNAL_PV = '#4fe0b0'

export const SUB_ATMOSPHERIC = '#ff4fa3'
export const PLAIN = '#3aa0ff'
export const DRY = '#33415a'

export const pressureColor = (p: number, pMax: number) => (p < -500 ? SUB_ATMOSPHERIC : ramp(PRESSURE, p / pMax))
export const velocityColor = (v: number, vMax: number) => ramp(VELOCITY, v / vMax)

export const rampCss = (kind: 'pressure' | 'velocity') => `linear-gradient(90deg, ${(kind === 'pressure' ? PRESSURE : VELOCITY).map((c) => `rgb(${c.join(',')})`).join(',')})`

export function niceCeil(x: number) {
  if (x <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  for (const m of [1, 1.6, 2.5, 4, 6, 10]) if (m * p >= x * 0.999) return m * p
  return 10 * p
}

export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) max = min + 1
  const raw = (max - min) / count
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  return out
}
