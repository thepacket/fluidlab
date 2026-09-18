// Open-channel hydraulics: section geometry, Manning, critical flow, weirs, flumes and gates. SI throughout.
import { G } from './physics'
import type { Kind, Model, Props } from './types'

export const CHANNEL_KINDS: Kind[] = ['inflow', 'weir', 'gate', 'outfall']
export const isChannelKind = (k: Kind) => CHANNEL_KINDS.includes(k)
export const isChannel = (e: { type?: string; data?: { props: Props } }) => e.type !== 'signal' && e.data?.props.conduit === 'channel'

/** The pressurised part of a rig: what EPANET, the gas engine and the surge engine get to see. */
export function stripChannels(model: Model): Model {
  if (!model.edges.some(isChannel) && !model.nodes.some((n) => isChannelKind(n.data.kind))) return model
  const wet = new Set<string>()
  const piped = new Set<string>()
  for (const e of model.edges) {
    if (e.type === 'signal') continue
    const bag = isChannel(e) ? wet : piped
    bag.add(e.source)
    bag.add(e.target)
  }
  const gone = (id: string, kind: Kind) => isChannelKind(kind) || (wet.has(id) && !piped.has(id))
  const dropped = new Set(model.nodes.filter((n) => gone(n.id, n.data.kind)).map((n) => n.id))
  return { ...model, nodes: model.nodes.filter((n) => !dropped.has(n.id)), edges: model.edges.filter((e) => !isChannel(e) && !dropped.has(e.source) && !dropped.has(e.target)) }
}

/** Bed level of a channel where it meets a tank (its base, unless told otherwise) or a reservoir (half a metre under the surface). */
export const lakeSill = (kind: Kind, p: Props): number => p.channelInvert ?? (kind === 'tank' ? p.elevation : p.head - 0.5)

// ---- linings -------------------------------------------------------------------------

/** Manning's n, and the velocity above which the lining starts to scour (m/s). */
export const LININGS: { id: string; name: string; n: number; vMax: number }[] = [
  { id: 'glass', name: 'Glass / acrylic (lab flume)', n: 0.01, vMax: 10 },
  { id: 'pvc', name: 'PVC / HDPE', n: 0.01, vMax: 8 },
  { id: 'concrete', name: 'Concrete, trowelled', n: 0.013, vMax: 6 },
  { id: 'shotcrete', name: 'Shotcrete / rough concrete', n: 0.018, vMax: 5 },
  { id: 'brick', name: 'Brickwork', n: 0.015, vMax: 4 },
  { id: 'cmp', name: 'Corrugated metal', n: 0.024, vMax: 5 },
  { id: 'earth', name: 'Earth, clean', n: 0.022, vMax: 0.8 },
  { id: 'gravel', name: 'Gravel bed', n: 0.025, vMax: 1.5 },
  { id: 'grass', name: 'Grassed', n: 0.03, vMax: 1.8 },
  { id: 'riprap', name: 'Rip-rap', n: 0.035, vMax: 4 },
  { id: 'stream', name: 'Natural stream', n: 0.04, vMax: 1.5 },
  { id: 'custom', name: 'Custom', n: 0.015, vMax: 10 },
]
export const lining = (id: string) => LININGS.find((l) => l.id === id) ?? LININGS[2]

export const CHANNEL_SHAPES = [
  { id: 'rect', name: 'Rectangular' },
  { id: 'trap', name: 'Trapezoidal' },
  { id: 'tri', name: 'Triangular (V)' },
  { id: 'circ', name: 'Circular (culvert / sewer)' },
]

export function defaultChannelProps(): Props {
  return { conduit: 'channel', length: 50, shape: 'rect', width: 0.5, sideSlope: 1.5, diameter: 0.6, lining: 'concrete', manningN: 0.013, bankHeight: 0.6 }
}

// ---- section geometry -----------------------------------------------------------------

