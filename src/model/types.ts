// FluidLab model layer. Everything here is stored in SI (m, m³/s, Pa, kg, s).

export type Kind =
  | 'reservoir'
  | 'tank'
  | 'junction'
  | 'outlet'
  | 'gauge'
  | 'pump'
  | 'valve'
  | 'meter'
  | 'element'
  | 'dpgauge'
  | 'fitting'
  | 'relief'
  | 'vessel'
  | 'leak'
  | 'tee'
  | 'threeway'
  | 'airvalve'
  | 'jetpump'
  | 'stager'
  | 'schedule'
  | 'timer'
  | 'manual'
  | 'switch'
  | 'pid'
  | 'logic'
  | 'lamp'
  | 'sequence'
  | 'inflow'
  | 'weir'
  | 'gate'
  | 'outfall'
  | 'thermo'
  | 'steamload'
  | 'trap'

/** two-port components: compiled to a link between two hidden junctions */
export const INLINE_KINDS: Kind[] = ['pump', 'valve', 'meter', 'element', 'dpgauge', 'fitting']
/** controllers: no fluid passes through them, they switch other components over signal wires */
export const CONTROL_KINDS: Kind[] = ['timer', 'manual', 'switch', 'pid', 'logic', 'lamp', 'stager', 'schedule', 'sequence']
export const isControl = (k: Kind) => CONTROL_KINDS.includes(k)
/** components a controller can switch */
export const CONTROLLABLE: Kind[] = ['pump', 'valve', 'outlet', 'threeway', 'inflow', 'gate']
/** components that can be turned in 90° steps on the bench */
export const ROTATABLE: Kind[] = ['pump', 'valve', 'meter', 'element', 'outlet', 'fitting', 'relief']
export const isInline = (k: Kind) => INLINE_KINDS.includes(k)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Props = Record<string, any>

export interface NodeData {
  kind: Kind
  label: string
  props: Props
  /** bench rotation in degrees (0 | 90 | 180 | 270) — purely visual */
  rot?: number
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
  /** 'pipe' (default) carries fluid; 'signal' carries a controller's command */
  type?: string
  data?: PipeData
}
export interface Model {
  nodes: ModelNode[]
  edges: ModelEdge[]
  fluid: Fluid
  /** live tank levels (m), keyed by node id; falls back to initLevel */
  levels?: Record<string, number>
  /** lab time (s) — only matters to demand patterns, and is quantised so it doesn't force constant re-solves */
  time?: number
  /** 0‥1 commands from controllers, keyed by device id; absent = uncontrolled. A command scales the device's own setting. */
  controls?: Record<string, number>
}

export interface Fluid {
  id: string
  name: string
  density: number // kg/m³
  dynamicViscosity: number // Pa·s
  vaporPressure: number // Pa (absolute)
  /** present for gases: the fluid is then solved by the gas engine, and `density` is its standard density */
  gas?: { molarMass: number; gamma: number; z: number; temperature: number }
  /** saturated steam: solved by the gas engine with steam-table density, flows are mass flows (kg/s) — see engine/steam.ts */
  steam?: boolean
}

