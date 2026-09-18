// Educational calculations that sit beside the network solver.
import type { Fluid, Props } from './types'

export const G = 9.80665
export const P_ATM = 101325

export const area = (d: number) => (Math.PI * d * d) / 4

export function reynolds(v: number, d: number, fluid: Fluid) {
  return (fluid.density * Math.abs(v) * d) / fluid.dynamicViscosity
}

export function regimeOf(re: number): 'still' | 'laminar' | 'transitional' | 'turbulent' {
  if (re < 1) return 'still'
  if (re < 2000) return 'laminar'
  if (re < 4000) return 'transitional'
  return 'turbulent'
}

/** Darcy friction factor, same scheme EPANET uses: Hagen–Poiseuille, Swamee–Jain, cubic blend between. */
export function frictionFactor(re: number, relRough: number): number {
  if (re < 1e-6) return 0
  if (re <= 2000) return 64 / re
  const sj = (r: number) => 0.25 / Math.log10(relRough / 3.7 + 5.74 / Math.pow(r, 0.9)) ** 2
  if (re >= 4000) return sj(re)
  // Dunlop cubic interpolation through the transition zone
  const y2 = relRough / 3.7 + 5.74 / Math.pow(4000, 0.9)
  const y3 = -0.86859 * Math.log(y2)
  const fa = 1 / (y3 * y3)
  const fb = (2 + 0.00514215 / (y2 * y3)) * fa
  const r = re / 2000
  const x1 = 7 * fa - fb
  const x2 = 0.128 - 17 * fa + 2.5 * fb
  const x3 = -0.128 + 13 * fa - 2 * fb
  const x4 = r * (0.032 - 3 * fa + 0.5 * fb)
  return x1 + r * (x2 + r * (x3 + x4))
}

/** Head loss (m) through a pipe at flow q (m³/s): friction + minor. */
export function pipeHeadloss(q: number, p: Props, fluid: Fluid) {
  const v = Math.abs(q) / area(p.diameter)
  const re = reynolds(v, p.diameter, fluid)
  const f = frictionFactor(re, p.roughness / p.diameter)
  return ((f * p.length) / p.diameter + (p.minorK || 0)) * ((v * v) / (2 * G))
}

/**
 * Loss coefficient of a throttling valve at a given opening. The trim sets how the flow capacity Cv grows with
 * travel — equal-percentage (rangeability 50), linear, or quick-opening — and K = K_open / (Cv/Cv_open)².
 */
export function valveK(opening: number, kOpen: number, trim: string = 'equal'): number {
  const x = Math.min(1, Math.max(0, opening))
  if (x <= 0.001) return Infinity
  const relCv = trim === 'linear' ? x : trim === 'quick' ? Math.sqrt(x) : Math.pow(50, x - 1)
  return kOpen / (relCv * relCv)
}

/** Flow coefficient Kv (m³/h of water at 1 bar drop) of a loss K on a bore d. Cv(US) = Kv / 0.865. */
export const kvOf = (K: number, d: number) => (isFinite(K) && K > 0 ? 3600 * area(d) * Math.sqrt(200 / K) : 0)

// ---- catalogue loss devices ------------------------------------------------------------

/** Bore the solver sees, and the K on that bore, for a K-model fitting. Reducers and expanders follow from their two diameters. */
export function fittingK(p: Props, byDiameters?: 'contraction' | 'expansion') {
  if (!byDiameters) return { bore: p.diameter, K: Math.max(0, p.k) }
  const small = Math.min(p.diameter, p.d2)
  const b2 = (small / Math.max(p.diameter, p.d2)) ** 2
  return { bore: small, K: byDiameters === 'contraction' ? 0.5 * (1 - b2) : (1 - b2) ** 2 }
}

/** Pressure drop (Pa) of a rated device at flow q: the datasheet point scaled by (Q/Q_r)ⁿ, worsened by fouling. */
export function ratedDp(q: number, p: Props) {
  const clean = p.ratedDp * Math.pow(Math.abs(q) / Math.max(1e-9, p.ratedFlow), p.exponent)
  return clean / (1 - Math.min(0.95, Math.max(0, p.fouling ?? 0))) ** 2
}

// Pump curve through three points — shut-off (0, r₀·Hd), duty (Qd, Hd) and run-out (r_max·Qd, 0) — in EPANET's
// own form H = H₀ − B·Qᶜ, scaled by the affinity laws. The default ratios (4/3 and 2) give the classic parabola.
export function pumpShape(p: Props) {
  const r0 = Math.max(1.02, p.shutoffRatio ?? 4 / 3)
  const rMax = Math.max(1.05, p.runoutRatio ?? 2)
  return { r0, rMax, c: Math.log(r0 / (r0 - 1)) / Math.log(rMax) }
}
export function pumpHead(q: number, p: Props, speed = p.speed): number {
  const { r0, c } = pumpShape(p)
  const s = Math.max(1e-6, speed)
  return p.designHead * (s * s * r0 - (r0 - 1) * Math.pow(s, 2 - c) * Math.pow(Math.max(0, q) / p.designFlow, c))
}
export function pumpMaxFlow(p: Props, speed = p.speed): number {
  return pumpShape(p).rMax * p.designFlow * speed
}
/** Parabolic efficiency curve peaking at the (speed-scaled) design flow. */
export function pumpEfficiency(q: number, p: Props, speed = p.speed): number {
  if (speed <= 0) return 0
  const x = q / (p.designFlow * speed)
  return Math.max(0.02, p.bepEfficiency * (2 * x - x * x))
}

export const nozzleFlow = (pressureHead: number, d: number, cd: number) => cd * area(d) * Math.sqrt(2 * G * Math.max(0, pressureHead))