/** Deepest water a section can hold before it is no longer an open channel. */
export const sectionTop = (p: Props) => (p.shape === 'circ' ? p.diameter : 100)

const theta = (p: Props, y: number) => 2 * Math.acos(Math.min(1, Math.max(-1, 1 - (2 * y) / p.diameter)))

export function area(p: Props, y: number): number {
  if (y <= 0) return 0
  if (p.shape === 'circ') {
    const t = theta(p, Math.min(y, p.diameter))
    return (p.diameter ** 2 / 8) * (t - Math.sin(t))
  }
  const b = p.shape === 'tri' ? 0 : p.width
  const z = p.shape === 'rect' ? 0 : p.sideSlope
  return (b + z * y) * y
}
export function perimeter(p: Props, y: number): number {
  if (y <= 0) return 0
  if (p.shape === 'circ') return (p.diameter * theta(p, Math.min(y, p.diameter))) / 2
  const b = p.shape === 'tri' ? 0 : p.width
  const z = p.shape === 'rect' ? 0 : p.sideSlope
  return b + 2 * y * Math.sqrt(1 + z * z)
}
export function topWidth(p: Props, y: number): number {
  if (p.shape === 'circ') return Math.max(1e-6, p.diameter * Math.sin(theta(p, Math.min(y, p.diameter)) / 2))
  const b = p.shape === 'tri' ? 0 : p.width
  const z = p.shape === 'rect' ? 0 : p.sideSlope
  return Math.max(1e-6, b + 2 * z * y)
}
/** A·ȳ — first moment of the flow area about the water surface (= ∫A dη from the bed up). */
export function firstMoment(p: Props, y: number): number {
  if (y <= 0) return 0
  if (p.shape === 'circ') {
    const n = 16
    const h = y / n
    let s = 0
    for (let i = 0; i <= n; i++) s += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * area(p, i * h)
    return (s * h) / 3
  }
  const b = p.shape === 'tri' ? 0 : p.width
  const z = p.shape === 'rect' ? 0 : p.sideSlope
  return (b * y * y) / 2 + (z * y ** 3) / 3
}

export const hydraulicRadius = (p: Props, y: number) => (y > 0 ? area(p, y) / perimeter(p, y) : 0)
export const froude = (q: number, p: Props, y: number) => (y > 0 ? Math.abs(q) / area(p, y) / Math.sqrt((G * area(p, y)) / topWidth(p, y)) : 0)
/** specific energy, m above the bed */
export const specificEnergy = (q: number, p: Props, y: number) => y + (q / area(p, y)) ** 2 / (2 * G)
/** specific force (momentum function), m³ — conserved across a hydraulic jump */
export const specificForce = (q: number, p: Props, y: number) => (y > 0 ? (q * q) / (G * area(p, y)) + firstMoment(p, y) : Infinity)
/** Manning friction slope */
export const frictionSlope = (q: number, p: Props, y: number) => {
  const a = area(p, y)
  return a > 0 ? (p.manningN * q) ** 2 / (a * a * hydraulicRadius(p, y) ** (4 / 3)) : Infinity
}
/** discharge at uniform flow for depth y on bed slope s0 */
export const manningFlow = (p: Props, y: number, s0: number) => (area(p, y) * hydraulicRadius(p, y) ** (2 / 3) * Math.sqrt(Math.max(0, s0))) / p.manningN

/** Root of an increasing function on [lo, hi]. */
export function bisect(f: (x: number) => number, lo: number, hi: number, iters = 60): number {
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) > 0) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}

/** Depth at which Fr = 1. */
export function criticalDepth(q: number, p: Props): number {
  if (q <= 0) return 0
  const top = p.shape === 'circ' ? p.diameter * 0.9999 : 100
  // Fr² falls with depth
  return bisect((y) => 1 - (q * q * topWidth(p, y)) / (G * area(p, y) ** 3), 1e-6, top)
}