export const FLUIDS: Fluid[] = [
  { id: 'water20', name: 'Water · 20 °C', density: 998.2, dynamicViscosity: 1.002e-3, vaporPressure: 2339 },
  { id: 'water60', name: 'Water · 60 °C', density: 983.2, dynamicViscosity: 0.467e-3, vaporPressure: 19946 },
  { id: 'water90', name: 'Water · 90 °C', density: 965.3, dynamicViscosity: 0.315e-3, vaporPressure: 70182 },
  { id: 'glycol40', name: 'Glycol / water 40 %', density: 1055, dynamicViscosity: 2.9e-3, vaporPressure: 1700 },
  { id: 'diesel', name: 'Diesel', density: 832, dynamicViscosity: 2.8e-3, vaporPressure: 400 },
  { id: 'oil', name: 'Light oil · ISO 32', density: 870, dynamicViscosity: 28e-3, vaporPressure: 10 },
  // gases — density is at standard conditions (15 °C, 1 atm)
  { id: 'air', name: 'Compressed air', density: 1.225, dynamicViscosity: 1.81e-5, vaporPressure: 0, gas: { molarMass: 0.028964, gamma: 1.4, z: 1, temperature: 288.15 } },
  { id: 'natgas', name: 'Natural gas', density: 0.7359, dynamicViscosity: 1.1e-5, vaporPressure: 0, gas: { molarMass: 0.0174, gamma: 1.31, z: 0.998, temperature: 288.15 } },
  { id: 'nitrogen', name: 'Nitrogen', density: 1.1847, dynamicViscosity: 1.76e-5, vaporPressure: 0, gas: { molarMass: 0.028013, gamma: 1.4, z: 1, temperature: 288.15 } },
  { id: 'hydrogen', name: 'Hydrogen', density: 0.0853, dynamicViscosity: 8.8e-6, vaporPressure: 0, gas: { molarMass: 0.002016, gamma: 1.41, z: 1.0006, temperature: 288.15 } },
  { id: 'steam', name: 'Saturated steam', density: 1, dynamicViscosity: 1.5e-5, vaporPressure: 0, gas: { molarMass: 0.018015, gamma: 1.135, z: 0.95, temperature: 453.15 }, steam: true },
  { id: 'co2', name: 'Carbon dioxide', density: 1.8613, dynamicViscosity: 1.47e-5, vaporPressure: 0, gas: { molarMass: 0.04401, gamma: 1.29, z: 0.994, temperature: 288.15 } },
]

/** roughness in m; waveSpeed = pressure-wave celerity in a water-filled pipe of that material, m/s */
export const MATERIALS: { id: string; name: string; roughness: number; waveSpeed: number }[] = [
  { id: 'pvc', name: 'PVC', roughness: 0.0015e-3, waveSpeed: 420 },
  { id: 'copper', name: 'Copper', roughness: 0.0015e-3, waveSpeed: 1150 },
  { id: 'pex', name: 'PEX', roughness: 0.007e-3, waveSpeed: 320 },
  { id: 'stainless', name: 'Stainless steel', roughness: 0.015e-3, waveSpeed: 1250 },
  { id: 'steel', name: 'Commercial steel', roughness: 0.045e-3, waveSpeed: 1250 },
  { id: 'castiron', name: 'Cast iron', roughness: 0.26e-3, waveSpeed: 1150 },
  { id: 'hose', name: 'Hose (rubber)', roughness: 0.01e-3, waveSpeed: 250 },
  { id: 'concrete', name: 'Concrete', roughness: 1.0e-3, waveSpeed: 1050 },
  { id: 'custom', name: 'Custom', roughness: 0.05e-3, waveSpeed: 1000 },
]

export const ELEMENT_TYPES = [
  { id: 'venturi', name: 'Venturi tube' },
  { id: 'orifice', name: 'Orifice plate' },
  { id: 'nozzle', name: 'Flow nozzle' },
]

