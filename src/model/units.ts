// Units engine: SI internally → conversion → display. Never store display units.

export type Quantity = 'length' | 'diameter' | 'roughness' | 'pressure' | 'flow' | 'head' | 'velocity' | 'power' | 'time' | 'volume' | 'kfactor' | 'none' | 'percent'

interface UnitDef {
  id: string
  label: string
  /** SI value = display value × factor */
  factor: number
}

export const UNITS: Record<Exclude<Quantity, 'none' | 'percent'>, UnitDef[]> = {
  length: [
    { id: 'm', label: 'm', factor: 1 },
    { id: 'ft', label: 'ft', factor: 0.3048 },
  ],
  head: [
    { id: 'm', label: 'm', factor: 1 },
    { id: 'ft', label: 'ft', factor: 0.3048 },
  ],
  diameter: [
    { id: 'mm', label: 'mm', factor: 1e-3 },
    { id: 'cm', label: 'cm', factor: 1e-2 },
    { id: 'm', label: 'm', factor: 1 },
    { id: 'in', label: 'in', factor: 0.0254 },
  ],
  roughness: [
    { id: 'mm', label: 'mm', factor: 1e-3 },
    { id: 'in', label: 'in', factor: 0.0254 },
  ],
  pressure: [
    { id: 'kPa', label: 'kPa', factor: 1e3 },
    { id: 'Pa', label: 'Pa', factor: 1 },
    { id: 'MPa', label: 'MPa', factor: 1e6 },
    { id: 'bar', label: 'bar', factor: 1e5 },
    { id: 'psi', label: 'psi', factor: 6894.757 },
    { id: 'mH2O', label: 'm H₂O', factor: 9806.65 },
    { id: 'ftH2O', label: 'ft H₂O', factor: 2989.067 },
  ],
  flow: [
    { id: 'L/min', label: 'L/min', factor: 1 / 60000 },
    { id: 'L/s', label: 'L/s', factor: 1e-3 },
    { id: 'm3/h', label: 'm³/h', factor: 1 / 3600 },
    { id: 'm3/s', label: 'm³/s', factor: 1 },
    { id: 'GPM', label: 'GPM', factor: 6.30902e-5 },
  ],
  velocity: [
    { id: 'm/s', label: 'm/s', factor: 1 },
    { id: 'ft/s', label: 'ft/s', factor: 0.3048 },
  ],
  kfactor: [
    { id: 'lpm', label: 'L/min/√bar', factor: 1 / 60000 / Math.sqrt(1e5) },
    { id: 'gpm', label: 'gpm/√psi', factor: 6.30902e-5 / Math.sqrt(6894.757) },
  ],
  volume: [
    { id: 'L', label: 'L', factor: 1e-3 },
    { id: 'm3', label: 'm³', factor: 1 },
    { id: 'gal', label: 'US gal', factor: 3.785412e-3 },
  ],
  time: [
    { id: 's', label: 's', factor: 1 },
    { id: 'min', label: 'min', factor: 60 },
    { id: 'h', label: 'h', factor: 3600 },
  ],
  power: [
    { id: 'W', label: 'W', factor: 1 },
    { id: 'kW', label: 'kW', factor: 1e3 },
    { id: 'hp', label: 'hp', factor: 745.6999 },
  ],
}

export type UnitPrefs = Record<keyof typeof UNITS, string>

export const METRIC: UnitPrefs = {
  length: 'm',
  head: 'm',
  diameter: 'mm',
  roughness: 'mm',
  pressure: 'kPa',
  flow: 'L/min',
  velocity: 'm/s',
  power: 'W',
  time: 'min',
  volume: 'L',
  kfactor: 'lpm',
}
export const US: UnitPrefs = {
  length: 'ft',
  head: 'ft',
  diameter: 'in',
  roughness: 'in',
  pressure: 'psi',
  flow: 'GPM',
  velocity: 'ft/s',
  power: 'hp',
  time: 'min',
  volume: 'gal',
  kfactor: 'gpm',
}

function def(q: Quantity, prefs: UnitPrefs): UnitDef {
  if (q === 'none') return { id: '', label: '', factor: 1 }
  if (q === 'percent') return { id: '%', label: '%', factor: 0.01 }
  const list = UNITS[q]
  return list.find((u) => u.id === prefs[q]) ?? list[0]
}

export const toDisplay = (si: number, q: Quantity, prefs: UnitPrefs) => si / def(q, prefs).factor
export const toSI = (v: number, q: Quantity, prefs: UnitPrefs) => v * def(q, prefs).factor
export const unitLabel = (q: Quantity, prefs: UnitPrefs) => def(q, prefs).label

/** Compact number formatting tuned for instrument readouts. */
export function fmtNum(v: number, sig = 3): string {
  if (!isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2)
  if (a >= 1000) return Math.round(v).toLocaleString('en-US')
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(a)))
  return v.toFixed(Math.min(digits, 4))
}

export function fmt(si: number | undefined, q: Quantity, prefs: UnitPrefs, sig = 3): string {
  if (si === undefined || !isFinite(si)) return '—'
  return fmtNum(toDisplay(si, q, prefs), sig)
}

export function fmtU(si: number | undefined, q: Quantity, prefs: UnitPrefs, sig = 3): string {
  const u = unitLabel(q, prefs)
  return `${fmt(si, q, prefs, sig)}${u ? ' ' + u : ''}`
}
