// Saturated-steam properties and the small formulas a steam system is sized with. SI; temperatures in °C.
import { area } from './physics'
import type { Props } from './types'

/** Saturation line: absolute pressure (bar), t_sat (°C), v_g (m³/kg), h_f and h_fg (kJ/kg) — standard steam-table values. */
const TABLE: [number, number, number, number, number][] = [
  [0.2, 60.1, 7.649, 251.4, 2358.3],
  [0.5, 81.3, 3.24, 340.5, 2305.4],
  [1, 99.6, 1.694, 417.5, 2257.9],
  [1.5, 111.4, 1.159, 467.1, 2226.2],
  [2, 120.2, 0.8857, 504.7, 2201.6],
  [3, 133.5, 0.6058, 561.4, 2163.2],
  [4, 143.6, 0.4625, 604.7, 2133.0],
  [5, 151.8, 0.3749, 640.1, 2107.4],
  [6, 158.8, 0.3157, 670.4, 2085.0],
  [8, 170.4, 0.2404, 720.9, 2046.5],
  [10, 179.9, 0.1944, 762.6, 2013.6],
  [12, 188.0, 0.1633, 798.4, 1984.3],
  [15, 198.3, 0.1317, 844.7, 1945.2],
  [20, 212.4, 0.09963, 908.6, 1888.6],
  [25, 223.9, 0.07998, 961.9, 1839.0],
  [30, 233.8, 0.06668, 1008.4, 1793.9],
  [40, 250.3, 0.04978, 1087.4, 1712.9],
]
const LN = TABLE.map((r) => Math.log(r[0]))

/** Interpolate column `col` at absolute pressure p (Pa), linearly in ln p; specific volume is interpolated in log–log. */
function at(pAbs: number, col: 1 | 2 | 3 | 4): number {
  const x = Math.log(Math.min(40, Math.max(0.2, pAbs / 1e5)))
  let i = 0
  while (i < TABLE.length - 2 && x > LN[i + 1]) i++
  const t = (x - LN[i]) / (LN[i + 1] - LN[i])
  const [a, b] = [TABLE[i][col], TABLE[i + 1][col]]
  return col === 2 ? Math.exp(Math.log(a) + t * (Math.log(b) - Math.log(a))) : a + t * (b - a)
}

/** saturation temperature, °C */
export const tSat = (pAbs: number) => at(pAbs, 1)
/** density of dry saturated steam, kg/m³ */
export const rhoSteam = (pAbs: number) => 1 / at(pAbs, 2)
/** enthalpy of saturated water, J/kg */
export const hf = (pAbs: number) => at(pAbs, 3) * 1000
/** enthalpy of evaporation — what a kilogram of steam gives up by condensing, J/kg */
export const hfg = (pAbs: number) => at(pAbs, 4) * 1000
export const hg = (pAbs: number) => hf(pAbs) + hfg(pAbs)
/** absolute pressure (Pa) at which water boils at t °C */
export function pSat(t: number): number {
  let [lo, hi] = [0.2e5, 40e5]
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (tSat(mid) > t) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}
/** dynamic viscosity of saturated steam, Pa·s */
export const muSteam = (pAbs: number) => 1.23e-5 + 3.6e-8 * (tSat(pAbs) - 100)
/** enthalpy of liquid water at t °C, J/kg */
export const hWater = (t: number) => 4190 * t

/** Fraction of condensate that flashes back to steam when it drops from p1 to p2 (absolute). */
export const flashFraction = (p1: number, p2: number) => (p1 > p2 ? Math.max(0, (hf(p1) - hf(p2)) / hfg(p2)) : 0)
/** Temperature after throttling dry saturated steam from p1 to p2 at constant enthalpy: it comes out slightly superheated. */
export const throttledTemp = (p1: number, p2: number) => tSat(p2) + Math.max(0, hg(p1) - hg(p2)) / 2100

const K_INSULATION = 0.045 // W/m·K, mineral wool at steam temperatures
export const AMBIENT = 20
/** Heat lost per metre of steam pipe, W/m: conduction through the lagging, then convection + radiation to the room. */
export function pipeHeatLoss(p: Props, tSteam: number, ambient = AMBIENT): number {
  const dOut = p.diameter * 1.12 // wall
  const t = Math.max(0, Number(p.insulation) || 0)
  const dIns = dOut + 2 * t
  const hOut = t > 0 ? 9 : 14 // a bare hot pipe also radiates hard
  const rIns = t > 0 ? Math.log(dIns / dOut) / (2 * Math.PI * K_INSULATION) : 0
  return Math.max(0, tSteam - ambient) / (rIns + 1 / (hOut * Math.PI * dIns))
}

export const INSULATION = [
  { id: '0', name: 'Bare pipe' },
  { id: '0.025', name: '25 mm mineral wool' },
  { id: '0.05', name: '50 mm mineral wool' },
  { id: '0.08', name: '80 mm mineral wool' },
  { id: '0.1', name: '100 mm mineral wool' },
]

/** for water pipes the default is to leave heat loss out of the sums altogether */
export const WATER_INSULATION = [{ id: 'none', name: 'Not counted (ideal pipe)' }, ...INSULATION]

export const TRAP_TYPES = [
  { id: 'float', name: 'Float & thermostatic' },
  { id: 'bucket', name: 'Inverted bucket' },
  { id: 'thermodynamic', name: 'Thermodynamic (disc)' },
  { id: 'thermostatic', name: 'Balanced-pressure thermostatic' },
]
export const TRAP_STATES = [
  { id: 'ok', name: 'Working' },
  { id: 'open', name: 'Failed open — blowing steam' },
  { id: 'closed', name: 'Failed closed — blocked' },
]
/** Condensate a trap orifice can pass (kg/s) under Δp. Hot condensate flashes in the seat, so only about a third of the cold-water figure. */
export const trapCapacity = (orifice: number, dp: number) => (dp > 0 ? 0.33 * 0.6 * area(orifice) * Math.sqrt(2 * 950 * dp) : 0)

export const STEAM_LOADS: Record<string, { name: string; blurb: string; prefix: string; defaults: Props }> = {
  exchanger: { name: 'Heat exchanger', blurb: 'Shell-and-tube: steam heats a process stream', prefix: 'HX', defaults: { duty: 200e3, processTemp: 120 } },
  heater: { name: 'Unit heater', blurb: 'Fan-blown steam coil for space heating', prefix: 'UH', defaults: { duty: 30e3, processTemp: 60 } },
  kettle: { name: 'Jacketed kettle', blurb: 'Cooking vessel with a steam jacket', prefix: 'JK', defaults: { duty: 60e3, processTemp: 110 } },
  autoclave: { name: 'Autoclave', blurb: 'Sterilises at 134 °C — needs the pressure to match', prefix: 'AC', defaults: { duty: 45e3, processTemp: 134 } },
}