export const VALVE_TYPES = [
  { id: 'throttle', name: 'Throttle valve' },
  { id: 'check', name: 'Check valve' },
  { id: 'prv', name: 'Pressure reducing (PRV)' },
  { id: 'psv', name: 'Pressure sustaining (PSV)' },
  { id: 'fcv', name: 'Flow control (FCV)' },
  { id: 'float', name: 'Float valve (fills a tank)' },
  { id: 'picv', name: 'Pressure-independent (PICV)' },
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
  element: { name: 'Venturi / orifice', prefix: 'FE', blurb: 'Differential-pressure flow element' },
  dpgauge: { name: 'Differential gauge', prefix: 'DP', blurb: 'ΔP between two tapping points' },
  fitting: { name: 'Loss device', prefix: 'FT', blurb: 'Fittings and equipment from the catalogue' },
  vessel: { name: 'Pressure vessel', prefix: 'PV', blurb: 'Bladder tank: stores water against a gas cushion' },
  leak: { name: 'Leaky joint', prefix: 'LK', blurb: 'A junction that loses water with pressure' },
  tee: { name: 'Tee (with losses)', prefix: 'TE', blurb: 'Three-way joint: run ≈ 0.4, branch ≈ 1.0' },
  threeway: { name: 'Three-way valve', prefix: 'TV', blurb: 'Mixes A and B into AB — or diverts' },
  jetpump: { name: 'Jet pump (ejector)', prefix: 'JP', blurb: 'A motive jet entrains a second stream' },
  airvalve: { name: 'Air valve', prefix: 'AV', blurb: 'Vents air; breaks a vacuum in a surge' },
  stager: { name: 'Pump sequencer', prefix: 'SQ', blurb: 'Stages pumps on demand, rotates the lead' },
  schedule: { name: 'Setpoint scheduler', prefix: 'SC', blurb: 'Day / night value on the lab clock' },
  relief: { name: 'Relief valve', prefix: 'RV', blurb: 'Lifts above its set pressure, vents to atmosphere' },
  timer: { name: 'Timer', prefix: 'TM', blurb: 'Switches pumps, valves and taps on a schedule' },
  manual: { name: 'Manual switch', prefix: 'HS', blurb: 'Click it on the bench to start / stop' },
  switch: { name: 'Limit switch', prefix: 'SW', blurb: 'Level · pressure · flow, with hysteresis' },
  pid: { name: 'PID controller', prefix: 'IC', blurb: 'Holds a setpoint by trimming a valve or pump' },
  logic: { name: 'Logic gate', prefix: 'LG', blurb: 'AND · OR · NOT for combining signals' },
  sequence: { name: 'Event sequence', prefix: 'EV', blurb: 'Timed steps: start, stop, open, close, ramp' },
  lamp: { name: 'Alarm lamp', prefix: 'AL', blurb: 'Lights when its input is on' },
  inflow: { name: 'Channel inflow', prefix: 'IN', blurb: 'A steady discharge entering an open channel' },
  weir: { name: 'Weir', prefix: 'WR', blurb: 'Backs water up; its head tells you the flow' },
  gate: { name: 'Sluice gate', prefix: 'SG', blurb: 'Underflow gate — shoots a fast, shallow jet' },
  thermo: { name: 'Thermometer', prefix: 'TT', blurb: 'Reads water temperature at a point' },
  steamload: { name: 'Steam load', prefix: 'HX', blurb: 'Condenses steam to deliver a heat duty' },
  trap: { name: 'Steam trap', prefix: 'ST', blurb: 'Lets condensate out and keeps steam in' },
  outfall: { name: 'Outfall', prefix: 'OF', blurb: 'Where a channel ends: free drop, fixed level or normal depth' },
}

