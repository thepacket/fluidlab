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

/** Equal-percentage valve characteristic (rangeability 50): K rises steeply as the valve closes. */
export function valveK(opening: number, kOpen: number): number {
  const x = Math.min(1, Math.max(0, opening))
  if (x <= 0.001) return Infinity
  const relCv = Math.pow(50, x - 1)
  return kOpen / (relCv * relCv)
}

// Pump curve from a single design point, identical to EPANET's 1-point curve:
// H = s²·(4/3)·Hd − (Hd/3)·(Q/Qd)²
export function pumpHead(q: number, p: Props, speed = p.speed): number {
  return speed * speed * (4 / 3) * p.designHead - (p.designHead / 3) * (q / p.designFlow) ** 2
}
export function pumpMaxFlow(p: Props, speed = p.speed): number {
  return 2 * p.designFlow * speed
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
