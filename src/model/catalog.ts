// The data-driven part of the component library. Everything here is "an inline part that costs pressure":
// adding one is a catalogue entry, not a new component type.
//
// Two loss models cover the lot:
//   k      Δh = K · v²/2g on the part's bore — fittings. Goes to the solver as a minor-loss coefficient.
//   rated  Δp = Δp_rated · (Q/Q_rated)ⁿ / (1 − fouling)² — equipment sized from a datasheet point. n = 2 is
//          turbulent; packed beds and membranes sit nearer 1. Goes to the solver as a head-loss curve (GPV).
import type { Props } from './types'

export type Glyph = 'elbow' | 'elbow45' | 'tee' | 'reducer' | 'expander' | 'entrance' | 'exit' | 'strainer' | 'filter' | 'plate' | 'shell' | 'coil' | 'mixer' | 'membrane' | 'uv' | 'generic'

export interface LossDevice {
  id: string
  name: string
  group: 'Fittings' | 'Equipment'
  blurb: string
  prefix: string
  glyph: Glyph
  model: 'k' | 'rated'
  /** true when K follows from the two bores rather than being a catalogue number */
  byDiameters?: 'contraction' | 'expansion'
  /** dirt builds up in it: exposes the fouling slider */
  fouls?: boolean
  defaults: Props
}

const k = (id: string, name: string, prefix: string, glyph: Glyph, K: number, blurb: string): LossDevice => ({ id, name, group: 'Fittings', blurb, prefix, glyph, model: 'k', defaults: { k: K } })
const LPM = 1 / 60000
const rated = (id: string, name: string, prefix: string, glyph: Glyph, dp: number, flowLpm: number, n: number, blurb: string, fouls = false): LossDevice => ({
  id,
  name,
  group: 'Equipment',
  blurb,
  prefix,
  glyph,
  model: 'rated',
  fouls,
  defaults: { ratedDp: dp, ratedFlow: flowLpm * LPM, exponent: n, fouling: 0 },
})

export const LOSS_DEVICES: LossDevice[] = [
  k('elbow90', 'Elbow 90°', 'EL', 'elbow', 0.75, 'Standard-radius bend · K ≈ 0.75'),
  k('elbow90lr', 'Elbow 90° long-radius', 'EL', 'elbow', 0.45, 'Sweeping bend · K ≈ 0.45'),
  k('elbow90mitre', 'Elbow 90° mitred', 'EL', 'elbow', 1.3, 'Sharp corner · K ≈ 1.3'),
  k('elbow45', 'Elbow 45°', 'EL', 'elbow45', 0.35, 'Half bend · K ≈ 0.35'),
  k('tee-run', 'Tee, straight through', 'TE', 'tee', 0.4, 'Flow along the run · K ≈ 0.4'),
  k('tee-branch', 'Tee, through branch', 'TE', 'tee', 1.0, 'Flow turns into the branch · K ≈ 1.0'),
  {
    id: 'reducer',
    name: 'Reducer (sudden)',
    group: 'Fittings',
    blurb: 'K = 0.5·(1 − β²) on the small bore',
    prefix: 'RD',
    glyph: 'reducer',
    model: 'k',
    byDiameters: 'contraction',
    defaults: { d2: 0.025 },
  },
  {
    id: 'expander',
    name: 'Expander (sudden)',
    group: 'Fittings',
    blurb: 'Borda–Carnot: K = (1 − β²)²',
    prefix: 'EX',
    glyph: 'expander',
    model: 'k',
    byDiameters: 'expansion',
    defaults: { d2: 0.025 },
  },
  k('entrance', 'Pipe entrance, sharp', 'EN', 'entrance', 0.5, 'Tank into pipe · K ≈ 0.5'),
  k('entrance-round', 'Pipe entrance, bell-mouth', 'EN', 'entrance', 0.05, 'Rounded inlet · K ≈ 0.05'),
  k('exit', 'Pipe exit', 'XT', 'exit', 1.0, 'All velocity head is lost · K = 1'),
  k('custom-k', 'Custom K fitting', 'KF', 'generic', 2, 'Any part with a known K'),

  rated('strainer', 'Y-strainer', 'ST', 'strainer', 8e3, 60, 2, 'Basket clogs over time', true),
  rated('filter', 'Cartridge filter', 'FL', 'filter', 25e3, 40, 1.4, 'Fine media, fouls steadily', true),
  rated('hx-plate', 'Plate heat exchanger', 'HX', 'plate', 35e3, 60, 1.8, 'Compact, high Δp'),
  rated('hx-shell', 'Shell & tube exchanger', 'HX', 'shell', 20e3, 80, 1.9, 'Tube-side pressure drop'),
  rated('coil', 'Coil / radiator', 'CL', 'coil', 12e3, 20, 1.9, 'Heating or cooling terminal unit'),
  rated('mixer', 'Static mixer', 'MX', 'mixer', 30e3, 60, 2, 'Blending elements in the bore'),
  rated('membrane', 'Membrane / packed bed', 'MB', 'membrane', 150e3, 20, 1.05, 'Near-laminar: Δp ∝ Q', true),
  rated('uv', 'UV reactor', 'UV', 'uv', 5e3, 60, 2, 'Low-loss treatment chamber'),
  rated('custom-rated', 'Custom rated device', 'DV', 'generic', 20e3, 50, 2, 'Anything with a datasheet Δp @ Q'),
]