export function defaultProps(kind: Kind): Props {
  switch (kind) {
    case 'reservoir':
      return {
        temp: 15,
        feedTemp: 80,
        boilerEfficiency: 0.82,
        steamCost: 35,
        head: 10,
        sourceType: 'surface',
        pressure: 400e3,
        elevation: 0,
        staticLevel: -8,
        ratedDrawdown: 6,
        ratedYield: 60 / 60000,
      }
    case 'tank':
      return {
        stratified: false,
        heaterHeight: 0.2,
        initTemp: 15,
        heaterPower: 0,
        heaterSetpoint: 60,
        heatLoss: 0,
        overflow: false,
        elevation: 0,
        shape: 'cylinder',
        diameter: 1.2,
        length: 2,
        initLevel: 0.5,
        minLevel: 0,
        maxLevel: 2.5,
      }
    case 'junction':
      return { elevation: 0, demand: 0, pattern: 'constant' }
    case 'gauge':
    case 'thermo':
      return { elevation: 0 }
    case 'outlet':
      return { elevation: 0, mode: 'nozzle', nozzleDiameter: 0.012, cd: 0.9, demand: 0.0005, pattern: 'constant', variant: 'nozzle', kFactor: 80 / 60000 / Math.sqrt(1e5), fused: true }
    case 'pump':
      return {
        elevation: 0,
        on: true,
        speed: 1,
        designFlow: 0.001,
        designHead: 20,
        bepEfficiency: 0.68,
        npshr: 2.5,
        pumpType: 'standard',
        shutoffRatio: 4 / 3,
        runoutRatio: 2,
        reliefHead: 80,
        motorEfficiency: 0.9,
        tariff: 0.15,
        pressureRatio: 2.5,
      }
    case 'valve':
      return {
        crackPressure: 0,
        floatMode: 'modulating',
        closeLevel: 2,
        band: 0.3,
        elevation: 0,
        valveType: 'throttle',
        diameter: 0.04,
        opening: 1,
        kOpen: 2.5,
        pressureSetting: 150000,
        flowSetting: 0.0005,
        strokeTime: 0,
      }
    case 'meter':
      return { elevation: 0, diameter: 0.04, meterType: 'magnetic' }
    case 'element':
      return { elevation: 0, elementType: 'venturi', diameter: 0.04, throat: 0.02, cd: 0.98 }
    case 'dpgauge':
      return { elevation: 0 }
    case 'fitting':
      return { elevation: 0, variant: 'elbow90', diameter: 0.04, k: 0.75 }
    case 'vessel':
      return { elevation: 0, volume: 0.1, precharge: 180e3, initPressure: 250e3, polytropic: 1.2 }
    case 'leak':
      return { elevation: 0, holeDiameter: 0.004, cd: 0.6, active: true, variant: 'leak' }
    case 'tee':
      return { elevation: 0, diameter: 0.04, kRun: 0.4, kBranch: 1.0 }
    case 'threeway':
      return { elevation: 0, diameter: 0.025, position: 0.5, kOpen: 3, trim: 'linear' }
    case 'jetpump':
      return { elevation: 0, nozzleDiameter: 0.008, throatDiameter: 0.014, kn: 0.05, ktd: 0.2, ks: 0.1 }
    case 'airvalve':
      return { elevation: 0, mode: 'combination' }
    case 'stager':
      return { enabled: true, rotateEvery: 3600, trim: true, minSpeed: 0.75 }
    case 'schedule':
      return { enabled: true, dayValue: 1, nightValue: 0.5, dayStart: 6, dayEnd: 22 }
    case 'relief':
      return { elevation: 0, setPressure: 400e3, diameter: 0.025 }
    case 'timer':
      return { enabled: true, mode: 'cycle', onTime: 300, offTime: 300, startOn: true, delay: 600, action: 'on' }
    case 'manual':
      return { on: false }
    case 'switch':
      return { enabled: true, action: 'fill', low: 0.5, high: 2, pvKind: '' }
    case 'pid':
      return { enabled: true, auto: true, setpoint: 1, span: 2, kp: 0.5, ti: 30, td: 0, reverse: false, manualOut: 0.5, pvKind: '' }
    case 'logic':
      return { op: 'and' }
    case 'lamp':
      return { color: 'red' }
    case 'sequence':
      return { enabled: true, repeat: false, period: 120, steps: [] }
    case 'inflow':
      return { elevation: 1, flow: 0.1 }
    case 'weir':
      return { elevation: 0, variant: 'sharp', crestHeight: 0.3, crestWidth: 0.5, notchAngle: 90, throat: '6in' }
    case 'gate':
      return { elevation: 0, opening: 0.1, width: 0.5 }
    case 'steamload':
      return { elevation: 0, variant: 'exchanger', duty: 200e3, processTemp: 120, backPressure: 0 }
    case 'trap':
      return { elevation: 0, trapType: 'float', orifice: 0.004, state: 'ok', backPressure: 0 }
    case 'outfall':
      return { elevation: 0, mode: 'free', level: 0.5 }
  }
}

export function defaultPipeProps(): Props {
  return { length: 10, diameter: 0.04, material: 'pvc', roughness: 0.0015e-3, minorK: 0 }
}

// ---- results -------------------------------------------------------------

export interface NodeResult {
  /** anything kind-specific: a three-way valve's two leg flows, … */
  extra?: Record<string, number>
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
  // catalogue loss devices
  ratedShare?: number
  /** compressor: absolute discharge ÷ suction pressure */
  ratio?: number
  /** where a self-acting valve (float valve) has put itself, 0‥1 */
  position?: number
  // valves: flow coefficient at the current position (m³/h per √bar)
  kv?: number
  // venturi / orifice
  tapDp?: number
  permanentLoss?: number
  throatVelocity?: number
  inferredFlow?: number
}
export interface Warning {
  id?: string
  level: 'info' | 'warn' | 'error'
  text: string
}
export interface Results {
  /** solved by the gas engine: flows are standard volume flows, heads are metres of water gauge */
  gas?: boolean
  /** water temperatures and heat duties, when the rig has a boiler (see engine/thermal.ts) */
  thermal?: import('../engine/thermal').Thermal
  /** water-surface profiles of open-channel reaches (see engine/channel.ts) */
  channel?: import('../engine/channel').ChannelResults
  /** condensate, heat and trap accounting of a steam system (see engine/steam.ts) */
  steam?: import('../engine/steam').SteamResults
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
