// FluidLab model layer. Everything here is stored in SI (m, m³/s, Pa, kg, s).

export type Kind = 'reservoir' | 'tank' | 'junction' | 'outlet' | 'gauge' | 'pump' | 'valve' | 'meter'

export const INLINE_KINDS: Kind[] = ['pump', 'valve', 'meter']
export const isInline = (k: Kind) => INLINE_KINDS.includes(k)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Props = Record<string, any>

export interface NodeData {
  kind: Kind
  label: string
  props: Props
  [k: string]: unknown
}

export interface PipeData {
  label: string
  props: Props
  [k: string]: unknown
}

export interface ModelNode {
  id: string
  data: NodeData
}
export interface ModelEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  data?: PipeData
}
export interface Model {
  nodes: ModelNode[]
  edges: ModelEdge[]
  fluid: Fluid
  /** live tank levels (m), keyed by node id; falls back to initLevel */
  levels?: Record<string, number>
}

export interface Fluid {
  id: string
  name: string
  density: number // kg/m³
  dynamicViscosity: number // Pa·s
  vaporPressure: number // Pa (absolute)
}

export const FLUIDS: Fluid[] = [
  { id: 'water20', name: 'Water · 20 °C', density: 998.2, dynamicViscosity: 1.002e-3, vaporPressure: 2339 },
  { id: 'water60', name: 'Water · 60 °C', density: 983.2, dynamicViscosity: 0.467e-3, vaporPressure: 19946 },
  { id: 'water90', name: 'Water · 90 °C', density: 965.3, dynamicViscosity: 0.315e-3, vaporPressure: 70182 },
  { id: 'glycol40', name: 'Glycol / water 40 %', density: 1055, dynamicViscosity: 2.9e-3, vaporPressure: 1700 },
  { id: 'diesel', name: 'Diesel', density: 832, dynamicViscosity: 2.8e-3, vaporPressure: 400 },
  { id: 'oil', name: 'Light oil · ISO 32', density: 870, dynamicViscosity: 28e-3, vaporPressure: 10 },
]

export const MATERIALS: { id: string; name: string; roughness: number }[] = [
  { id: 'pvc', name: 'PVC', roughness: 0.0015e-3 },
  { id: 'copper', name: 'Copper', roughness: 0.0015e-3 },
  { id: 'pex', name: 'PEX', roughness: 0.007e-3 },
  { id: 'stainless', name: 'Stainless steel', roughness: 0.015e-3 },
  { id: 'steel', name: 'Commercial steel', roughness: 0.045e-3 },
  { id: 'castiron', name: 'Cast iron', roughness: 0.26e-3 },
  { id: 'concrete', name: 'Concrete', roughness: 1.0e-3 },
  { id: 'custom', name: 'Custom', roughness: 0.05e-3 },
]

export const VALVE_TYPES = [
  { id: 'throttle', name: 'Throttle valve' },
  { id: 'check', name: 'Check valve' },
  { id: 'prv', name: 'Pressure reducing (PRV)' },
  { id: 'psv', name: 'Pressure sustaining (PSV)' },
  { id: 'fcv', name: 'Flow control (FCV)' },
]

export const KIND_META: Record<Kind, { name: string; prefix: string; blurb: string }> = {
  reservoir: { name: 'Reservoir', prefix: 'R', blurb: 'Infinite source at fixed head' },
  tank: { name: 'Tank', prefix: 'T', blurb: 'Storage with a moving level' },
  junction: { name: 'Junction', prefix: 'J', blurb: 'Tee / pipe joint' },
  outlet: { name: 'Outlet', prefix: 'O', blurb: 'Nozzle or tap to atmosphere' },
  gauge: { name: 'Pressure gauge', prefix: 'PG', blurb: 'Reads pressure at a point' },
  pump: { name: 'Pump', prefix: 'P', blurb: 'Centrifugal, with H(Q) curve' },
  valve: { name: 'Valve', prefix: 'V', blurb: 'Throttle · check · PRV · PSV · FCV' },
  meter: { name: 'Flow meter', prefix: 'FM', blurb: 'Inline flow readout' },
}

export function defaultProps(kind: Kind): Props {
  switch (kind) {
    case 'reservoir':
      return { head: 10 }
    case 'tank':
      return { elevation: 0, diameter: 1.2, initLevel: 0.5, minLevel: 0, maxLevel: 2.5 }
    case 'junction':
      return { elevation: 0, demand: 0 }
    case 'gauge':
      return { elevation: 0 }
    case 'outlet':
      return { elevation: 0, mode: 'nozzle', nozzleDiameter: 0.012, cd: 0.9, demand: 0.0005 }
    case 'pump':
      return { elevation: 0, on: true, speed: 1, designFlow: 0.001, designHead: 20, bepEfficiency: 0.68, npshr: 2.5 }
    case 'valve':
      return { elevation: 0, valveType: 'throttle', diameter: 0.04, opening: 1, kOpen: 2.5, pressureSetting: 150000, flowSetting: 0.0005 }
    case 'meter':
      return { elevation: 0, diameter: 0.04 }
  }
}

export function defaultPipeProps(): Props {
  return { length: 10, diameter: 0.04, material: 'pvc', roughness: 0.0015e-3, minorK: 0 }
}

// ---- results -------------------------------------------------------------

export interface NodeResult {
  head: number
  pressure: number // Pa gauge
  elevation: number
  /** net flow leaving the network here (m³/s): outlet discharge, tank inflow, -reservoir supply */
  outflow: number
}
export interface LinkResult {
  flow: number // m³/s, + = source → target
  velocity: number
  headloss: number // m, in flow direction
  dp: number // Pa, in flow direction
  re: number
  f: number
  regime: 'still' | 'laminar' | 'transitional' | 'turbulent'
  pStart: number // Pa at source end
  pEnd: number
}
export interface DeviceResult {
  flow: number
  headIn: number
  headOut: number
  pIn: number
  pOut: number
  /** head gained across the device (negative = loss) */
  dH: number
  status: 'open' | 'closed' | 'active'
  // pump
  efficiency?: number
  hydraulicPower?: number
  shaftPower?: number
  npsha?: number
  // valve
  K?: number
  velocity?: number
}
export interface Warning {
  id?: string
  level: 'info' | 'warn' | 'error'
  text: string
}
export interface Results {
  ok: boolean
  error?: string
  warnings: Warning[]
  nodes: Record<string, NodeResult>
  links: Record<string, LinkResult>
  devices: Record<string, DeviceResult>
  excluded: string[]
  solveMs: number
  pMin: number
  pMax: number
  vMax: number
}

export const EMPTY_RESULTS: Results = {
  ok: false,
  warnings: [],
  nodes: {},
  links: {},
  devices: {},
  excluded: [],
  solveMs: 0,
  pMin: 0,
  pMax: 1,
  vMax: 1,
}