/** Uniform-flow depth; null when the bed does not fall, or a closed section cannot carry the flow with a free surface. */
export function normalDepth(q: number, p: Props, s0: number): number | null {
  if (q <= 0) return 0
  if (s0 <= 1e-9) return null
  const top = p.shape === 'circ' ? p.diameter * 0.938 : 100 // a pipe carries most just short of full
  if (manningFlow(p, top, s0) < q) return null
  return bisect((y) => manningFlow(p, y, s0) - q, 1e-6, top)
}

/** The depth on the other side of a hydraulic jump: same specific force, other regime. */
export function conjugateDepth(q: number, p: Props, y: number): number {
  const yc = criticalDepth(q, p)
  const m = specificForce(q, p, y)
  if (y < yc) return bisect((x) => specificForce(q, p, x) - m, yc, sectionTop(p))
  return bisect((x) => m - specificForce(q, p, x), 1e-6, yc)
}

/** Supercritical depth carrying specific energy e (m above the bed); critical depth if e is not enough. */
export function superDepth(q: number, p: Props, e: number): number {
  const yc = criticalDepth(q, p)
  if (specificEnergy(q, p, yc) >= e) return yc
  return bisect((y) => e - specificEnergy(q, p, y), 1e-6, yc)
}

// ---- control structures ---------------------------------------------------------------

export interface StructureSpec {
  id: string
  name: string
  blurb: string
  prefix: string
  /** Q ∝ H^exponent */
  exponent: number
  defaults: Props
}

export const WEIR_TYPES: StructureSpec[] = [
  { id: 'sharp', name: 'Sharp-crested weir', blurb: 'Full-width plate — Rehbock', prefix: 'WR', exponent: 1.5, defaults: { crestHeight: 0.3, crestWidth: 0.5 } },
  { id: 'contracted', name: 'Contracted weir', blurb: 'Notch narrower than the channel — Francis', prefix: 'WR', exponent: 1.5, defaults: { crestHeight: 0.3, crestWidth: 0.3 } },
  { id: 'vnotch', name: 'V-notch weir', blurb: 'Accurate at small flows — Q ∝ H^2.5', prefix: 'VN', exponent: 2.5, defaults: { crestHeight: 0.2, notchAngle: 90 } },
  { id: 'cipolletti', name: 'Cipolletti weir', blurb: 'Trapezoidal notch, 1:4 sides', prefix: 'WR', exponent: 1.5, defaults: { crestHeight: 0.3, crestWidth: 0.3 } },
  { id: 'broad', name: 'Broad-crested weir', blurb: 'Critical flow over a long sill', prefix: 'BW', exponent: 1.5, defaults: { crestHeight: 0.2, crestWidth: 0.5 } },
  { id: 'parshall', name: 'Parshall flume', blurb: 'Measures flow with little head loss', prefix: 'PF', exponent: 1.55, defaults: { crestHeight: 0, throat: '6in' } },
]
export const weirType = (id: string) => WEIR_TYPES.find((w) => w.id === id) ?? WEIR_TYPES[0]

/** Parshall free-flow ratings Q = C·Ha^n (m³/s, m) by throat width. */
export const PARSHALL: Record<string, { name: string; width: number; c: number; n: number }> = {
  '3in': { name: '3 in (76 mm)', width: 0.0762, c: 0.1771, n: 1.55 },
  '6in': { name: '6 in (152 mm)', width: 0.1524, c: 0.3812, n: 1.58 },
  '9in': { name: '9 in (229 mm)', width: 0.2286, c: 0.5354, n: 1.53 },
  '1ft': { name: '1 ft (305 mm)', width: 0.3048, c: 0.6909, n: 1.522 },
  '2ft': { name: '2 ft (610 mm)', width: 0.6096, c: 1.428, n: 1.55 },
  '3ft': { name: '3 ft (914 mm)', width: 0.9144, c: 2.184, n: 1.566 },
  '4ft': { name: '4 ft (1.22 m)', width: 1.2192, c: 2.953, n: 1.578 },
  '6ft': { name: '6 ft (1.83 m)', width: 1.8288, c: 4.519, n: 1.595 },
}

