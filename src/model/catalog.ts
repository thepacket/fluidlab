// The data-driven part of the component library. Everything here is "an inline part that costs pressure":
// adding one is a catalogue entry, not a new component type.
//
// Two loss models cover the lot:
//   k      Δh = K · v²/2g on the part's bore — fittings. Goes to the solver as a minor-loss coefficient.
//   rated  Δp = Δp_rated · (Q/Q_rated)ⁿ / (1 − fouling)² — equipment sized from a datasheet point. n = 2 is
//          turbulent; packed beds and membranes sit nearer 1. Goes to the solver as a head-loss curve (GPV).
import { weirType } from './openchannel'
import { STEAM_LOADS } from './steam'
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
  byDiameters?: 'contraction' | 'expansion' | 'taper' | 'diffuser'
  /** fraction of the hydraulic power it takes out that comes back as shaft power (turbines) */
  recovers?: number
  /** dirt builds up in it: exposes the fouling slider */
  fouls?: boolean
  defaults: Props
}

const k = (id: string, name: string, prefix: string, glyph: Glyph, K: number, blurb: string): LossDevice => ({ id, name, group: 'Fittings', blurb, prefix, glyph, model: 'k', defaults: { k: K } })
const LPM = 1 / 60000
const rated = (id: string, name: string, prefix: string, glyph: Glyph, dp: number, flowLpm: number, n: number, blurb: string, fouls = false, thermal: Props = {}): LossDevice => ({
  id,
  name,
  group: 'Equipment',
  blurb,
  prefix,
  glyph,
  model: 'rated',
  fouls,
  defaults: { ratedDp: dp, ratedFlow: flowLpm * LPM, exponent: n, fouling: 0, ...thermal },
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
  {
    id: 'taper',
    name: 'Reducer (tapered)',
    group: 'Fittings',
    blurb: 'Concentric taper · a tenth of the sudden loss',
    prefix: 'RD',
    glyph: 'reducer',
    model: 'k',
    byDiameters: 'taper',
    defaults: { d2: 0.025 },
  },
  {
    id: 'diffuser',
    name: 'Expander (tapered diffuser)',
    group: 'Fittings',
    blurb: '≈ 7° cone · K = 0.3·(1 − β²)²',
    prefix: 'EX',
    glyph: 'expander',
    model: 'k',
    byDiameters: 'diffuser',
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
  rated('coil', 'Coil / radiator', 'CL', 'coil', 12e3, 20, 1.9, 'Heating or cooling terminal unit', false, { ratedHeat: 5000, roomTemp: 20 }),
  rated('mixer', 'Static mixer', 'MX', 'mixer', 30e3, 60, 2, 'Blending elements in the bore'),
  rated('membrane', 'Membrane / packed bed', 'MB', 'membrane', 150e3, 20, 1.05, 'Near-laminar: Δp ∝ Q', true),
  rated('uv', 'UV reactor', 'UV', 'uv', 5e3, 60, 2, 'Low-loss treatment chamber'),
  rated('boiler', 'Boiler / chiller', 'BL', 'shell', 10e3, 30, 2, 'Heat source — sets the flow temperature', false, { supplyTemp: 70 }),
  rated('radiator', 'Radiator', 'RA', 'coil', 6e3, 3, 1.9, 'Panel radiator with its lockshield', false, { ratedHeat: 1500, roomTemp: 20 }),
  rated('cyclone', 'Hydrocyclone', 'CY', 'mixer', 80e3, 60, 2, 'Separates solids by swirl — and pays for it'),
  rated('watermeter', 'Water meter (revenue)', 'WM', 'generic', 25e3, 50, 2, 'Mechanical meter: a real restriction'),
  rated('injector', 'Venturi injector', 'IJ', 'mixer', 60e3, 30, 2, 'Draws in additive using ≈ 30 % of the inlet pressure'),
  { ...rated('turbine', 'Turbine / pump-as-turbine', 'TB', 'shell', 150e3, 100, 2, 'Takes head out of the water and returns it as power'), recovers: 0.7 },
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
  { id: 'pinch', name: 'Pinch', kOpen: 0.1, trim: 'linear' },
  { id: 'balancing', name: 'Balancing (double-regulating)', kOpen: 4, trim: 'linear' },
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
    id: 'hose',
    name: 'Hose (rubber / lay-flat)',
    material: 'hose',
    sizes: [
      ['13 mm garden', 12.7],
      ['19 mm', 19],
      ['25 mm reel', 25],
      ['38 mm', 38],
      ['45 mm attack', 45],
      ['65 mm supply', 65],
    ].map(([label, id]) => ({ label: label as string, id: id as number })),
  },
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

// ---- pump types ----------------------------------------------------------------------------
// Curve shapes as ratios of the duty point: shut-off head / duty head, and run-out flow / duty flow.

export const PUMP_TYPES: { id: string; name: string; shutoffRatio: number; runoutRatio: number }[] = [
  { id: 'standard', name: 'End-suction centrifugal', shutoffRatio: 4 / 3, runoutRatio: 2 },
  { id: 'fire', name: 'Fire pump (NFPA 20 shape)', shutoffRatio: 1.2, runoutRatio: 2.2 },
  { id: 'multistage', name: 'Multistage (steep)', shutoffRatio: 1.6, runoutRatio: 1.6 },
  { id: 'circulator', name: 'Circulator (flat)', shutoffRatio: 1.15, runoutRatio: 2.5 },
  { id: 'custom', name: 'Catalogue curve (enter points)', shutoffRatio: 4 / 3, runoutRatio: 2 },
  { id: 'pd', name: 'Positive displacement', shutoffRatio: 4 / 3, runoutRatio: 2 },
]

// ---- discharge devices ---------------------------------------------------------------------
// Everything that lets water out to atmosphere is an `outlet`; these entries preset it. K-factor devices obey
// Q = K·√p, which is exactly the solver's emitter — sprinkler hydraulics need no new physics at all.

const K = (lpmPerRootBar: number) => lpmPerRootBar / 60000 / Math.sqrt(1e5) // → m³/s per √Pa

export type DischargeGlyph = 'nozzle' | 'sprinkler' | 'hydrant' | 'hose' | 'drip' | 'rotor' | 'tap' | 'shower'
export interface DischargeDevice {
  id: string
  name: string
  group: 'Fire protection' | 'Irrigation' | 'Fixtures'
  blurb: string
  prefix: string
  glyph: DischargeGlyph
  /** bench rotation it is dropped with — sprinklers hang, so their inlet is on top */
  rot?: number
  defaults: Props
}
export const DISCHARGE_DEVICES: DischargeDevice[] = [
  {
    id: 'spk57',
    name: 'Sprinkler K57 (½″, K 4.0)',
    group: 'Fire protection',
    blurb: 'Light hazard · closed until it fuses',
    prefix: 'SP',
    glyph: 'sprinkler',
    rot: 90,
    defaults: { mode: 'kfactor', kFactor: K(57), fused: false },
  },
  {
    id: 'spk80',
    name: 'Sprinkler K80 (½″, K 5.6)',
    group: 'Fire protection',
    blurb: 'The standard spray head',
    prefix: 'SP',
    glyph: 'sprinkler',
    rot: 90,
    defaults: { mode: 'kfactor', kFactor: K(80), fused: false },
  },
  {
    id: 'spk115',
    name: 'Sprinkler K115 (¾″, K 8.0)',
    group: 'Fire protection',
    blurb: 'Ordinary / extra hazard',
    prefix: 'SP',
    glyph: 'sprinkler',
    rot: 90,
    defaults: { mode: 'kfactor', kFactor: K(115), fused: false },
  },
  {
    id: 'spk200',
    name: 'Sprinkler K200 (K 14 ESFR)',
    group: 'Fire protection',
    blurb: 'Storage — huge flow per head',
    prefix: 'SP',
    glyph: 'sprinkler',
    rot: 90,
    defaults: { mode: 'kfactor', kFactor: K(200), fused: false },
  },
  { id: 'hosereel', name: 'Hose reel', group: 'Fire protection', blurb: 'First-aid hose · K ≈ 28', prefix: 'HR', glyph: 'hose', defaults: { mode: 'kfactor', kFactor: K(28) } },
  { id: 'landing', name: 'Standpipe hose valve 65 mm', group: 'Fire protection', blurb: 'Landing valve · K ≈ 430', prefix: 'LV', glyph: 'hydrant', defaults: { mode: 'kfactor', kFactor: K(430) } },
  { id: 'hydrant', name: 'Hydrant outlet 65 mm', group: 'Fire protection', blurb: 'Open butt · K ≈ 1500', prefix: 'HY', glyph: 'hydrant', defaults: { mode: 'kfactor', kFactor: K(1500) } },
  // K chosen so each fixture gives its usual flow at 1 bar
  { id: 'basin', name: 'Basin tap', group: 'Fixtures', blurb: '≈ 6 L/min at 1 bar', prefix: 'TP', glyph: 'tap', defaults: { mode: 'kfactor', kFactor: K(6) } },
  { id: 'kitchen', name: 'Kitchen tap', group: 'Fixtures', blurb: '≈ 10 L/min at 1 bar', prefix: 'TP', glyph: 'tap', defaults: { mode: 'kfactor', kFactor: K(10) } },
  { id: 'shower', name: 'Shower', group: 'Fixtures', blurb: '≈ 9 L/min at 1 bar', prefix: 'SH', glyph: 'shower', defaults: { mode: 'kfactor', kFactor: K(9) } },
  { id: 'bath', name: 'Bath filler', group: 'Fixtures', blurb: '≈ 18 L/min at 1 bar', prefix: 'BT', glyph: 'tap', defaults: { mode: 'kfactor', kFactor: K(18) } },
  { id: 'wc', name: 'WC fill valve', group: 'Fixtures', blurb: 'Cistern refill · ≈ 5 L/min at 1 bar', prefix: 'WC', glyph: 'tap', defaults: { mode: 'kfactor', kFactor: K(5) } },
  { id: 'appliance', name: 'Washing machine', group: 'Fixtures', blurb: 'Solenoid inlet · ≈ 8 L/min at 1 bar', prefix: 'WM', glyph: 'tap', defaults: { mode: 'kfactor', kFactor: K(8) } },
  { id: 'garden', name: 'Garden tap', group: 'Fixtures', blurb: '≈ 20 L/min at 1 bar', prefix: 'GT', glyph: 'tap', defaults: { mode: 'kfactor', kFactor: K(20) } },
  {
    id: 'drip',
    name: 'Drip emitter 4 L/h',
    group: 'Irrigation',
    blurb: 'Simple orifice dripper — flow follows pressure',
    prefix: 'DR',
    glyph: 'drip',
    rot: 90,
    defaults: { mode: 'kfactor', kFactor: K(4 / 60) },
  },
  {
    id: 'drip-pc',
    name: 'Drip emitter 4 L/h, compensating',
    group: 'Irrigation',
    blurb: 'Diaphragm holds the flow constant',
    prefix: 'DR',
    glyph: 'drip',
    rot: 90,
    defaults: { mode: 'demand', demand: 4 / 3.6e6 },
  },
  { id: 'spray', name: 'Spray head', group: 'Irrigation', blurb: 'Fixed fan · K ≈ 5', prefix: 'SH', glyph: 'rotor', defaults: { mode: 'kfactor', kFactor: K(5) } },
  { id: 'rotor', name: 'Rotor sprinkler', group: 'Irrigation', blurb: 'Gear-driven, long throw · K ≈ 12', prefix: 'RT', glyph: 'rotor', defaults: { mode: 'kfactor', kFactor: K(12) } },
]
export const dischargeDevice = (variant?: string) => DISCHARGE_DEVICES.find((d) => d.id === variant)

const LPM_ = 1 / 60000
/** Pumps and valves that are an ordinary component with telling defaults. */
export const PUMP_PRESETS: Record<string, { prefix: string; defaults: Props; name: string; blurb: string }> = {
  jockey: {
    prefix: 'JP',
    name: 'Jockey pump',
    blurb: 'Small, high head: tops up a fire main',
    defaults: { designFlow: 20 * LPM_, designHead: 85, pumpType: 'multistage', shutoffRatio: 1.6, runoutRatio: 1.6 },
  },
  submersible: {
    prefix: 'BP',
    name: 'Borehole pump',
    blurb: 'Multistage, hangs below the water level',
    defaults: { designFlow: 60 * LPM_, designHead: 60, elevation: -20, pumpType: 'multistage', shutoffRatio: 1.6, runoutRatio: 1.6, npshr: 1 },
  },
  dosing: {
    prefix: 'DP',
    name: 'Positive-displacement pump',
    blurb: 'Near-constant flow, with an internal relief',
    defaults: { designFlow: 15 * LPM_, designHead: 60, reliefHead: 80, pumpType: 'pd', bepEfficiency: 0.85 },
  },
}
export const VALVE_PRESETS: Record<string, { prefix: string; defaults: Props; name: string; blurb: string }> = {
  foot: { prefix: 'FV', name: 'Foot valve', blurb: 'Check valve + strainer on a suction pipe', defaults: { valveType: 'check', kOpen: 3.5, crackPressure: 2e3 } },
  springcheck: { prefix: 'CV', name: 'Spring check valve', blurb: 'Opens only above its cracking pressure', defaults: { valveType: 'check', kOpen: 2, crackPressure: 15e3 } },
  dcv: { prefix: 'BF', name: 'Backflow preventer (double check)', blurb: 'Two spring checks in series · ≈ 35 kPa', defaults: { valveType: 'check', kOpen: 4, crackPressure: 35e3 } },
  rpz: { prefix: 'BF', name: 'Backflow preventer (RPZ)', blurb: 'Reduced-pressure zone · ≈ 70 kPa', defaults: { valveType: 'check', kOpen: 6, crackPressure: 70e3 } },
  solenoid: { prefix: 'SV', name: 'Solenoid valve', blurb: 'On/off — wire a controller to it', defaults: { valveType: 'throttle', body: 'diaphragm', kOpen: 2.3, trim: 'quick' } },
  picv: { prefix: 'PI', name: 'Pressure-independent control valve', blurb: 'Flow follows its position, whatever the Δp', defaults: { valveType: 'picv', flowSetting: 20 * LPM_ } },
}

/** What a catalogue-backed kind should be dropped with: label prefix, preset props, initial rotation. */
export function catalogueSpec(kind: string, variant?: string): { prefix: string; defaults: Props; rot?: number } | undefined {
  if (!variant) return undefined
  if (kind === 'fitting') {
    const d = lossDevice(variant)
    return { prefix: d.prefix, defaults: { variant: d.id, ...d.defaults } }
  }
  if (kind === 'steamload' && STEAM_LOADS[variant]) return { prefix: STEAM_LOADS[variant].prefix, defaults: { variant, ...STEAM_LOADS[variant].defaults } }
  if (kind === 'weir') {
    const w = weirType(variant)
    return { prefix: w.prefix, defaults: { variant: w.id, ...w.defaults } }
  }
  if (kind === 'leak' && variant === 'burst') return { prefix: 'BR', defaults: { variant: 'burst', holeDiameter: 0.04, active: false } }
  if (kind === 'manual' && variant === 'estop') return { prefix: 'ES', defaults: { on: true, style: 'estop' } }
  if (kind === 'pump' && PUMP_PRESETS[variant]) return PUMP_PRESETS[variant]
  if (kind === 'valve' && VALVE_PRESETS[variant]) return VALVE_PRESETS[variant]
  if (kind === 'outlet') {
    const d = dischargeDevice(variant)
    return d && { prefix: d.prefix, defaults: { variant: d.id, ...d.defaults }, rot: d.rot }
  }
  return undefined
}