// ---- differential-pressure flow elements (venturi, orifice) ------------------
// A network solver only tracks piezometric head, so the throat's Bernoulli pressure dip is
// computed here; only the *permanent* loss is handed to the solver as a minor-loss K.

export const beta = (p: Props) => Math.min(0.95, Math.max(0.1, p.throat / p.diameter))

/** Pressure difference between the upstream and throat taps at flow q. */
export function elementTapDp(q: number, p: Props, fluid: Fluid) {
  const b = beta(p)
  const vt = Math.abs(q) / (p.cd * area(b * p.diameter))
  return (fluid.density / 2) * vt * vt * (1 - b ** 4)
}
/** Fraction of the tap differential that is never recovered downstream. */
export const elementLossFraction = (p: Props) => (p.elementType === 'orifice' ? 1 - beta(p) ** 1.9 : 0.12)

/** Permanent-loss coefficient referred to the pipe-bore velocity. */
export function elementK(p: Props) {
  const b = beta(p)
  return (elementLossFraction(p) * (1 - b ** 4)) / (p.cd * p.cd * b ** 4)
}
/** What an operator would infer from the differential: Q = Cd·A_t·√(2Δp / ρ(1−β⁴)) */
export function elementInferredFlow(dp: number, p: Props, fluid: Fluid) {
  const b = beta(p)
  return p.cd * area(b * p.diameter) * Math.sqrt((2 * Math.max(0, dp)) / (fluid.density * (1 - b ** 4)))
}

// ---- storage geometry ---------------------------------------------------------------------
// The app integrates storage itself (volume += Q·dt), so any shape works: the solver only ever sees a level.

export const TANK_SHAPES = [
  { id: 'cylinder', name: 'Vertical cylinder' },
  { id: 'cone', name: 'Cone (apex down)' },
  { id: 'sphere', name: 'Sphere' },
  { id: 'drum', name: 'Horizontal drum' },
]

/** Highest level the shape can physically hold. */
export const tankHeight = (p: Props) => (p.shape === 'sphere' || p.shape === 'drum' ? Math.min(p.maxLevel, p.diameter) : p.maxLevel)

/** Stored volume (m³) at level h. */
export function tankVolume(p: Props, level: number): number {
  const D = p.diameter
  const h = Math.min(Math.max(0, level), tankHeight(p))
  switch (p.shape) {
    case 'cone': {
      // radius grows linearly from the apex to D/2 at maxLevel
      const r = (D / 2) * (h / Math.max(1e-9, p.maxLevel))
      return (Math.PI * r * r * h) / 3
    }
    case 'sphere':
      return (Math.PI * h * h * (3 * (D / 2) - h)) / 3
    case 'drum': {
      const R = D / 2
      const seg = R * R * Math.acos(Math.min(1, Math.max(-1, (R - h) / R))) - (R - h) * Math.sqrt(Math.max(0, 2 * R * h - h * h))
      return seg * (p.length ?? 2)
    }
    default:
      return area(D) * h
  }
}

/** Level (m) that holds volume v — bisection on the monotonic volume curve. */
export function tankLevel(p: Props, v: number): number {
  let lo = 0
  let hi = tankHeight(p)
  if (v >= tankVolume(p, hi)) return hi
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (tankVolume(p, mid) < v) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// ---- pressure vessel (hydropneumatic / bladder tank) --------------------------------------------
// Gas cushion: (p + p_atm) · V_gas^n = (p_pre + p_atm) · V_total^n, with V_gas = V_total − V_water.

/** the vessel is never allowed to fill completely — the gas cushion can't be squeezed to nothing */
export const VESSEL_FILL_LIMIT = 0.92

/** Gauge pressure (Pa) of the gas cushion when the vessel holds `water` m³. */
export function vesselPressure(p: Props, water: number): number {
  const w = Math.min(Math.max(0, water), p.volume * VESSEL_FILL_LIMIT)
  return (p.precharge + P_ATM) * Math.pow(p.volume / (p.volume - w), p.polytropic ?? 1.2) - P_ATM
}
/** Water volume (m³) the vessel holds when it sits at gauge pressure `pressure`. */
export function vesselWater(p: Props, pressure: number): number {
  if (pressure <= p.precharge) return 0
  return Math.min(p.volume * VESSEL_FILL_LIMIT, p.volume * (1 - Math.pow((p.precharge + P_ATM) / (pressure + P_ATM), 1 / (p.polytropic ?? 1.2))))
}

// ---- sources ------------------------------------------------------------------------------------
// A "reservoir" is any fixed-head supply: an open water surface, a town main known by its pressure, or a well
// whose level is drawn down in proportion to what is pumped out of it.

export const SOURCE_TYPES = [
  { id: 'surface', name: 'Open water surface' },
  { id: 'mains', name: 'Mains connection (fixed pressure)' },
  { id: 'well', name: 'Well (drawdown with flow)' },
]

/** Head of the source at rest (m). */
export function sourceHead(p: Props, rhoG: number): number {
  if (p.sourceType === 'mains') return p.elevation + p.pressure / rhoG
  if (p.sourceType === 'well') return p.staticLevel
  return p.head
}
/** Elevation its pressure is quoted at: only a mains connection has any (a free surface sits at zero gauge). */
export const sourceElevation = (p: Props, head: number) => (p.sourceType === 'mains' ? p.elevation : head)
/** Drawdown (m) of a well delivering q: the datasheet point, scaled linearly (aquifer loss dominates). */
export const wellDrawdown = (p: Props, q: number) => (p.ratedDrawdown * Math.abs(q)) / Math.max(1e-9, p.ratedYield)