const R2G = Math.sqrt(2 * G)

/** Free (modular) discharge of a weir or flume under head h above its crest. */
export function weirFlow(p: Props, h: number): number {
  if (h <= 0) return 0
  switch (p.variant) {
    case 'vnotch':
      return (8 / 15) * 0.58 * R2G * Math.tan(((p.notchAngle ?? 90) * Math.PI) / 360) * h ** 2.5
    case 'cipolletti':
      return 1.859 * p.crestWidth * h ** 1.5
    case 'broad':
      return 1.705 * 0.93 * p.crestWidth * h ** 1.5
    case 'parshall': {
      const f = PARSHALL[p.throat] ?? PARSHALL['6in']
      return f.c * h ** f.n
    }
    case 'contracted':
      return (2 / 3) * 0.611 * R2G * Math.max(0.1 * p.crestWidth, p.crestWidth - 0.2 * h) * h ** 1.5
    default:
      return (2 / 3) * (0.611 + (0.075 * h) / Math.max(0.02, p.crestHeight)) * R2G * p.crestWidth * h ** 1.5
  }
}
export const weirExponent = (p: Props) => (p.variant === 'parshall' ? (PARSHALL[p.throat] ?? PARSHALL['6in']).n : weirType(p.variant).exponent)

/**
 * Head over the crest needed to pass q. `tail` is the tailwater height above the crest: above zero it drowns the
 * weir, and Villemonte's correction Q = Q_free·(1 − (h2/h1)^n)^0.385 applies.
 */
export function weirHead(p: Props, q: number, tail = 0): number {
  if (q <= 0) return Math.max(0, tail)
  const n = weirExponent(p)
  const f = (h: number) => weirFlow(p, h) * (tail > 0 ? Math.max(0, 1 - (tail / h) ** n) ** 0.385 : 1) - q
  return bisect(f, Math.max(1e-6, tail), Math.max(tail, 0) + 50)
}

export const GATE_CC = 0.61
/** Free discharge under a sluice gate of width b, opening a, with upstream depth y1 (Henry / Swamee form). */
export const gateFlow = (b: number, a: number, y1: number) => (y1 <= a ? Infinity : (GATE_CC / Math.sqrt(1 + (GATE_CC * a) / y1)) * b * a * Math.sqrt(2 * G * y1))
/** Upstream depth a free-flowing gate needs to pass q; at or below the opening means the gate is clear of the water. */
export function gateDepth(b: number, a: number, q: number): number {
  if (gateFlow(b, a, a * 1.0001) >= q) return a
  return bisect((y) => gateFlow(b, a, y) - q, a * 1.0001, 200)
}

export type SlopeClass = 'mild' | 'steep' | 'critical' | 'horizontal' | 'adverse'
export function slopeClass(s0: number, yn: number | null, yc: number): SlopeClass {
  if (s0 < -1e-9) return 'adverse'
  if (s0 <= 1e-9 || yn === null) return 'horizontal'
  if (Math.abs(yn - yc) < 0.01 * yc) return 'critical'
  return yn > yc ? 'mild' : 'steep'
}
/** Name of the gradually-varied profile zone a depth falls in: M1, S2, H3 … */
export function zoneName(cls: SlopeClass, y: number, yn: number | null, yc: number): string {
  const letter = cls[0].toUpperCase()
  const hi = Math.max(yn ?? Infinity, yc)
  const lo = Math.min(yn ?? Infinity, yc)
  if (cls === 'horizontal' || cls === 'adverse') return `${letter}${y > yc ? 2 : 3}`
  if (yn !== null && Math.abs(y - yn) < 0.01 * yn) return 'uniform'
  return `${letter}${y > hi * 1.002 ? 1 : y > lo * 0.998 ? 2 : 3}`
}