export const lossDevice = (variant: string) => LOSS_DEVICES.find((d) => d.id === variant) ?? LOSS_DEVICES[LOSS_DEVICES.length - 1]

// ---- valve bodies --------------------------------------------------------------------
// Fully-open loss and inherent characteristic for the common throttling bodies.

export type Trim = 'equal' | 'linear' | 'quick'
export const VALVE_BODIES: { id: string; name: string; kOpen: number; trim: Trim }[] = [
  { id: 'generic', name: 'Generic', kOpen: 2.5, trim: 'equal' },
  { id: 'gate', name: 'Gate', kOpen: 0.17, trim: 'quick' },
  { id: 'globe', name: 'Globe', kOpen: 6, trim: 'linear' },
  { id: 'ball', name: 'Ball', kOpen: 0.05, trim: 'equal' },
  { id: 'butterfly', name: 'Butterfly', kOpen: 0.45, trim: 'equal' },
  { id: 'plug', name: 'Plug', kOpen: 0.4, trim: 'equal' },
  { id: 'needle', name: 'Needle', kOpen: 9, trim: 'linear' },
  { id: 'diaphragm', name: 'Diaphragm', kOpen: 2.3, trim: 'quick' },
]
export const TRIMS: { id: Trim; name: string }[] = [
  { id: 'equal', name: 'Equal percentage' },
  { id: 'linear', name: 'Linear' },
  { id: 'quick', name: 'Quick opening' },
]

// ---- nominal pipe sizes ------------------------------------------------------------------
// Inside diameters in mm. Picking a size sets bore, material and roughness in one go.

export interface PipeStandard {
  id: string
  name: string
  material: string
  sizes: { label: string; id: number }[]
}
export const PIPE_STANDARDS: PipeStandard[] = [
  {
    id: 'steel40',
    name: 'Steel · Schedule 40',
    material: 'steel',
    sizes: [
      ['DN15 · ½″', 15.8],
      ['DN20 · ¾″', 20.9],
      ['DN25 · 1″', 26.6],
      ['DN32 · 1¼″', 35.1],
      ['DN40 · 1½″', 40.9],
      ['DN50 · 2″', 52.5],
      ['DN65 · 2½″', 62.7],
      ['DN80 · 3″', 77.9],
      ['DN100 · 4″', 102.3],
      ['DN150 · 6″', 154.1],
    ].map(([label, id]) => ({ label: label as string, id: id as number })),
  },
  {
    id: 'copperL',
    name: 'Copper · Type L',
    material: 'copper',
    sizes: [
      ['½″', 13.8],
      ['¾″', 19.9],
      ['1″', 26.0],
      ['1¼″', 32.1],
      ['1½″', 38.2],
      ['2″', 50.4],
    ].map(([label, id]) => ({ label: label as string, id: id as number })),
  },
  {
    id: 'pvc40',
    name: 'PVC · Schedule 40',
    material: 'pvc',
    sizes: [
      ['½″', 15.3],
      ['¾″', 20.4],
      ['1″', 26.0],
      ['1½″', 40.4],
      ['2″', 52.0],
      ['3″', 77.3],
      ['4″', 101.5],
    ].map(([label, id]) => ({ label: label as string, id: id as number })),
  },
  {
    id: 'pex',
    name: 'PEX · SDR 9',
    material: 'pex',
    sizes: [
      ['⅜″', 8.9],
      ['½″', 12.1],
      ['¾″', 17.1],
      ['1″', 21.9],
    ].map(([label, id]) => ({ label: label as string, id: id as number })),
  },
]

// ---- demand patterns ---------------------------------------------------------------------------
// 24 hourly multipliers on a node's base demand, each averaging ≈ 1 over the day. Lab time 00:00:00 is midnight.

export const DEMAND_PATTERNS: { id: string; name: string; factors: number[] }[] = [
  { id: 'constant', name: 'Constant', factors: Array(24).fill(1) },
  {
    id: 'residential',
    name: 'Residential (morning + evening peaks)',
    factors: [0.35, 0.28, 0.25, 0.25, 0.32, 0.6, 1.35, 1.9, 1.6, 1.2, 1.05, 1.0, 1.05, 0.95, 0.9, 0.95, 1.1, 1.45, 1.8, 1.65, 1.3, 0.95, 0.65, 0.45],
  },
  { id: 'commercial', name: 'Commercial (office hours)', factors: [0.25, 0.22, 0.2, 0.2, 0.22, 0.3, 0.6, 1.1, 1.7, 1.9, 1.9, 1.85, 1.7, 1.8, 1.85, 1.8, 1.6, 1.2, 0.8, 0.55, 0.4, 0.33, 0.28, 0.25] },
  { id: 'industrial', name: 'Industrial (two shifts)', factors: [0.5, 0.5, 0.5, 0.5, 0.5, 0.7, 1.4, 1.45, 1.45, 1.45, 1.4, 1.2, 1.4, 1.45, 1.45, 1.4, 1.4, 1.45, 1.45, 1.4, 1.35, 1.2, 0.6, 0.5] },
]

/** Multiplier at lab time t (s), interpolated between the hourly values so demand ramps rather than steps. */
export function demandFactor(patternId: string | undefined, t: number): number {
  const f = DEMAND_PATTERNS.find((x) => x.id === patternId)?.factors
  if (!f || patternId === 'constant') return 1
  const h = (((t / 3600) % 24) + 24) % 24
  const i = Math.floor(h)
  return f[i] + (f[(i + 1) % 24] - f[i]) * (h - i)
}
