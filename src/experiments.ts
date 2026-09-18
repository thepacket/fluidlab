// The "Lab" part of FluidLab: ready-made rigs with something to discover.
import type { Edge, Node } from '@xyflow/react'
import type { TransientResult } from './engine/transient'
import { defaultChannelProps } from './model/openchannel'
import { KIND_META, defaultPipeProps, defaultProps, isInline, type Kind, type NodeData, type PipeData, type Props, type Results } from './model/types'

export const NODE_SIZE: Record<Kind, [number, number]> = {
  reservoir: [132, 96],
  tank: [112, 136],
  junction: [26, 26],
  outlet: [76, 64],
  gauge: [88, 88],
  pump: [100, 100],
  valve: [92, 76],
  meter: [104, 56],
  element: [120, 64],
  dpgauge: [96, 96],
  vessel: [92, 124],
  tee: [56, 56],
  threeway: [92, 84],
  airvalve: [60, 72],
  jetpump: [132, 84],
  stager: [108, 84],
  schedule: [96, 84],
  leak: [44, 44],
  fitting: [96, 64],
  relief: [84, 64],
  timer: [96, 104],
  manual: [84, 84],
  switch: [92, 88],
  pid: [116, 104],
  logic: [76, 64],
  lamp: [60, 68],
  thermo: [72, 88],
  steamload: [124, 84],
  trap: [64, 72],
  inflow: [104, 84],
  weir: [112, 88],
  gate: [112, 96],
  outfall: [104, 84],
}

/** vertical position (fraction of height) of the side ports for each kind */
export const PORT_Y: Record<Kind, number> = {
  reservoir: 0.7,
  tank: 0.86,
  junction: 0.5,
  outlet: 0.5,
  gauge: 0.5,
  pump: 0.5,
  valve: 0.5,
  meter: 0.5,
  element: 0.5,
  dpgauge: 0.8,
  vessel: 0.86,
  tee: 0.5,
  threeway: 0.4524,
  airvalve: 0.833,
  jetpump: 0.405,
  stager: 0.5,
  schedule: 0.5,
  leak: 0.5,
  fitting: 0.5,
  relief: 0.5,
  timer: 0.54,
  manual: 0.5,
  switch: 0.5,
  pid: 0.5,
  logic: 0.5,
  lamp: 0.5,
  thermo: 0.78,
  steamload: 0.5,
  trap: 0.5,
  inflow: 0.72,
  weir: 0.72,
  gate: 0.72,
  outfall: 0.72,
}

export type LabNode = Node<NodeData>
export type LabEdge = Edge<PipeData>

export interface GoalState {
  done: boolean
  readout: string
}
export interface Experiment {
  id: string
  no: string
  title: string
  concept: string
  formula?: string
  brief: string
  steps: string[]
  goal?: { text: string; check: (r: Results, nodes: LabNode[], levels: Record<string, number>, history: { t: number; v: Record<string, number> }[], surge?: TransientResult | null) => GoalState }
  fluidId?: string
  timeScale?: number
  /** 'live' marches water temperatures through lab time instead of showing where they settle */
  heatMode?: 'steady' | 'live'
  autoRun?: boolean
  select?: string
  build: () => { nodes: LabNode[]; edges: LabEdge[] }
}

const LPM = 1 / 60000

class Rig {
  nodes: LabNode[] = []
  edges: LabEdge[] = []
  /** x, y are the centre of the component */
  add(id: string, kind: Kind, x: number, y: number, props: Props = {}, label?: string) {
    const [w, h] = NODE_SIZE[kind]
    const count = this.nodes.filter((n) => n.data.kind === kind).length + 1
    this.nodes.push({
      id,
      type: kind,
      position: { x: x - w / 2, y: y - h * PORT_Y[kind] },
      data: { kind, label: label ?? `${KIND_META[kind].prefix}${count}`, props: { ...defaultProps(kind), ...props } },
    })
    return this
  }
  pipe(source: string, target: string, props: Props = {}, handles: [string?, string?] = [], label?: string) {
    const s = this.nodes.find((n) => n.id === source)!
    const t = this.nodes.find((n) => n.id === target)!
    const id = `e${this.edges.length + 1}`
    this.edges.push({
      id,
      type: 'pipe',
      source,
      target,
      sourceHandle: handles[0] ?? (isInline(s.data.kind) ? 'out' : 'r'),
      targetHandle: handles[1] ?? (isInline(t.data.kind) ? 'in' : 'l'),
      data: { label: label ?? `Pipe ${this.edges.length + 1}`, props: { ...defaultPipeProps(), ...props } },
    })
    return this
  }
  /** open-channel reach: water runs from `source` to `target` */
  channel(source: string, target: string, props: Props = {}, handles: [string?, string?] = [], label?: string) {
    const two = (id: string) => ['weir', 'gate'].includes(this.nodes.find((n) => n.id === id)!.data.kind)
    const count = this.edges.filter((e) => e.data?.props.conduit === 'channel').length + 1
    this.edges.push({
      id: `e${this.edges.length + 1}`,
      type: 'pipe',
      source,
      target,
      sourceHandle: handles[0] ?? (two(source) ? 'out' : 'r'),
      targetHandle: handles[1] ?? (two(target) ? 'in' : 'l'),
      data: { label: label ?? `Reach ${count}`, props: { ...defaultChannelProps(), ...props } },
    })
    return this
  }
  /** turn a rotatable part (degrees, multiples of 90) */
  turn(id: string, rot: number) {
    this.nodes.find((n) => n.id === id)!.data.rot = rot
    return this
  }
  /** signal wire: `pv` → `cin` for a measurement, `sig` → `ctl` / `cin` for a command */
  wire(source: string, target: string, handles: [string, string] = ['sig', 'ctl']) {
    this.edges.push({ id: `s${this.edges.length + 1}`, type: 'signal', source, sourceHandle: handles[0], target, targetHandle: handles[1] })
    return this
  }
  done() {
    return { nodes: this.nodes, edges: this.edges }
  }
}

type History = { t: number; v: Record<string, number> }[]

/** Minutes, counting back from now, that `key` has stayed inside [lo, hi] without a break. */
function heldFor(history: History, key: string, lo: number, hi: number) {
  if (!history.length) return 0
  const now = history[history.length - 1].t
  let since = now
  for (let i = history.length - 1; i >= 0; i--) {
    const v = history[i].v[key]
    if (v === undefined || v < lo || v > hi) break
    since = history[i].t
  }
  return (now - since) / 60
}

/** Share of the last `windowS` lab-seconds that `key` spent inside [lo, hi] — null until that much has been recorded. */
function shareInBand(history: History, key: string, lo: number, hi: number, windowS: number) {
  if (!history.length) return null
  const now = history[history.length - 1].t
  const recent = history.filter((h) => h.t > now - windowS && h.v[key] !== undefined)
  if (!recent.length || now - history[0].t < windowS * 0.97) return null
  return recent.filter((h) => h.v[key] >= lo && h.v[key] <= hi).length / recent.length
}

const flowGoal = (deviceOrLink: string, target: number, tolerance: number) => (r: Results) => {
  const q = Math.abs(r.devices[deviceOrLink]?.flow ?? r.nodes[deviceOrLink]?.outflow ?? 0) / LPM
  return { done: Math.abs(q - target) <= tolerance, readout: `${q.toFixed(1)} L/min` }
}

export const EXPERIMENTS: Experiment[] = [
  {
    id: 'gravity',
    no: '01',
    title: 'Gravity feed',
    concept: 'Bernoulli · static head',
    formula: 'Q = Cd · A · √(2g·h)',
    brief: 'A header tank drives water through a nozzle using nothing but elevation. Pressure at the gauge is just the weight of the water column above it, minus what friction eats on the way.',
    steps: ['Select the header tank and raise its water level (head).', 'Watch the gauge: every metre of head adds ≈ 9.8 kPa.', 'Notice the flow grows with the square root of head, not linearly.'],
    goal: { text: 'Raise the header tank until the nozzle delivers 40 L/min', check: flowGoal('out', 40, 1) },
    select: 'src',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 120, 140, { head: 1.5 }, 'Header tank')
        .add('g', 'gauge', 470, 330, {}, 'PG1')
        .add('out', 'outlet', 800, 330, { nozzleDiameter: 0.012 }, 'Nozzle')
        .pipe('src', 'g', { length: 12, diameter: 0.025, material: 'copper' }, ['b', 'l'])
        .pipe('g', 'out', { length: 6, diameter: 0.025, material: 'copper' })
        .done(),
  },
  {
    id: 'reynolds',
    no: '02',
    title: 'Laminar vs turbulent',
    concept: 'Reynolds number',
    formula: 'Re = ρ·v·D / μ',
    brief: 'Osborne Reynolds’ experiment, in a 6 mm tube. At low speed the flow slides in smooth layers and loss grows linearly with flow. Past Re ≈ 4000 it tumbles, and loss grows with the square.',
    steps: [
      'Select the tube and read Re and the regime in the inspector.',
      'Raise the supply head slowly and watch the ΔP(Q) curve bend.',
      'Try the light-oil fluid: the same rig stays laminar far longer.',
    ],
    goal: {
      text: 'Raise the supply head until the tube turns fully turbulent (Re > 4000)',
      check: (r) => {
        const re = r.links['e1']?.re ?? 0
        return { done: re > 4000, readout: `Re = ${Math.round(re).toLocaleString('en-US')}` }
      },
    },
    select: 'e1',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 130, 250, { head: 0.08 }, 'Constant-head')
        .add('out', 'outlet', 760, 250, { nozzleDiameter: 0.006, cd: 0.98 }, 'Open end')
        .pipe('src', 'out', { length: 5, diameter: 0.006, material: 'pex', roughness: 0.007e-3 }, [], 'Glass tube')
        .done(),
  },
  {
    id: 'friction',
    no: '03',
    title: 'Pipe materials',
    concept: 'Darcy–Weisbach friction',
    formula: 'h_f = f · (L/D) · v² / 2g',
    brief: 'Three identical runs — same length, same bore, same supply — differing only in wall roughness. The rougher the wall, the higher the friction factor and the less each branch delivers.',
    steps: ['Compare the three flow meters.', 'Click each pipe: compare f and head loss.', 'Swap cast iron for concrete, or shrink a bore by 20 % — which hurts more?'],
    build: () =>
      new Rig()
        .add('src', 'reservoir', 120, 300, { head: 12 }, 'Supply')
        .add('j', 'junction', 300, 300)
        .add('m1', 'meter', 560, 120, { diameter: 0.025 }, 'PVC')
        .add('m2', 'meter', 560, 300, { diameter: 0.025 }, 'Steel')
        .add('m3', 'meter', 560, 480, { diameter: 0.025 }, 'Cast iron')
        .add('o1', 'outlet', 820, 120, { nozzleDiameter: 0.025 })
        .add('o2', 'outlet', 820, 300, { nozzleDiameter: 0.025 })
        .add('o3', 'outlet', 820, 480, { nozzleDiameter: 0.025 })
        .pipe('src', 'j', { length: 2, diameter: 0.08 })
        .pipe('j', 'm1', { length: 40, diameter: 0.025, material: 'pvc', roughness: 0.0015e-3 }, ['t', 'in'], 'PVC run')
        .pipe('j', 'm2', { length: 40, diameter: 0.025, material: 'steel', roughness: 0.045e-3 }, ['r', 'in'], 'Steel run')
        .pipe('j', 'm3', { length: 40, diameter: 0.025, material: 'castiron', roughness: 0.26e-3 }, ['b', 'in'], 'Cast-iron run')
        .pipe('m1', 'o1', { length: 0.5, diameter: 0.025 })
        .pipe('m2', 'o2', { length: 0.5, diameter: 0.025 })
        .pipe('m3', 'o3', { length: 0.5, diameter: 0.025 })
        .done(),
  },
  {
    id: 'series',
    no: '04',
    title: 'Pipes in series',
    concept: 'Losses add, flow is shared',
    formula: 'h_total = h₁ + h₂ + h₃',
    brief: 'One flow passes through three bores in turn. Since loss scales roughly with 1/D⁵, the narrowest section dominates everything. Open the Grade line tab to see the head staircase.',
    steps: ['Read the pressure gauges along the run.', 'Open the “Grade line” chart.', 'Widen the DN15 section to 25 mm and watch the whole system wake up.'],
    select: 'e3',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 110, 260, { head: 15 }, 'Supply')
        .add('g1', 'gauge', 360, 260)
        .add('g2', 'gauge', 600, 260)
        .add('out', 'outlet', 860, 260, { nozzleDiameter: 0.02 })
        .pipe('src', 'g1', { length: 20, diameter: 0.04 }, [], 'DN40')
        .pipe('g1', 'g2', { length: 20, diameter: 0.025 }, [], 'DN25')
        .pipe('g2', 'out', { length: 20, diameter: 0.015 }, [], 'DN15')
        .done(),
  },
  {
    id: 'parallel',
    no: '05',
    title: 'Pipes in parallel',
    concept: 'Equal loss, split flow',
    formula: 'h₁ = h₂   ·   Q = Q₁ + Q₂',
    brief: 'Two branches join the same pair of junctions, so both must lose exactly the same head. The flow divides itself to make that true — the wide branch takes the lion’s share.',
    steps: ['Compare the two flow meters.', 'Click each branch: identical head loss, very different flow.', 'Throttle the valve in the wide branch and watch flow migrate.'],
    build: () =>
      new Rig()
        .add('src', 'reservoir', 100, 300, { head: 10 }, 'Supply')
        .add('j1', 'junction', 270, 300)
        .add('v', 'valve', 440, 150, { diameter: 0.04, kOpen: 0.5 })
        .add('m1', 'meter', 640, 150, { diameter: 0.04 }, 'Wide')
        .add('m2', 'meter', 540, 450, { diameter: 0.02 }, 'Narrow')
        .add('j2', 'junction', 810, 300)
        .add('out', 'outlet', 960, 300, { nozzleDiameter: 0.03 })
        .pipe('src', 'j1', { length: 3, diameter: 0.05 })
        .pipe('j1', 'v', { length: 15, diameter: 0.04 }, ['t', 'in'], 'DN40 branch')
        .pipe('v', 'm1', { length: 1, diameter: 0.04 })
        .pipe('m1', 'j2', { length: 15, diameter: 0.04 }, ['out', 't'])
        .pipe('j1', 'm2', { length: 15, diameter: 0.02 }, ['b', 'in'], 'DN20 branch')
        .pipe('m2', 'j2', { length: 15, diameter: 0.02 }, ['out', 'b'])
        .pipe('j2', 'out', { length: 3, diameter: 0.05 })
        .done(),
  },
  {
    id: 'throttle',
    no: '06',
    title: 'Valve throttling',
    concept: 'Minor losses',
    formula: 'h_L = K · v² / 2g',
    brief: 'A valve is a variable obstacle: its loss coefficient K climbs steeply as it closes. The two gauges straddle it, so their difference is the pressure the valve is burning.',
    steps: ['Select the valve and drag its opening slider.', 'Watch K, the two gauges and the flow respond together.', 'Notice how little happens between 100 % and 60 % — and how much below 30 %.'],
    goal: { text: 'Throttle the valve until the outlet delivers 25 L/min', check: flowGoal('out', 25, 1) },
    select: 'v',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 100, 250, { head: 25 }, 'Supply')
        .add('g1', 'gauge', 330, 250)
        .add('v', 'valve', 500, 250, { diameter: 0.025, kOpen: 4 })
        .add('g2', 'gauge', 670, 250)
        .add('out', 'outlet', 900, 250, { nozzleDiameter: 0.014 })
        .pipe('src', 'g1', { length: 10, diameter: 0.025 })
        .pipe('g1', 'v', { length: 0.5, diameter: 0.025 })
        .pipe('v', 'g2', { length: 0.5, diameter: 0.025 })
        .pipe('g2', 'out', { length: 10, diameter: 0.025 })
        .done(),
  },
  {
    id: 'pump',
    no: '07',
    title: 'Pump operating point',
    concept: 'Pump curve × system curve',
    formula: 'H_pump(Q) = H_static + k·Q²',
    brief: 'A pump does not “make” a pressure — it lands wherever its curve crosses the system’s. Closing the valve steepens the system curve and the operating point slides up the pump curve.',
    steps: [
      'Select the pump to see both curves and the live operating point.',
      'Throttle the valve: the orange system curve rotates upward.',
      'Try the pump’s speed slider instead — a far cheaper way to cut flow.',
    ],
    goal: { text: 'Adjust the valve until the flow meter reads 60 L/min', check: flowGoal('m', 60, 1.5) },
    select: 'p',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 100, 420, { head: 1 }, 'Sump')
        .add('p', 'pump', 300, 420, { designFlow: 80 * LPM, designHead: 18 })
        .add('g', 'gauge', 470, 420)
        .add('v', 'valve', 640, 420, { diameter: 0.04, kOpen: 3 })
        .add('m', 'meter', 820, 420, { diameter: 0.04 })
        .add('dst', 'reservoir', 1010, 170, { head: 7 }, 'Roof tank')
        .pipe('src', 'p', { length: 3, diameter: 0.05 })
        .pipe('p', 'g', { length: 2, diameter: 0.04 })
        .pipe('g', 'v', { length: 2, diameter: 0.04 })
        .pipe('v', 'm', { length: 2, diameter: 0.04 })
        .pipe('m', 'dst', { length: 25, diameter: 0.04 }, ['out', 'b'])
        .done(),
  },
  {
    id: 'pumps-series',
    no: '08',
    title: 'Pumps in series',
    concept: 'Heads add',
    formula: 'H = H₁ + H₂  at the same Q',
    brief: 'The roof tank sits 30 m up, but one pump shuts off at about 27 m — it spins and delivers nothing. A second pump in series stacks its head on top of the first.',
    steps: ['Pump 1 is dead-headed: check its warning.', 'Select booster P2 and switch it on.', 'Compare the gauge between the pumps with the one after them.'],
    goal: { text: 'Get at least 40 L/min up to the roof tank', check: (r) => ({ done: (r.devices['m']?.flow ?? 0) / LPM >= 40, readout: `${((r.devices['m']?.flow ?? 0) / LPM).toFixed(1)} L/min` }) },
    select: 'p2',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 100, 460, { head: 1 }, 'Sump')
        .add('p1', 'pump', 290, 460, { designFlow: 70 * LPM, designHead: 20 })
        .add('g1', 'gauge', 450, 460)
        .add('p2', 'pump', 610, 460, { designFlow: 70 * LPM, designHead: 20, on: false })
        .add('g2', 'gauge', 770, 460)
        .add('m', 'meter', 930, 460, { diameter: 0.04 })
        .add('dst', 'reservoir', 1100, 170, { head: 30 }, 'Roof tank')
        .pipe('src', 'p1', { length: 3, diameter: 0.05 })
        .pipe('p1', 'g1', { length: 2, diameter: 0.04 })
        .pipe('g1', 'p2', { length: 2, diameter: 0.04 })
        .pipe('p2', 'g2', { length: 2, diameter: 0.04 })
        .pipe('g2', 'm', { length: 2, diameter: 0.04 })
        .pipe('m', 'dst', { length: 35, diameter: 0.04 }, ['out', 'b'])
        .done(),
  },
  {
    id: 'pumps-parallel',
    no: '09',
    title: 'Pumps in parallel',
    concept: 'Flows add — but never double',
    formula: 'Q = Q₁ + Q₂  at the same H',
    brief: 'Switching on a second identical pump does not double the flow: the extra flow raises friction, the system curve climbs, and both pumps back up their curves.',
    steps: ['Note the flow with one pump running.', 'Switch on P2 and compare — what did you actually gain?', 'Widen the long discharge pipe to 80 mm and try again.'],
    select: 'p2',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 320, { head: 2 }, 'Sump')
        .add('j1', 'junction', 250, 320)
        .add('p1', 'pump', 440, 180, { designFlow: 100 * LPM, designHead: 16 })
        .add('p2', 'pump', 440, 460, { designFlow: 100 * LPM, designHead: 16, on: false })
        .add('j2', 'junction', 630, 320)
        .add('m', 'meter', 790, 320, { diameter: 0.05 })
        .add('out', 'outlet', 1020, 320, { nozzleDiameter: 0.03, elevation: 3 }, 'Discharge')
        .pipe('src', 'j1', { length: 2, diameter: 0.08 })
        .pipe('j1', 'p1', { length: 2, diameter: 0.05 }, ['t', 'in'])
        .pipe('j1', 'p2', { length: 2, diameter: 0.05 }, ['b', 'in'])
        .pipe('p1', 'j2', { length: 2, diameter: 0.05 }, ['out', 't'])
        .pipe('p2', 'j2', { length: 2, diameter: 0.05 }, ['out', 'b'])
        .pipe('j2', 'm', { length: 1, diameter: 0.05 })
        .pipe('m', 'out', { length: 120, diameter: 0.05, material: 'steel', roughness: 0.045e-3 }, [], 'Long main')
        .done(),
  },
  {
    id: 'tank',
    no: '10',
    title: 'Tank filling',
    concept: 'Mass balance over time',
    formula: 'A · dh/dt = Q_in − Q_out',
    brief: 'A pump fills an elevated tank while a tap drains it. The level settles wherever inflow equals outflow — and as the tank fills, its rising head pushes back on the pump. Time runs at 60×.',
    steps: ['Press play (top bar) if the clock is paused.', 'Open the drain valve and find the equilibrium level.', 'Select the tank to see its level trend.'],
    goal: {
      text: 'Hold the tank level between 70 % and 80 % with the drain valve open at least 20 %',
      check: (r, nodes, levels) => {
        const t = nodes.find((n) => n.id === 't')
        const v = nodes.find((n) => n.id === 'v')
        const pct = t ? ((levels['t'] ?? t.data.props.initLevel) / t.data.props.maxLevel) * 100 : 0
        const steady = Math.abs(r.nodes['t']?.outflow ?? 1) / LPM < 1.5
        return { done: pct >= 70 && pct <= 80 && steady && (v?.data.props.opening ?? 0) >= 0.2, readout: `${pct.toFixed(0)} %${steady ? ' · steady' : ''}` }
      },
    },
    timeScale: 60,
    autoRun: true,
    select: 't',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 100, 440, { head: 1 }, 'Well')
        .add('p', 'pump', 290, 440, { designFlow: 50 * LPM, designHead: 9 })
        .add('t', 'tank', 540, 200, { elevation: 6, diameter: 1, initLevel: 0.3, maxLevel: 2.4 }, 'Tower')
        .add('v', 'valve', 760, 440, { diameter: 0.025, opening: 0.15, kOpen: 3 }, 'Drain')
        .add('out', 'outlet', 960, 440, { nozzleDiameter: 0.016 }, 'Tap')
        .pipe('src', 'p', { length: 3, diameter: 0.04 })
        .pipe('p', 't', { length: 12, diameter: 0.032 }, ['out', 'l'])
        .pipe('t', 'v', { length: 10, diameter: 0.025 }, ['r', 'in'])
        .pipe('v', 'out', { length: 4, diameter: 0.025 })
        .done(),
  },
  {
    id: 'cavitation',
    no: '11',
    title: 'Cavitation',
    concept: 'NPSH available vs required',
    formula: 'NPSHa = (P_in + P_atm − P_vap) / ρg',
    brief:
      'This pump sits 5.5 m above its sump and sucks through a long, skinny pipe. Absolute pressure at its inlet falls towards the vapour pressure of the water — bubbles form and implode on the impeller.',
    steps: ['Select the pump: compare NPSHa with NPSHr.', 'Fix it: fatten the suction pipe, lower the pump, or throttle the discharge.', 'Make it worse: switch the fluid to 60 °C water.'],
    goal: {
      text: 'Clear the cavitation warning while keeping at least 50 L/min',
      check: (r, nodes) => {
        const d = r.devices['p']
        const npshr = nodes.find((n) => n.id === 'p')?.data.props.npshr ?? 0
        return { done: !!d && (d.npsha ?? 0) >= npshr && d.flow / LPM >= 50, readout: `NPSHa ${(d?.npsha ?? 0).toFixed(1)} m` }
      },
    },
    select: 'p',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 110, 470, { head: -5.5 }, 'Sump')
        .add('p', 'pump', 470, 220, { designFlow: 70 * LPM, designHead: 22, npshr: 3 })
        .add('v', 'valve', 680, 220, { diameter: 0.04 })
        .add('out', 'outlet', 900, 220, { nozzleDiameter: 0.015 })
        .pipe('src', 'p', { length: 12, diameter: 0.032, material: 'steel', roughness: 0.045e-3 }, ['r', 'in'], 'Suction')
        .pipe('p', 'v', { length: 3, diameter: 0.04 })
        .pipe('v', 'out', { length: 8, diameter: 0.04 })
        .done(),
  },
  {
    id: 'prv',
    no: '12',
    title: 'Pressure regulation',
    concept: 'Pressure-reducing valve',
    brief: 'The main runs at nearly 400 kPa — too much for household fittings. A PRV throttles itself automatically to hold its downstream side at a setpoint, whatever the demand.',
    steps: ['Compare the gauges before and after the PRV.', 'Select the tap and change its nozzle size: PG2 barely moves.', 'Change the PRV setpoint, or switch the valve type to “Flow control”.'],
    select: 'v',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 100, 260, { head: 40 }, 'Town main')
        .add('g1', 'gauge', 330, 260)
        .add('v', 'valve', 500, 260, { valveType: 'prv', pressureSetting: 150000, diameter: 0.025, kOpen: 1 }, 'PRV')
        .add('g2', 'gauge', 670, 260)
        .add('out', 'outlet', 900, 260, { nozzleDiameter: 0.01 }, 'Tap')
        .pipe('src', 'g1', { length: 30, diameter: 0.032 })
        .pipe('g1', 'v', { length: 0.5, diameter: 0.025 })
        .pipe('v', 'g2', { length: 0.5, diameter: 0.025 })
        .pipe('g2', 'out', { length: 8, diameter: 0.02 })
        .done(),
  },
  {
    id: 'siphon',
    no: '13',
    title: 'Siphon',
    concept: 'Flow over a crest, below atmospheric',
    formula: 'p_crest = ρg · (H − z_crest)',
    brief:
      'Water climbs over a crest higher than its own source because the falling leg pulls it along. The price is pressure: the crest runs below atmospheric, and if its absolute pressure reaches the vapour pressure the column boils apart and the siphon breaks.',
    steps: [
      'Select the crest gauge: its pressure is already negative (magenta pipes).',
      'Raise the crest elevation a metre at a time and watch the pressure fall ≈ 9.8 kPa per metre.',
      'Find the limit — around 10 m above the source surface for cold water. Try 60 °C water.',
    ],
    goal: {
      text: 'Raise the crest until its pressure sits between −70 and −85 kPa — without breaking the siphon',
      check: (r) => {
        const p = (r.nodes['crest']?.pressure ?? 0) / 1000
        return { done: p <= -70 && p >= -85 && (r.nodes['out']?.outflow ?? 0) > 1e-6, readout: `${p.toFixed(1)} kPa` }
      },
    },
    select: 'crest',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 120, 360, { head: 3 }, 'Upper pond')
        .add('crest', 'gauge', 480, 140, { elevation: 4.5 }, 'Crest')
        .add('v', 'valve', 760, 470, { diameter: 0.032, kOpen: 1 })
        .add('out', 'outlet', 960, 470, { nozzleDiameter: 0.02, elevation: 0 }, 'Outfall')
        .pipe('src', 'crest', { length: 8, diameter: 0.032 }, ['r', 'l'], 'Rising leg')
        .pipe('crest', 'v', { length: 12, diameter: 0.032 }, ['r', 'in'], 'Falling leg')
        .pipe('v', 'out', { length: 1, diameter: 0.032 })
        .done(),
  },
  {
    id: 'venturi',
    no: '14',
    title: 'Venturi meter',
    concept: 'Bernoulli as a flow meter',
    formula: 'Q = Cd · A_t · √( 2Δp / ρ(1 − β⁴) )',
    brief:
      'Squeeze the flow through a throat and it must speed up; Bernoulli says its pressure drops. Read that differential and you know the flow — and because the long diffuser recovers almost all of it, the meter costs very little head. (Network solvers only track piezometric head, so FluidLab computes the throat differential from Bernoulli and hands the solver only the permanent loss.)',
    steps: [
      'Select the Venturi: compare its inferred flow with the turbine meter downstream.',
      'Halve the flow with the valve — the differential falls to a quarter.',
      'Shrink the throat: a bigger signal, but watch for throat cavitation.',
    ],
    goal: {
      text: 'Throttle the valve until the Venturi differential reads 10 kPa',
      check: (r) => {
        const dp = (r.devices['fe']?.tapDp ?? 0) / 1000
        return { done: Math.abs(dp - 10) <= 0.5, readout: `Δp ${dp.toFixed(1)} kPa` }
      },
    },
    select: 'fe',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 100, 300, { head: 8 }, 'Supply')
        .add('fe', 'element', 360, 300, { elementType: 'venturi', diameter: 0.04, throat: 0.02, cd: 0.98 }, 'Venturi')
        .add('m', 'meter', 580, 300, { diameter: 0.04 })
        .add('v', 'valve', 770, 300, { diameter: 0.04, kOpen: 2 })
        .add('out', 'outlet', 980, 300, { nozzleDiameter: 0.018 })
        .pipe('src', 'fe', { length: 6, diameter: 0.04 })
        .pipe('fe', 'm', { length: 2, diameter: 0.04 })
        .pipe('m', 'v', { length: 2, diameter: 0.04 })
        .pipe('v', 'out', { length: 4, diameter: 0.04 })
        .done(),
  },
  {
    id: 'orifice',
    no: '15',
    title: 'Orifice meter',
    concept: 'Cheap to buy, expensive to run',
    formula: 'Δp_permanent ≈ Δp_taps · (1 − β¹·⁹)',
    brief:
      'An orifice plate gives the same kind of differential as a Venturi, but the jet leaving the hole dissipates in turbulence instead of being recovered. The element shows its tap differential; the differential gauge DP1, tapped well upstream and downstream, shows what is lost for good.',
    steps: [
      'Compare the plate’s tap Δp with the permanent loss on DP1.',
      'Select the element and switch its type to “Venturi tube” (Cd ≈ 0.98).',
      'Same signal principle, a fraction of the pumping cost.',
    ],
    goal: {
      text: 'Get the permanent loss on DP1 below 3 kPa while still passing at least 70 L/min',
      check: (r) => {
        const d = r.devices['dp']
        const loss = d ? (d.pIn - d.pOut) / 1000 : 0
        const q = (r.devices['fe']?.flow ?? 0) / LPM
        return { done: !!d && loss < 3 && q >= 70, readout: `${loss.toFixed(1)} kPa · ${q.toFixed(0)} L/min` }
      },
    },
    select: 'fe',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 420, { head: 10 }, 'Supply')
        .add('a', 'junction', 300, 420, {}, 'Tap A')
        .add('fe', 'element', 500, 420, { elementType: 'orifice', diameter: 0.04, throat: 0.024, cd: 0.61 }, 'Orifice')
        .add('b', 'junction', 700, 420, {}, 'Tap B')
        .add('dp', 'dpgauge', 500, 215, {}, 'DP1')
        .add('out', 'outlet', 940, 420, { nozzleDiameter: 0.015 })
        .pipe('src', 'a', { length: 5, diameter: 0.04 })
        .pipe('a', 'fe', { length: 0.5, diameter: 0.04 })
        .pipe('fe', 'b', { length: 0.5, diameter: 0.04 })
        .pipe('b', 'out', { length: 5, diameter: 0.04 })
        .pipe('a', 'dp', { length: 1, diameter: 0.006 }, ['t', 'in'], 'Sense HI')
        .pipe('b', 'dp', { length: 1, diameter: 0.006 }, ['t', 'out'], 'Sense LO')
        .done(),
  },
  {
    id: 'timer',
    no: '16',
    title: 'Timed pumping',
    concept: 'Duty cycling with a timer',
    formula: 'duty = t_on / (t_on + t_off)',
    brief:
      'Nobody stands by the pump: a timer switches it over a violet signal wire. The tower fills while the pump runs and drains while it rests, so the level saw-tooths. The duty cycle sets where the level settles on average; the cycle length sets how far it swings.',
    steps: [
      'Select the timer and watch its schedule and the pump follow it.',
      'The default 20 min cycle swings the level too far. Shorten it.',
      'Then trim the on/off ratio until the average sits mid-tank. Select the tower to watch its trend.',
    ],
    goal: {
      text: 'Tune the timer so the tower stays between 35 % and 65 % for 20 lab-minutes',
      check: (_r, nodes, levels, history) => {
        const tank = nodes.find((n) => n.id === 't')
        if (!tank || !history.length) return { done: false, readout: '—' }
        const max = tank.data.props.maxLevel
        const now = history[history.length - 1].t
        // how long has the level been inside the band, counting back from now?
        let since = now
        for (let i = history.length - 1; i >= 0; i--) {
          const f = (history[i].v['t'] ?? 0) / max
          if (f < 0.35 || f > 0.65) break
          since = history[i].t
        }
        const held = (now - since) / 60
        const pct = ((levels['t'] ?? tank.data.props.initLevel) / max) * 100
        return { done: held >= 20, readout: `${pct.toFixed(0)} % · ${Math.min(20, held).toFixed(0)}/20 min` }
      },
    },
    timeScale: 60,
    select: 'tm',
    build: () => {
      const rig = new Rig()
        .add('src', 'reservoir', 100, 470, { head: 1 }, 'Well')
        .add('p', 'pump', 300, 470, { designFlow: 50 * LPM, designHead: 9 })
        .add('tm', 'timer', 130, 190, { onTime: 600, offTime: 600, startOn: true }, 'Timer')
        .add('t', 'tank', 560, 230, { elevation: 6, diameter: 1, initLevel: 1.2, maxLevel: 2.4 }, 'Tower')
        .add('v', 'valve', 780, 470, { diameter: 0.025, opening: 0.45, kOpen: 3 }, 'Demand')
        .add('out', 'outlet', 980, 470, { nozzleDiameter: 0.016 }, 'Town')
        .pipe('src', 'p', { length: 3, diameter: 0.04 })
        .pipe('p', 't', { length: 12, diameter: 0.032 }, ['out', 'l'])
        .pipe('t', 'v', { length: 10, diameter: 0.025 }, ['r', 'in'])
        .pipe('v', 'out', { length: 4, diameter: 0.025 })
      rig.edges.push({ id: 's1', type: 'signal', source: 'tm', sourceHandle: 'sig', target: 'p', targetHandle: 'ctl' })
      return rig.done()
    },
  },
  {
    id: 'level-switch',
    no: '17',
    title: 'Level switch',
    concept: 'On/off control with hysteresis',
    formula: 'ON below low · OFF above high · hold in between',
    brief:
      'A timer pumps blind; a level switch pumps because the tank needs it. The green wire carries the tower’s level to the switch, the violet wire carries its decision to the pump. The gap between the two thresholds — the hysteresis — is what stops the pump chattering on and off.',
    steps: [
      'Select LS1 and watch the level bounce between its thresholds on the Loop chart.',
      'Narrow the band: the level holds tighter, but count how often the pump now starts.',
      'Open the demand valve further — the switch simply runs the pump for longer. A timer could not do that.',
    ],
    goal: {
      text: 'Set the thresholds so the tower stays between 40 % and 70 % for 20 lab-minutes',
      check: (_r, nodes, levels, history) => {
        const tank = nodes.find((n) => n.id === 't')
        if (!tank) return { done: false, readout: '—' }
        const max = tank.data.props.maxLevel
        const held = heldFor(history, 't', 0.4 * max, 0.7 * max)
        const pct = ((levels['t'] ?? tank.data.props.initLevel) / max) * 100
        return { done: held >= 20, readout: `${pct.toFixed(0)} % · ${Math.min(20, held).toFixed(0)}/20 min` }
      },
    },
    timeScale: 60,
    select: 'ls',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 100, 470, { head: 1 }, 'Well')
        .add('p', 'pump', 300, 470, { designFlow: 50 * LPM, designHead: 9 })
        .add('ls', 'switch', 800, 240, { action: 'fill', low: 0.3, high: 2.2, pvKind: 'tank' }, 'LS1')
        .add('t', 'tank', 560, 250, { elevation: 6, diameter: 1, initLevel: 1.2, maxLevel: 2.4 }, 'Tower')
        .add('v', 'valve', 780, 470, { diameter: 0.025, opening: 0.45, kOpen: 3 }, 'Demand')
        .add('out', 'outlet', 980, 470, { nozzleDiameter: 0.016 }, 'Town')
        .pipe('src', 'p', { length: 3, diameter: 0.04 })
        .pipe('p', 't', { length: 12, diameter: 0.032 }, ['out', 'l'])
        .pipe('t', 'v', { length: 10, diameter: 0.025 }, ['r', 'in'])
        .pipe('v', 'out', { length: 4, diameter: 0.025 })
        .wire('t', 'ls', ['pv', 'cin'])
        .wire('ls', 'p')
        .done(),
  },
  {
    id: 'pressure-pid',
    no: '18',
    title: 'Constant-pressure booster',
    concept: 'PID control of a variable-speed pump',
    formula: 'out = Kp·e + (Kp/Ti)·∫e dt',
    brief:
      'A timer opens and shuts a big consumer every 90 seconds. The pressure transmitter feeds a PID controller that trims the pump’s speed to hold 250 kPa through it all. As delivered, the loop is far too lazy: pressure sags and surges for most of each cycle.',
    steps: [
      'Select PIC1: watch pressure against setpoint, and the output below it.',
      'Shorten Ti to a second or two and nudge Kp up until the pressure snaps back after each step.',
      'Go too far and it hunts. Every real loop has that edge — find it, then back off.',
    ],
    goal: {
      text: 'Tune PIC1 so the header stays within 250 ± 15 kPa for 85 % of the last 5 lab-minutes',
      check: (r, _n, _l, history) => {
        const share = shareInBand(history, 'pt', 235e3, 265e3, 300)
        const now = (r.nodes['pt']?.pressure ?? 0) / 1000
        return { done: share !== null && share >= 0.85, readout: `${now.toFixed(0)} kPa · ${share === null ? 'recording…' : `${(share * 100).toFixed(0)} % in band`}` }
      },
    },
    timeScale: 10,
    select: 'pic',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 470, { head: 2 }, 'Break tank')
        .add('p', 'pump', 280, 470, { designFlow: 90 * LPM, designHead: 24, speed: 1.4 })
        .add('pt', 'gauge', 470, 470, {}, 'PT1')
        .add('pic', 'pid', 330, 210, { setpoint: 250e3, span: 500e3, kp: 0.15, ti: 120, pvKind: 'gauge' }, 'PIC1')
        .add('j', 'junction', 640, 470)
        .add('o1', 'outlet', 900, 360, { nozzleDiameter: 0.009 }, 'Base load')
        .add('o2', 'outlet', 900, 580, { nozzleDiameter: 0.011 }, 'Big user')
        .add('tm', 'timer', 700, 700, { onTime: 90, offTime: 90, startOn: false }, 'Shift')
        .pipe('src', 'p', { length: 3, diameter: 0.05 })
        .pipe('p', 'pt', { length: 2, diameter: 0.04 })
        .pipe('pt', 'j', { length: 10, diameter: 0.04 })
        .pipe('j', 'o1', { length: 8, diameter: 0.025 }, ['t', 'l'])
        .pipe('j', 'o2', { length: 8, diameter: 0.025 }, ['b', 'l'])
        .wire('pt', 'pic', ['pv', 'cin'])
        .wire('pic', 'p')
        .wire('tm', 'o2')
        .done(),
  },
  {
    id: 'flow-pid',
    no: '19',
    title: 'Flow control loop',
    concept: 'A motorised valve under PID',
    formula: 'valve position = output × opening',
    brief:
      'The flow transmitter, the controller and a motorised valve make a classic flow loop. The valve needs 20 s to stroke end to end, and its equal-percentage trim makes the loop lively when nearly shut and sluggish when wide open — which is why flow loops are tuned gently.',
    steps: [
      'FIC1 starts in MANUAL at 100 %. Select it and switch it to automatic.',
      'Watch the valve travel (its stroke time is on the valve) until the flow settles at the setpoint.',
      'Now disturb it: raise the supply head, or change the setpoint, and watch the loop recover.',
    ],
    goal: {
      text: 'Put FIC1 in automatic and hold 40 ± 1.5 L/min for 3 lab-minutes',
      check: (r, nodes, _l, history) => {
        const auto = !!nodes.find((n) => n.id === 'fic')?.data.props.auto
        const held = heldFor(history, 'ft', 38.5 * LPM, 41.5 * LPM)
        return { done: auto && held >= 3, readout: `${(Math.abs(r.devices['ft']?.flow ?? 0) / LPM).toFixed(1)} L/min · ${Math.min(3, held).toFixed(1)}/3 min` }
      },
    },
    timeScale: 10,
    select: 'fic',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 100, 440, { head: 20 }, 'Supply')
        .add('ft', 'meter', 340, 440, { diameter: 0.025 }, 'FT1')
        .add('fic', 'pid', 470, 190, { auto: false, manualOut: 1, setpoint: 40 * LPM, span: 100 * LPM, kp: 0.3, ti: 20, pvKind: 'meter' }, 'FIC1')
        .add('v', 'valve', 620, 440, { diameter: 0.025, kOpen: 4, strokeTime: 20 }, 'FV1')
        .add('out', 'outlet', 880, 440, { nozzleDiameter: 0.014 })
        .pipe('src', 'ft', { length: 10, diameter: 0.025 })
        .pipe('ft', 'v', { length: 2, diameter: 0.025 })
        .pipe('v', 'out', { length: 10, diameter: 0.025 })
        .wire('ft', 'fic', ['pv', 'cin'])
        .wire('fic', 'v')
        .done(),
  },
  {
    id: 'fittings',
    no: '20',
    title: 'Fittings add up',
    concept: 'Minor losses are not always minor',
    formula: 'h_L = ΣK · v² / 2g',
    brief:
      'Eleven metres of pipe and four bends. Click the pipes, then the elbows: in a short, fast run the bends cost more than the pipe does. Each part comes from the catalogue, so you can swap it for a gentler one without touching the layout.',
    steps: ['Select an elbow: compare its Δp with a whole pipe section.', 'Change its catalogue part from “mitred” to “long-radius”.', 'Do all four — the pipework has not changed, but the flow has.'],
    goal: {
      text: 'Without changing any pipe, get the flow meter above 47 L/min',
      check: (r, nodes) => {
        const q = Math.abs(r.devices['m']?.flow ?? 0) / LPM
        const untouched = nodes.filter((n) => n.data.kind === 'fitting').length === 4
        return { done: q >= 47 && untouched, readout: `${q.toFixed(1)} L/min` }
      },
    },
    select: 'e1b',
    build: () => {
      const bend = { variant: 'elbow90mitre', k: 1.3, diameter: 0.02 }
      const run = { length: 2, diameter: 0.02, material: 'copper' }
      return new Rig()
        .add('src', 'reservoir', 90, 480, { head: 5 }, 'Header tank')
        .add('e1b', 'fitting', 330, 480, bend, 'EL1')
        .add('e2b', 'fitting', 330, 250, bend, 'EL2')
        .add('e3b', 'fitting', 640, 250, bend, 'EL3')
        .add('e4b', 'fitting', 640, 480, bend, 'EL4')
        .add('m', 'meter', 820, 480, { diameter: 0.02 })
        .add('out', 'outlet', 1000, 480, { nozzleDiameter: 0.02 })
        .turn('e2b', 90)
        .turn('e3b', 90)
        .pipe('src', 'e1b', { ...run, length: 3 })
        .pipe('e1b', 'e2b', run, ['out', 'out'])
        .pipe('e2b', 'e3b', run, ['in', 'in'])
        .pipe('e3b', 'e4b', run, ['out', 'in'])
        .pipe('e4b', 'm', run)
        .pipe('m', 'out', { ...run, length: 0.5 })
        .done()
    },
  },
  {
    id: 'strainer',
    no: '21',
    title: 'Clogging strainer',
    concept: 'Suction-side losses and NPSH',
    formula: 'Δp = Δp_rated · (Q/Q_r)² / (1 − fouling)²',
    brief:
      'A strainer protects the pump — and slowly starves it. Its datasheet gives one number, the pressure drop at a rated flow; dirt shrinks the open area and the loss climbs as 1/(1 − fouling)². On the suction side every kilopascal lost comes straight out of the pump’s NPSH margin.',
    steps: [
      'Select the strainer and drag its fouling slider. DP1 reads what the basket is costing.',
      'Select the pump and watch NPSH available fall towards NPSH required.',
      'Maintenance crews change baskets on Δp, not on the calendar — find the reading that should raise the alarm.',
    ],
    goal: {
      text: 'Foul the strainer until NPSH available is within 0.3 m of NPSH required — note DP1, that is your alarm limit',
      check: (r, nodes) => {
        const d = r.devices['p']
        const npshr = nodes.find((n) => n.id === 'p')?.data.props.npshr ?? 0
        const dp = r.devices['dp']
        const margin = (d?.npsha ?? 99) - npshr
        return { done: Math.abs(margin) <= 0.3, readout: `margin ${margin.toFixed(1)} m · DP1 ${dp ? ((dp.pIn - dp.pOut) / 1000).toFixed(0) : '—'} kPa` }
      },
    },
    select: 'st',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 460, { head: 1 }, 'Sump')
        .add('a', 'junction', 270, 460, {}, 'Tap A')
        .add('st', 'fitting', 420, 460, { variant: 'strainer', ratedDp: 8e3, ratedFlow: 60 * LPM, exponent: 2, fouling: 0.1, diameter: 0.04 }, 'ST1')
        .add('b', 'junction', 570, 460, {}, 'Tap B')
        .add('dp', 'dpgauge', 420, 260, {}, 'DP1')
        .add('p', 'pump', 730, 460, { designFlow: 70 * LPM, designHead: 22, npshr: 3.5 })
        .add('out', 'outlet', 990, 460, { nozzleDiameter: 0.013 })
        .pipe('src', 'a', { length: 2, diameter: 0.04 })
        .pipe('a', 'st', { length: 0.5, diameter: 0.04 })
        .pipe('st', 'b', { length: 0.5, diameter: 0.04 })
        .pipe('b', 'p', { length: 1, diameter: 0.04 })
        .pipe('p', 'out', { length: 10, diameter: 0.04 })
        .pipe('a', 'dp', { length: 1, diameter: 0.006 }, ['t', 'in'], 'Sense HI')
        .pipe('b', 'dp', { length: 1, diameter: 0.006 }, ['t', 'out'], 'Sense LO')
        .done(),
  },
  {
    id: 'relief',
    no: '22',
    title: 'Relief valve',
    concept: 'Protecting a dead-headed pump',
    formula: 'lifts when p > p_set',
    brief:
      'Shut the discharge valve on a running pump and the header climbs to the pump’s shut-off pressure. A relief valve is the last line of defence: below its set pressure it is a closed dead end, above it it opens just far enough to hold the line. This one was set far too high to ever lift.',
    steps: ['Close the discharge valve and watch PG1 climb.', 'Select RV1 and lower its set pressure until it lifts.', 'Note where the vented water goes — in a real plant, back to the tank.'],
    goal: {
      text: 'Fully close the discharge valve while keeping the header at or below 300 kPa',
      check: (r, nodes) => {
        const shut = (nodes.find((n) => n.id === 'v')?.data.props.opening ?? 1) <= 0.001
        const p = (r.nodes['g']?.pressure ?? 0) / 1000
        return { done: shut && p <= 305 && (r.nodes['rv']?.outflow ?? 0) > 1e-7, readout: `${p.toFixed(0)} kPa${shut ? '' : ' · valve open'}` }
      },
    },
    select: 'v',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 470, { head: 2 }, 'Tank')
        .add('p', 'pump', 290, 470, { designFlow: 80 * LPM, designHead: 30 })
        .add('g', 'gauge', 480, 470, {}, 'PG1')
        .add('rv', 'relief', 480, 250, { setPressure: 900e3, diameter: 0.025 }, 'RV1')
        .add('v', 'valve', 680, 470, { diameter: 0.04, body: 'globe', kOpen: 6, trim: 'linear' }, 'Discharge')
        .add('out', 'outlet', 900, 470, { nozzleDiameter: 0.016 })
        .turn('rv', 270)
        .pipe('src', 'p', { length: 3, diameter: 0.05 })
        .pipe('p', 'g', { length: 3, diameter: 0.04 })
        .pipe('g', 'rv', { length: 1, diameter: 0.025 }, ['t', 'l'])
        .pipe('g', 'v', { length: 3, diameter: 0.04 })
        .pipe('v', 'out', { length: 6, diameter: 0.04 })
        .done(),
  },
  {
    id: 'vessel',
    no: '23',
    title: 'Pressure vessel',
    concept: 'A gas cushion as a buffer',
    formula: '(p + p_atm) · V_gasⁿ = constant',
    brief:
      'A domestic booster set: the pressure switch starts the pump at 200 kPa and stops it at 350 kPa, and the bladder vessel supplies the tap in between. The vessel is what decides how often the pump starts — and this one is far too small, so the pump short-cycles itself to an early grave.',
    steps: [
      'Select PS1 and watch the pressure saw-tooth on its Loop chart; count the pump starts.',
      'Select the vessel: see how little water it actually holds between cut-in and cut-out.',
      'Enlarge the vessel (or fix its pre-charge, which should sit just below cut-in).',
    ],
    goal: {
      text: 'Get the pump down to 6 starts or fewer over the last 20 lab-minutes',
      check: (_r, _n, _l, history) => {
        const now = history.length ? history[history.length - 1].t : 0
        const recent = history.filter((h) => h.t > now - 1200)
        let starts = 0
        for (let i = 1; i < recent.length; i++) if ((recent[i].v['p'] ?? 0) > 1e-6 && (recent[i - 1].v['p'] ?? 0) <= 1e-6) starts++
        const full = history.length > 1 && now - history[0].t >= 1160
        return { done: full && starts <= 6, readout: full ? `${starts} starts / 20 min` : `${starts} starts · recording…` }
      },
    },
    timeScale: 20,
    select: 'pv',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 480, { head: 1 }, 'Break tank')
        .add('p', 'pump', 280, 480, { designFlow: 60 * LPM, designHead: 38 })
        .add('j', 'junction', 470, 480)
        .add('pv', 'vessel', 470, 300, { volume: 0.024, precharge: 120e3, initPressure: 300e3 }, 'PV1')
        .add('ps', 'switch', 250, 230, { action: 'fill', low: 200e3, high: 350e3, pvKind: 'vessel' }, 'PS1')
        .add('out', 'outlet', 760, 480, { nozzleDiameter: 0.006 }, 'Tap')
        .pipe('src', 'p', { length: 2, diameter: 0.04 })
        .pipe('p', 'j', { length: 2, diameter: 0.032 })
        .pipe('j', 'pv', { length: 0.5, diameter: 0.032 }, ['t', 'b'])
        .pipe('j', 'out', { length: 15, diameter: 0.02 })
        .wire('pv', 'ps', ['pv', 'cin'])
        .wire('ps', 'p')
        .done(),
  },
  {
    id: 'night-flow',
    no: '24',
    title: 'Night flow & leakage',
    concept: 'Demand patterns · pressure management',
    formula: 'Q_leak = Cd · A · √(2p/ρ)',
    brief:
      'The street’s demand follows a residential day: two peaks, and almost nothing at 3 a.m. The inlet meter never drops to that “almost nothing”, because a leaking joint runs around the clock — and it runs hardest at night, when demand is low and pressure is high. Utilities find leaks exactly this way, and tame them by lowering pressure.',
    steps: [
      'Let a day run (1200×). Compare the inlet meter at 03:00 with the houses’ demand: the gap is the leak.',
      'Select the leaky joint: see what it loses per day.',
      'You cannot dig up the street today. Lower the PRV setpoint instead — leakage falls with √p.',
    ],
    goal: {
      text: 'Without touching the leak, cut it below 9 L/min while the houses keep at least 150 kPa',
      check: (r, nodes) => {
        const leak = (r.nodes['lk']?.outflow ?? 0) / LPM
        const p = (r.nodes['h']?.pressure ?? 0) / 1000
        const untouched = Math.abs((nodes.find((n) => n.id === 'lk')?.data.props.holeDiameter ?? 0) - 0.004) < 1e-6
        return { done: untouched && leak < 9 && p >= 150, readout: `leak ${leak.toFixed(1)} L/min · houses ${p.toFixed(0)} kPa` }
      },
    },
    timeScale: 1200,
    select: 'prv',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 440, { head: 50 }, 'Service reservoir')
        .add('m', 'meter', 290, 440, { diameter: 0.05 }, 'Inlet meter')
        .add('prv', 'valve', 470, 440, { valveType: 'prv', pressureSetting: 400e3, diameter: 0.05, kOpen: 1 }, 'PRV')
        .add('lk', 'leak', 660, 440, { holeDiameter: 0.004 }, 'Leaky joint')
        .add('h', 'junction', 880, 440, { demand: 25 * LPM, pattern: 'residential' }, 'Houses')
        .pipe('src', 'm', { length: 50, diameter: 0.08 })
        .pipe('m', 'prv', { length: 5, diameter: 0.05 })
        .pipe('prv', 'lk', { length: 80, diameter: 0.05 })
        .pipe('lk', 'h', { length: 120, diameter: 0.04 })
        .done(),
  },
  {
    id: 'shapes',
    no: '25',
    title: 'Tank shapes',
    concept: 'Same head, different volume',
    formula: 'A(h) · dh/dt = −Cd · a · √(2gh)',
    brief:
      'Two tanks, equally tall and equally wide at the top, drain through identical nozzles. The outflow depends only on the level — but how fast the level falls depends on how much water sits at that level. The cone holds a third of the cylinder’s volume, nearly all of it near the top.',
    steps: [
      'Press play and watch both levels. Which empties first, and by how much?',
      'Select each tank and compare their level trends: the cylinder’s slows down, the cone’s speeds up.',
      'Try a sphere or a horizontal drum — fastest change where the vessel is narrowest.',
    ],
    timeScale: 60,
    select: 'cone',
    build: () =>
      new Rig()
        .add('cyl', 'tank', 250, 260, { shape: 'cylinder', diameter: 1.2, initLevel: 2, maxLevel: 2, elevation: 1 }, 'Cylinder')
        .add('o1', 'outlet', 250, 520, { nozzleDiameter: 0.012 })
        .add('cone', 'tank', 640, 260, { shape: 'cone', diameter: 1.2, initLevel: 2, maxLevel: 2, elevation: 1 }, 'Cone')
        .add('o2', 'outlet', 640, 520, { nozzleDiameter: 0.012 })
        .turn('o1', 90)
        .turn('o2', 90)
        .pipe('cyl', 'o1', { length: 1, diameter: 0.025 }, ['b', 'l'])
        .pipe('cone', 'o2', { length: 1, diameter: 0.025 }, ['b', 'l'])
        .done(),
  },
  {
    id: 'float-valve',
    no: '26',
    title: 'Float valve',
    concept: 'Self-acting level control',
    formula: 'opening ∝ (h_shut − h) / band',
    brief:
      'The valve in every cistern: a float rides the water and closes the inlet as the level rises — a proportional controller with no wires at all. This one has been set to shut above the rim, so the header tank simply overflows.',
    steps: [
      'Select the float valve: it finds the tank on its outlet side by itself.',
      'Set “shuts at tank level” below the rim and watch the level settle where inflow meets demand.',
      'Widen the band: gentler valve action, but the level sags further under heavy demand.',
    ],
    goal: {
      text: 'Hold the header tank between 60 % and 80 % for 15 lab-minutes',
      check: (_r, nodes, levels, history) => {
        const tank = nodes.find((n) => n.id === 't')
        if (!tank) return { done: false, readout: '—' }
        const max = tank.data.props.maxLevel
        const held = heldFor(history, 't', 0.6 * max, 0.8 * max)
        return { done: held >= 15, readout: `${(((levels['t'] ?? tank.data.props.initLevel) / max) * 100).toFixed(0)} % · ${Math.min(15, held).toFixed(0)}/15 min` }
      },
    },
    timeScale: 60,
    select: 'fv',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 300, { head: 30 }, 'Mains')
        .add('fv', 'valve', 330, 300, { valveType: 'float', diameter: 0.02, kOpen: 4, closeLevel: 2.6, band: 0.3 }, 'Float valve')
        .add('t', 'tank', 580, 300, { elevation: 6, diameter: 1, initLevel: 1.2, maxLevel: 2.4, overflow: true }, 'Header tank')
        .add('out', 'outlet', 860, 480, { mode: 'demand', demand: 18 * LPM, pattern: 'residential' }, 'Building')
        .pipe('src', 'fv', { length: 20, diameter: 0.025 })
        .pipe('fv', 't', { length: 3, diameter: 0.025 }, ['out', 'l'])
        .pipe('t', 'out', { length: 12, diameter: 0.032 }, ['r', 'l'])
        .done(),
  },
  {
    id: 'sprinklers',
    no: '27',
    title: 'Sprinkler branch line',
    concept: 'K-factor hydraulics · the remote head',
    formula: 'Q = K · √p',
    brief:
      'Four K80 heads on one branch line, all open. Every head obeys Q = K·√p, so the head furthest from the riser — the one with the least pressure left — decides whether the design passes. Fire codes are written around that most remote head.',
    steps: [
      'Compare the four heads: flow falls away along the branch.',
      'Click the branch pipes: at these velocities a 1″ line eats most of the pump’s pressure.',
      'Pick a bigger nominal size for the branch (pipe standard → nominal size) until the last head is fed.',
    ],
    goal: {
      text: 'Get at least 57 L/min (0.5 bar on a K80) out of every head, including the most remote one',
      check: (r) => {
        const flows = ['h1', 'h2', 'h3', 'h4'].map((h) => (r.nodes[h]?.outflow ?? 0) / LPM)
        return { done: Math.min(...flows) >= 57, readout: `remote head ${flows[3].toFixed(0)} L/min · nearest ${flows[0].toFixed(0)}` }
      },
    },
    select: 'h4',
    build: () => {
      const branch = { length: 3.5, std: 'steel40', size: 'DN25 · 1″', diameter: 0.0266, material: 'steel', roughness: 0.045e-3 }
      const head = { variant: 'spk80', mode: 'kfactor', kFactor: 80 / 60000 / Math.sqrt(1e5), fused: true, elevation: 4 }
      const rig = new Rig()
        .add('src', 'reservoir', 90, 480, { head: 2 }, 'Fire tank')
        .add('p', 'pump', 270, 480, { pumpType: 'fire', shutoffRatio: 1.2, runoutRatio: 2.2, designFlow: 250 * LPM, designHead: 24 }, 'Fire pump')
        .add('j0', 'junction', 430, 250, { elevation: 4 }, 'Riser')
        .pipe('src', 'p', { length: 3, diameter: 0.08 })
        .pipe('p', 'j0', { length: 8, diameter: 0.0525, material: 'steel', roughness: 0.045e-3 }, ['out', 'b'], 'Riser DN50')
      let prev = 'j0'
      for (let i = 1; i <= 4; i++) {
        const j = `j${i}`
        rig
          .add(j, 'junction', 430 + i * 150, 250, { elevation: 4 }, `T${i}`)
          .add(`h${i}`, 'outlet', 430 + i * 150, 400, head, `SP${i}`)
          .turn(`h${i}`, 90)
          .pipe(prev, j, branch, ['r', 'l'], `Branch ${i}`)
          .pipe(j, `h${i}`, { length: 0.3, diameter: 0.0266 }, ['b', 'l'], `Drop ${i}`)
        prev = j
      }
      return rig.done()
    },
  },
  {
    id: 'fire-pump',
    no: '28',
    title: 'Fire pump acceptance test',
    concept: 'The NFPA 20 three-point curve',
    formula: 'churn ≤ 140 % · ≥ 65 % head at 150 % flow',
    brief:
      'A fire pump must never run out of breath when the system demands more than its rating. The acceptance test flows it through a test header at 0 %, 100 % and 150 % of rated flow; at 150 % it must still make 65 % of its rated head. Somebody installed an ordinary end-suction pump here.',
    steps: [
      'Open the test valve until the meter reads 150 % of the pump’s rating (1125 L/min).',
      'Select the pump: how much of its rated head is left? An ordinary curve droops too fast.',
      'Change the pump’s curve shape to a listed fire pump and repeat the test.',
    ],
    goal: {
      text: 'At 150 % of rated flow (1125 ± 35 L/min) the pump must still deliver at least 65 % of its rated head',
      check: (r, nodes) => {
        const d = r.devices['p']
        const pp = nodes.find((n) => n.id === 'p')?.data.props
        if (!d || !pp) return { done: false, readout: '—' }
        const load = d.flow / pp.designFlow
        const head = d.dH / pp.designHead
        return { done: Math.abs(d.flow / LPM - 1125) <= 35 && head >= 0.65, readout: `${(load * 100).toFixed(0)} % flow · ${(head * 100).toFixed(0)} % head` }
      },
    },
    select: 'v',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 440, { head: 3 }, 'Fire tank')
        .add('p', 'pump', 290, 440, { designFlow: 750 * LPM, designHead: 60, npshr: 4 }, 'Fire pump')
        .add('g', 'gauge', 470, 440, {}, 'Discharge')
        .add('m', 'meter', 640, 440, { diameter: 0.1 }, 'Test meter')
        .add('v', 'valve', 820, 440, { diameter: 0.1, body: 'globe', kOpen: 6, trim: 'linear', opening: 0.15 }, 'Test valve')
        .add('out', 'outlet', 1010, 440, { variant: 'hydrant', mode: 'kfactor', kFactor: 1500 / 60000 / Math.sqrt(1e5) }, 'Test header')
        .pipe('src', 'p', { length: 3, diameter: 0.15 })
        .pipe('p', 'g', { length: 2, diameter: 0.1 })
        .pipe('g', 'm', { length: 2, diameter: 0.1 })
        .pipe('m', 'v', { length: 2, diameter: 0.1 })
        .pipe('v', 'out', { length: 3, diameter: 0.1 })
        .done(),
  },
  {
    id: 'lateral',
    no: '29',
    title: 'Irrigation lateral',
    concept: 'Distribution uniformity',
    formula: 'DU = Q_min / Q_max',
    brief:
      'Five spray heads along one lateral. Water is used up as it goes, so flow — and friction — is highest at the inlet and the pressure sags towards the far end. Heads that obey Q = K·√p then water the near end of the lawn more than the far end. Designers keep the variation inside 10 %.',
    steps: ['Compare the first and last head.', 'Click the lateral sections: where is the pressure being lost?', 'Upsize the lateral (it is ½″ PEX) or lower the inlet flow until the heads even out.'],
    goal: {
      text: 'Bring the uniformity (smallest ÷ largest head flow) up to 90 %',
      check: (r) => {
        const q = ['s1', 's2', 's3', 's4', 's5'].map((h) => r.nodes[h]?.outflow ?? 0)
        const du = Math.max(...q) > 0 ? Math.min(...q) / Math.max(...q) : 0
        return { done: du >= 0.9, readout: `DU ${(du * 100).toFixed(0)} %` }
      },
    },
    select: 's5',
    build: () => {
      const lat = { length: 8, std: 'pex', size: '½″', diameter: 0.0121, material: 'pex', roughness: 0.007e-3 }
      const spray = { variant: 'spray', mode: 'kfactor', kFactor: 5 / 60000 / Math.sqrt(1e5) }
      const rig = new Rig()
        .add('src', 'reservoir', 90, 300, { head: 25 }, 'Supply')
        .add('f', 'fitting', 270, 300, { variant: 'filter', ratedDp: 25e3, ratedFlow: 40 * LPM, exponent: 1.4, fouling: 0, diameter: 0.025 }, 'Filter')
        .pipe('src', 'f', { length: 5, diameter: 0.025 })
      let prev = 'f'
      for (let i = 1; i <= 5; i++) {
        rig
          .add(`t${i}`, 'junction', 300 + i * 140, 300, {}, `T${i}`)
          .add(`s${i}`, 'outlet', 300 + i * 140, 450, spray, `SH${i}`)
          .turn(`s${i}`, 90)
          .pipe(prev, `t${i}`, lat, [prev === 'f' ? 'out' : 'r', 'l'], `Lateral ${i}`)
          .pipe(`t${i}`, `s${i}`, { length: 0.3, diameter: 0.0121 }, ['b', 'l'], `Riser ${i}`)
        prev = `t${i}`
      }
      return rig.done()
    },
  },
  {
    id: 'hydronic',
    no: '30',
    title: 'Balancing a heating loop',
    concept: 'Closed loops · the path of least resistance',
    formula: 'Σ Δp around any loop = 0',
    brief:
      'A closed heating circuit: the circulator only has to beat friction, and the expansion vessel pins the pressure. Two identical radiators hang off the same pipes, but the near one has a far shorter path — so it hogs the flow while the far room stays cold. Balancing valves exist to waste a little head on purpose.',
    steps: [
      'Switch the pipe colours to “Thermal” (top bar): the far radiator comes back colder.',
      'Compare the two branch meters.',
      'Select the near branch’s balancing valve and throttle it.',
      'Watch flow migrate to the far radiator. The pump’s total barely changes.',
    ],
    goal: {
      text: 'Balance the radiators to within 10 % of each other, with at least 3 L/min through each',
      check: (r) => {
        const a = Math.abs(r.devices['m1']?.flow ?? 0) / LPM
        const b = Math.abs(r.devices['m2']?.flow ?? 0) / LPM
        return { done: Math.min(a, b) >= 3 && Math.abs(a - b) / Math.max(a, b, 1e-9) <= 0.1, readout: `near ${a.toFixed(1)} · far ${b.toFixed(1)} L/min` }
      },
    },
    select: 'bv1',
    build: () => {
      const cu = { diameter: 0.0199, std: 'copperL', size: '¾″', material: 'copper', roughness: 0.0015e-3 }
      const bv = { diameter: 0.015, body: 'balancing', kOpen: 4, trim: 'linear' }
      const rad = { variant: 'radiator', ratedDp: 6e3, ratedFlow: 3 * LPM, exponent: 1.9, fouling: 0, diameter: 0.015, ratedHeat: 4000, roomTemp: 20 }
      return new Rig()
        .add('ev', 'vessel', 120, 330, { volume: 0.018, precharge: 100e3, initPressure: 150e3 }, 'Expansion')
        .add('p', 'pump', 260, 520, { pumpType: 'circulator', shutoffRatio: 1.15, runoutRatio: 2.5, designFlow: 12 * LPM, designHead: 4, npshr: 1 }, 'Circulator')
        .add('b', 'fitting', 430, 520, { variant: 'boiler', ratedDp: 10e3, ratedFlow: 30 * LPM, exponent: 2, fouling: 0, diameter: 0.02, supplyTemp: 70 }, 'Boiler')
        .add('s1', 'junction', 600, 520, {}, 'S1')
        .add('s2', 'junction', 960, 520, {}, 'S2')
        .add('r1', 'fitting', 600, 380, rad, 'RA1')
        .turn('r1', 270)
        .add('bv1', 'valve', 600, 250, bv, 'BV1')
        .turn('bv1', 270)
        .add('m1', 'meter', 600, 120, { diameter: 0.015 }, 'Near')
        .turn('m1', 270)
        .add('r2', 'fitting', 960, 380, rad, 'RA2')
        .turn('r2', 270)
        .add('bv2', 'valve', 960, 250, bv, 'BV2')
        .turn('bv2', 270)
        .add('m2', 'meter', 960, 120, { diameter: 0.015 }, 'Far')
        .turn('m2', 270)
        .add('ret', 'junction', 260, 30, {}, 'Return')
        .pipe('ev', 'p', { length: 1, ...cu }, ['b', 'in'])
        .pipe('p', 'b', { length: 2, ...cu })
        .pipe('b', 's1', { length: 3, ...cu })
        .pipe('s1', 's2', { length: 30, ...cu, diameter: 0.0138, size: '½″' }, ['r', 'l'], 'Supply main')
        .pipe('s1', 'r1', { length: 1, ...cu }, ['t', 'in'])
        .pipe('r1', 'bv1', { length: 0.5, ...cu })
        .pipe('bv1', 'm1', { length: 0.5, ...cu })
        .pipe('s2', 'r2', { length: 1, ...cu }, ['t', 'in'])
        .pipe('r2', 'bv2', { length: 0.5, ...cu })
        .pipe('bv2', 'm2', { length: 0.5, ...cu })
        .pipe('m1', 'ret', { length: 4, ...cu }, ['out', 'r'], 'Return near')
        .pipe('m2', 'ret', { length: 34, ...cu, diameter: 0.0138, size: '½″' }, ['out', 't'], 'Return far')
        .pipe('ret', 'ev', { length: 4, ...cu }, ['b', 'l'], 'Return')
        .done()
    },
  },
  {
    id: 'water-hammer',
    no: '31',
    title: 'Water hammer',
    concept: 'Joukowsky · the critical time 2L/a',
    formula: 'Δp = ρ · a · Δv',
    brief:
      'Stop a moving column of water and its momentum has to go somewhere: a pressure wave runs up the pipe at the speed of sound in the water-filled pipe, about 1250 m/s in steel. If the valve shuts before that wave has been to the reservoir and back (2L/a), the pipe sees the full Joukowsky pressure — many times its working pressure. This engine is a separate solver: the method of characteristics, started from the steady solution.',
    steps: [
      'Select the valve, scroll to “Water hammer” and stroke it shut in 0.5 s. Then replay it on the bench.',
      'Compare the peak with Joukowsky’s estimate, and the stroke time with 2L/a.',
      'Find a stroke time the pipe can live with. Notice that most of a valve’s travel does almost nothing.',
    ],
    goal: {
      text: 'Shut the valve completely without the line ever exceeding 1000 kPa',
      check: (_r, _n, _l, _h, surge) => {
        if (!surge?.ok || surge.event.id !== 'v') return { done: false, readout: 'no run yet' }
        return { done: surge.event.to <= 0.001 && surge.peak.pressure <= 1000e3, readout: `peak ${(surge.peak.pressure / 1000).toFixed(0)} kPa in ${surge.event.duration} s` }
      },
    },
    select: 'v',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 400, { head: 40 }, 'Reservoir')
        .add('g1', 'gauge', 420, 400, {}, 'Mid-line')
        .add('g2', 'gauge', 700, 400, {}, 'At valve')
        .add('v', 'valve', 850, 400, { diameter: 0.05, body: 'globe', kOpen: 6, trim: 'linear' }, 'Line valve')
        .add('out', 'outlet', 1030, 400, { nozzleDiameter: 0.03 })
        .pipe('src', 'g1', { length: 300, diameter: 0.0525, material: 'steel', roughness: 0.045e-3, std: 'steel40', size: 'DN50 · 2″' }, [], 'Main A')
        .pipe('g1', 'g2', { length: 300, diameter: 0.0525, material: 'steel', roughness: 0.045e-3, std: 'steel40', size: 'DN50 · 2″' }, [], 'Main B')
        .pipe('g2', 'v', { length: 1, diameter: 0.0525, material: 'steel', roughness: 0.045e-3 })
        .pipe('v', 'out', { length: 2, diameter: 0.0525, material: 'steel', roughness: 0.045e-3 })
        .done(),
  },
  {
    id: 'surge-vessel',
    no: '32',
    title: 'Surge vessel',
    concept: 'Giving the wave somewhere to go',
    formula: 'p · V_gasⁿ = constant',
    brief:
      'Sometimes the valve has to slam — an emergency shut-off, a solenoid. Then the cure is a gas cushion next to it: the arriving water compresses the gas instead of the pipe wall, and the sharp spike becomes a slow, gentle swing. The vessel fitted here is the size of a lunch box.',
    steps: [
      'Stroke the valve shut in 0.1 s and look at the peak.',
      'Select the surge vessel and make it bigger (its pre-charge should sit a little under line pressure).',
      'Run the closure again — and replay both to see the difference.',
    ],
    goal: {
      text: 'Shut the valve in 0.1 s or less and keep the peak below 800 kPa',
      check: (_r, _n, _l, _h, surge) => {
        if (!surge?.ok || surge.event.id !== 'v') return { done: false, readout: 'no run yet' }
        return {
          done: surge.event.to <= 0.001 && surge.event.duration <= 0.1 && surge.peak.pressure <= 800e3,
          readout: `peak ${(surge.peak.pressure / 1000).toFixed(0)} kPa in ${surge.event.duration} s`,
        }
      },
    },
    select: 'v',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 440, { head: 40 }, 'Reservoir')
        .add('j', 'gauge', 640, 440, {}, 'At valve')
        .add('sv', 'vessel', 640, 230, { volume: 0.002, precharge: 200e3, initPressure: 300e3 }, 'Surge vessel')
        .add('v', 'valve', 820, 440, { diameter: 0.05, body: 'ball', kOpen: 0.3, trim: 'equal' }, 'Shut-off')
        .add('out', 'outlet', 1000, 440, { nozzleDiameter: 0.02 })
        .pipe('src', 'j', { length: 500, diameter: 0.0525, material: 'steel', roughness: 0.045e-3 }, [], 'Main')
        .pipe('j', 'sv', { length: 0.5, diameter: 0.05, material: 'steel' }, ['t', 'b'])
        .pipe('j', 'v', { length: 1, diameter: 0.0525, material: 'steel' })
        .pipe('v', 'out', { length: 2, diameter: 0.0525, material: 'steel' })
        .done(),
  },
  {
    id: 'pump-trip',
    no: '33',
    title: 'Pump trip',
    concept: 'Down-surge and column separation',
    formula: 'Δp = −ρ · a · Δv',
    brief:
      'A power cut is a valve closure in reverse: the pump stops pushing, the column keeps going, and a wave of low pressure runs up the rising main. At a high point the pressure can reach the vapour pressure — the column parts, and slams back together when the flow reverses. The check valve at the pump then sees the returning surge.',
    steps: [
      'Select the pump, scroll to “Water hammer” and trip it.',
      'Look at the pressure at the high point: does it reach vapour pressure?',
      'Give the pump a heavier rotor (a longer coast-down) and trip it again — flywheels are a real surge cure.',
    ],
    goal: {
      text: 'Trip the pump without the column separating anywhere',
      check: (_r, _n, _l, _h, surge) => {
        if (!surge?.ok || surge.event.id !== 'p') return { done: false, readout: 'no run yet' }
        return { done: !surge.cavitated, readout: `lowest ${(surge.trough.pressure / 1000).toFixed(0)} kPa${surge.cavitated ? ' · column parted' : ''}` }
      },
    },
    select: 'p',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 90, 520, { head: 2 }, 'Sump')
        .add('p', 'pump', 270, 520, { designFlow: 400 * LPM, designHead: 55 }, 'Duty pump')
        .add('g', 'gauge', 440, 520, {}, 'Pump outlet')
        .add('hp', 'gauge', 720, 260, { elevation: 32 }, 'High point')
        .add('dst', 'reservoir', 1010, 330, { head: 38 }, 'Hill tank')
        .pipe('src', 'p', { length: 3, diameter: 0.15 })
        .pipe('p', 'g', { length: 2, diameter: 0.1, material: 'steel' })
        .pipe('g', 'hp', { length: 700, diameter: 0.1023, material: 'steel', roughness: 0.045e-3 }, ['r', 'l'], 'Rising main')
        .pipe('hp', 'dst', { length: 500, diameter: 0.1023, material: 'steel', roughness: 0.045e-3 }, ['r', 'l'], 'Gravity leg')
        .done(),
  },
  {
    id: 'standpipe',
    no: '34',
    title: 'Standpipe',
    concept: 'Pressure at the top of a tall building',
    formula: 'p_roof = p_pump − ρg·z − friction',
    brief:
      'Fire-fighters connect to landing valves on each floor. The hardest one to feed is on the roof: every metre of height costs 9.8 kPa before friction takes its share. The standard asks for 950 L/min from the topmost valve — this riser was run in too small a pipe.',
    steps: [
      'The roof valve is open; read its flow and the gauge beside it.',
      'Click the riser sections: static lift you cannot change, friction you can.',
      'Pick a bigger nominal size for the riser until the roof valve makes its 950 L/min.',
    ],
    goal: {
      text: 'Deliver at least 950 L/min from the roof landing valve',
      check: (r) => {
        const q = (r.nodes['lv3']?.outflow ?? 0) / LPM
        return { done: q >= 950, readout: `${q.toFixed(0)} L/min · ${((r.nodes['g3']?.pressure ?? 0) / 1000).toFixed(0)} kPa at the roof` }
      },
    },
    select: 'lv3',
    build: () => {
      const riser = { length: 15, std: 'steel40', size: 'DN65 · 2½″', diameter: 0.0627, material: 'steel', roughness: 0.045e-3 }
      const valve = { variant: 'landing', mode: 'kfactor', kFactor: 430 / 60000 / Math.sqrt(1e5) }
      const rig = new Rig()
        .add('src', 'reservoir', 90, 620, { head: 3 }, 'Fire tank')
        .add('p', 'pump', 270, 620, { pumpType: 'fire', shutoffRatio: 1.2, runoutRatio: 2.2, designFlow: 1000 * LPM, designHead: 95, npshr: 4 }, 'Fire pump')
        .add('g0', 'gauge', 470, 620, {}, 'Ground')
        .pipe('src', 'p', { length: 3, diameter: 0.15 })
        .pipe('p', 'g0', { length: 4, diameter: 0.1023, material: 'steel', roughness: 0.045e-3 })
      let prev = 'g0'
      ;[15, 30, 45].forEach((z, i) => {
        const g = `g${i + 1}`
        const lv = `lv${i + 1}`
        rig
          .add(g, 'gauge', 470, 620 - (i + 1) * 170, { elevation: z }, `Level ${i + 1}`)
          .add(lv, 'outlet', 700, 620 - (i + 1) * 170, { ...valve, elevation: z }, i === 2 ? 'Roof valve' : `Landing ${i + 1}`)
          .pipe(prev, g, riser, ['t', 'b'], `Riser ${i + 1}`)
          .pipe(g, lv, { length: 1, diameter: 0.0627 })
        if (i < 2) rig.nodes[rig.nodes.length - 1].data.props.mode = 'demand' // lower landings shut: a zero demand
        if (i < 2) rig.nodes[rig.nodes.length - 1].data.props.demand = 0
        prev = g
      })
      return rig.done()
    },
  },
  {
    id: 'booster',
    no: '35',
    title: 'Booster set',
    concept: 'Staging pumps · lead / lag rotation',
    formula: 'pumps running = ⌈ demand × N ⌉',
    brief:
      'Three small pumps instead of one big one: most of the day a single pump copes, and the others only join when the building wakes up. The pressure controller asks for a demand; the sequencer turns that into how many pumps run, trims the speed they share, and rotates which pump leads so they wear evenly. Two of the three were never wired in.',
    steps: [
      'Watch PT1 when the big users come on: one pump cannot hold the header.',
      'Pull wires from the sequencer’s violet port to P2 and P3.',
      'Watch the bars on the sequencer: pumps stage in and out, and the lead (amber) rotates every 5 minutes.',
    ],
    goal: {
      text: 'Hold the header within 350 ± 40 kPa for 80 % of the last 5 lab-minutes',
      check: (r, _n, _l, history) => {
        const share = shareInBand(history, 'pt', 310e3, 390e3, 300)
        return {
          done: share !== null && share >= 0.8,
          readout: `${((r.nodes['pt']?.pressure ?? 0) / 1000).toFixed(0)} kPa · ${share === null ? 'recording…' : `${(share * 100).toFixed(0)} % in band`}`,
        }
      },
    },
    timeScale: 10,
    select: 'sq',
    build: () => {
      const pump = { designFlow: 60 * LPM, designHead: 40, speed: 1.15 }
      return new Rig()
        .add('src', 'reservoir', 80, 470, { head: 2 }, 'Break tank')
        .add('j1', 'junction', 230, 470)
        .add('p1', 'pump', 400, 300, pump, 'P1')
        .add('p2', 'pump', 400, 470, pump, 'P2')
        .add('p3', 'pump', 400, 640, pump, 'P3')
        .add('j2', 'junction', 570, 470)
        .add('pt', 'gauge', 700, 470, {}, 'PT1')
        .add('pic', 'pid', 700, 170, { setpoint: 350e3, span: 700e3, kp: 0.5, ti: 1, pvKind: 'gauge' }, 'PIC1')
        .add('sq', 'stager', 470, 110, { rotateEvery: 300, trim: true }, 'SEQ1')
        .add('j3', 'junction', 860, 470)
        .add('o1', 'outlet', 1040, 330, { nozzleDiameter: 0.007 }, 'Base load')
        .add('o2', 'outlet', 1040, 470, { nozzleDiameter: 0.009 }, 'Floors 1–5')
        .add('o3', 'outlet', 1040, 610, { nozzleDiameter: 0.009 }, 'Floors 6–10')
        .add('t2', 'timer', 1210, 470, { onTime: 120, offTime: 60, startOn: false }, 'Morning')
        .add('t3', 'timer', 1210, 640, { onTime: 60, offTime: 120, startOn: false }, 'Evening')
        .pipe('src', 'j1', { length: 2, diameter: 0.08 })
        .pipe('j1', 'p1', { length: 1, diameter: 0.04 }, ['t', 'in'])
        .pipe('j1', 'p2', { length: 1, diameter: 0.04 }, ['r', 'in'])
        .pipe('j1', 'p3', { length: 1, diameter: 0.04 }, ['b', 'in'])
        .pipe('p1', 'j2', { length: 1, diameter: 0.04 }, ['out', 't'])
        .pipe('p2', 'j2', { length: 1, diameter: 0.04 }, ['out', 'l'])
        .pipe('p3', 'j2', { length: 1, diameter: 0.04 }, ['out', 'b'])
        .pipe('j2', 'pt', { length: 2, diameter: 0.05 })
        .pipe('pt', 'j3', { length: 10, diameter: 0.05 })
        .pipe('j3', 'o1', { length: 8, diameter: 0.025 }, ['t', 'l'])
        .pipe('j3', 'o2', { length: 8, diameter: 0.025 }, ['r', 'l'])
        .pipe('j3', 'o3', { length: 8, diameter: 0.025 }, ['b', 'l'])
        .wire('pt', 'pic', ['pv', 'cin'])
        .wire('pic', 'sq', ['sig', 'cin'])
        .wire('sq', 'p1')
        .wire('t2', 'o2')
        .wire('t3', 'o3')
        .done()
    },
  },
  {
    id: 'jet-pump',
    no: '36',
    title: 'Jet pump',
    concept: 'Momentum exchange · area ratio',
    formula: 'N = (H_d − H_s) / (H_m − H_d)   ·   η = M · N',
    brief:
      'No moving parts: a fast motive jet drags water out of the sump and the mixture recovers pressure in the diffuser. The nozzle-to-throat area ratio sets its character — a tight throat lifts a little water a long way, a wide one moves a lot of water a little way. It never beats about 35 % efficiency, which is the price of having nothing to wear out down a well. (Its two internal links depend on heads elsewhere in the network, so the engine re-solves until they settle.)',
    steps: [
      'Select the jet pump: motive flow, entrained flow, the ratios M and N, and the efficiency M·N.',
      'Change the throat diameter and watch M and N trade against each other.',
      'Raise the delivery tank: past a certain head the jet still runs but entrains nothing.',
    ],
    goal: {
      text: 'Entrain at least 70 L/min from the sump',
      check: (r) => {
        const x = r.nodes['jp']?.extra
        return { done: (x?.q2 ?? 0) / LPM >= 70, readout: x ? `${(x.q2 / LPM).toFixed(0)} L/min · M ${x.M.toFixed(2)} · η ${(x.M * x.N * 100).toFixed(0)} %` : '—' }
      },
    },
    select: 'jp',
    build: () =>
      new Rig()
        .add('hp', 'reservoir', 90, 250, { sourceType: 'mains', pressure: 400e3, elevation: 0 }, 'Motive supply')
        .add('jp', 'jetpump', 450, 263, { nozzleDiameter: 0.008, throatDiameter: 0.0105 }, 'Ejector')
        .add('sump', 'reservoir', 250, 560, { head: -3 }, 'Sump')
        .add('m', 'meter', 700, 263, { diameter: 0.04 }, 'Delivered')
        .add('dst', 'reservoir', 930, 120, { head: 5 }, 'Header tank')
        .pipe('hp', 'jp', { length: 5, diameter: 0.025 }, ['r', 'm'], 'Motive line')
        .pipe('sump', 'jp', { length: 4, diameter: 0.04 }, ['r', 's'], 'Suction lift')
        .pipe('jp', 'm', { length: 2, diameter: 0.04 }, ['d', 'in'])
        .pipe('m', 'dst', { length: 6, diameter: 0.04 }, ['out', 'b'])
        .done(),
  },
  {
    id: 'air-main',
    no: '37',
    title: 'Compressed-air main',
    concept: 'Gas networks · p² instead of head',
    formula: 'p₁² − p₂² = (f·L/D) · ṁ²·Z·R·T / A²',
    brief:
      'Same bench, different physics: the working fluid is now air, and a separate solver takes over. A gas expands as it loses pressure, so it speeds up along the pipe and the loss grows faster than for water — squared absolute pressures take the place of heads. Flows are standard volumes, the way gas is metered. Here a compressor charges a receiver under a pressure switch, and three tools hang off a main that is too small.',
    steps: [
      'Watch the receiver cycle between the switch’s cut-in and cut-out.',
      'Read the gauge at the far tool: tools are rated at 600 kPa, and every 100 kPa lost is wasted compressor power.',
      'Upsize the main (pipe standard → nominal size). Click the nozzles: they are choked, so their flow only follows the pressure behind them.',
    ],
    goal: {
      text: 'Keep the far tool at 600 kPa or more with all three tools running',
      check: (r) => {
        const p = (r.nodes['gf']?.pressure ?? 0) / 1000
        return { done: p >= 600, readout: `${p.toFixed(0)} kPa at the far tool` }
      },
    },
    fluidId: 'air',
    timeScale: 10,
    select: 'gf',
    build: () => {
      const main = { length: 20, std: 'steel40', size: 'DN15 · ½″', diameter: 0.0158, material: 'steel', roughness: 0.045e-3 }
      const tool = { nozzleDiameter: 0.004, cd: 0.9 }
      return new Rig()
        .add('atm', 'reservoir', 80, 470, { sourceType: 'mains', pressure: 0 }, 'Intake')
        .add('c', 'pump', 250, 470, { designFlow: 150 / 3600, pressureRatio: 9, bepEfficiency: 0.72 }, 'Compressor')
        .add('rx', 'vessel', 430, 300, { volume: 0.5, initPressure: 700e3, precharge: 0 }, 'Receiver')
        .add('ps', 'switch', 250, 170, { action: 'fill', low: 650e3, high: 750e3, pvKind: 'vessel' }, 'PS1')
        .add('j1', 'junction', 620, 470)
        .add('j2', 'junction', 800, 470)
        .add('gf', 'gauge', 980, 470, {}, 'Far end')
        .add('t1', 'outlet', 620, 640, tool, 'Tool 1')
        .add('t2', 'outlet', 800, 640, tool, 'Tool 2')
        .add('t3', 'outlet', 1150, 470, tool, 'Tool 3')
        .turn('t1', 90)
        .turn('t2', 90)
        .pipe('atm', 'c', { length: 1, diameter: 0.05 })
        .pipe('c', 'rx', { length: 3, diameter: 0.025 }, ['out', 'l'])
        .pipe('rx', 'j1', main, ['r', 'l'], 'Main 1')
        .pipe('j1', 'j2', main, ['r', 'l'], 'Main 2')
        .pipe('j2', 'gf', main, ['r', 'l'], 'Main 3')
        .pipe('j1', 't1', { length: 3, diameter: 0.0158 }, ['b', 'l'])
        .pipe('j2', 't2', { length: 3, diameter: 0.0158 }, ['b', 'l'])
        .pipe('gf', 't3', { length: 3, diameter: 0.0158 })
        .wire('rx', 'ps', ['pv', 'cin'])
        .wire('ps', 'c')
        .done()
    },
  },
  {
    id: 'gas-service',
    no: '38',
    title: 'Gas service & regulator',
    concept: 'Pressure tiers · sizing for a few pascals',
    formula: 'Q ∝ √(p₁² − p₂²)',
    brief:
      'Natural gas arrives in the street at 400 kPa and is used indoors at about 2.5 kPa — a regulator does the stepping down, with a little droop as demand rises, just like the real spring-loaded kind. Indoors the whole pressure budget is a couple of hundred pascals, which is why gas fitters size pipe from tables rather than by eye.',
    steps: ['Read the appliance pressures with everything running.', 'Click the house pipe: how much of the 2.5 kPa does it eat?', 'Upsize it until every appliance sees at least 2.1 kPa.'],
    goal: {
      text: 'Give every appliance at least 2.1 kPa at full load',
      check: (r) => {
        const p = ['boiler', 'cooker', 'fire'].map((k) => (r.nodes[k]?.pressure ?? 0) / 1000)
        return { done: Math.min(...p) >= 2.1, readout: `lowest ${Math.min(...p).toFixed(2)} kPa` }
      },
    },
    fluidId: 'natgas',
    select: 'run',
    build: () => {
      const rig = new Rig()
        .add('street', 'reservoir', 80, 300, { sourceType: 'mains', pressure: 400e3 }, 'Street main')
        .add('reg', 'valve', 280, 300, { valveType: 'prv', pressureSetting: 2500, diameter: 0.025, kOpen: 2 }, 'Regulator')
        .add('m', 'meter', 470, 300, { diameter: 0.025, meterType: 'pd' }, 'Gas meter')
        .add('j', 'junction', 700, 300)
        .add('boiler', 'outlet', 950, 150, { mode: 'demand', demand: 3.2 / 3600 }, 'Boiler')
        .add('cooker', 'outlet', 950, 300, { mode: 'demand', demand: 1.1 / 3600 }, 'Cooker')
        .add('fire', 'outlet', 950, 450, { mode: 'demand', demand: 0.8 / 3600 }, 'Gas fire')
        .pipe('street', 'reg', { length: 6, diameter: 0.025, material: 'pex' }, [], 'Service pipe')
        .pipe('reg', 'm', { length: 1, diameter: 0.025, material: 'copper' })
      rig.pipe('m', 'j', { length: 18, diameter: 0.0138, material: 'copper', roughness: 0.0015e-3, std: 'copperL', size: '½″' }, ['out', 'l'], 'House run')
      rig.edges[rig.edges.length - 1].id = 'run'
      return rig
        .pipe('j', 'boiler', { length: 4, diameter: 0.0199, material: 'copper' }, ['t', 'l'])
        .pipe('j', 'cooker', { length: 3, diameter: 0.0138, material: 'copper' }, ['r', 'l'])
        .pipe('j', 'fire', { length: 5, diameter: 0.0138, material: 'copper' }, ['b', 'l'])
        .done()
    },
  },
  {
    id: 'blowdown',
    no: '39',
    title: 'Choked blowdown',
    concept: 'Sonic flow through a nozzle',
    formula: 'p_back / p_up < (2/(γ+1))^(γ/(γ−1)) ≈ 0.53',
    brief:
      'Open a charged receiver to atmosphere. While the pressure behind the nozzle is more than about 1.9 times the pressure in front of it, the jet is sonic and nothing downstream can make it flow faster: the flow depends only on the upstream pressure. Below that ratio it becomes an ordinary nozzle, and the flow tails off.',
    steps: [
      'Press play and select the receiver: watch its pressure decay.',
      'Select the nozzle: its trend is a straight echo of the receiver pressure while choked — then it bends.',
      'Try hydrogen: far lighter, so the same nozzle passes far more standard volume.',
    ],
    fluidId: 'air',
    timeScale: 1,
    select: 'rx',
    build: () =>
      new Rig()
        .add('rx', 'vessel', 250, 300, { volume: 0.2, initPressure: 800e3, precharge: 0 }, 'Receiver')
        .add('v', 'valve', 500, 380, { diameter: 0.025, body: 'ball', kOpen: 0.05 }, 'Vent valve')
        .add('g', 'gauge', 680, 380, {}, 'Upstream')
        .add('out', 'outlet', 880, 380, { nozzleDiameter: 0.005, cd: 0.9 }, 'Nozzle')
        .pipe('rx', 'v', { length: 1, diameter: 0.025 }, ['r', 'in'])
        .pipe('v', 'g', { length: 1, diameter: 0.025 })
        .pipe('g', 'out', { length: 1, diameter: 0.025 })
        .done(),
  },
  {
    id: 'normal-depth',
    no: '40',
    title: 'Uniform flow',
    concept: 'Manning and normal depth',
    formula: 'Q = (1/n) · A · R^⅔ · √S₀',
    brief:
      'Water in a long, even channel settles at the one depth where the pull of the slope is exactly used up by friction on the bed: the normal depth. Rougher lining, gentler slope or a narrower bed all make the water run deeper and slower.',
    steps: [
      'Select the channel: the dashed green line is the normal depth, the grey one the critical depth.',
      'Change the lining from concrete to grass and watch the depth rise.',
      'Raise the inflow’s bed elevation to steepen the channel: past about 0.4 % the flow turns supercritical.',
    ],
    goal: {
      text: 'Carry the same 300 L/s at a depth between 0.50 and 0.55 m — without touching the discharge',
      check: (r) => {
        const c = r.channel?.reaches.e1
        const y = c?.depth[40] ?? 0
        return { done: !!c && Math.abs(c.flow - 0.3) < 1e-6 && y >= 0.5 && y <= 0.55, readout: c ? `${y.toFixed(3)} m deep · Fr ${c.froude[40].toFixed(2)}` : '—' }
      },
    },
    select: 'e1',
    build: () =>
      new Rig()
        .add('in', 'inflow', 200, 300, { elevation: 0.5, flow: 0.3 }, 'Headworks')
        .add('out', 'outfall', 900, 300, { elevation: 0, mode: 'normal' }, 'Downstream')
        .channel('in', 'out', { length: 500, width: 1, bankHeight: 1 }, [], 'Canal')
        .done(),
  },
  {
    id: 'backwater',
    no: '41',
    title: 'Backwater behind a weir',
    concept: 'Gradually varied flow: the M1 curve',
    formula: 'dy/dx = (S₀ − S_f) / (1 − Fr²)',
    brief:
      'A weir forces the water to rise until enough head stands over its crest. In slow (subcritical) flow that news travels upstream: the surface climbs away from normal depth in a long, flat M1 curve that can flood land far from the weir itself.',
    steps: [
      'Select the upper reach and open “Water surface”: the pool behind the weir fades into normal depth upstream.',
      'Raise the crest and watch how far upstream the staff gauge notices.',
      'Swap the weir for a V-notch: much more head for the same flow.',
    ],
    goal: {
      text: 'Raise the water at the staff gauge, 300 m upstream, to at least 0.80 m — without overtopping the 1.2 m banks',
      check: (r) => {
        const y = r.nodes.g?.extra?.depth ?? 0
        const top = Math.max(0, ...Object.values(r.channel?.reaches ?? {}).flatMap((c) => c.depth))
        return { done: y >= 0.8 && top <= 1.2, readout: `${y.toFixed(3)} m at the gauge · deepest ${top.toFixed(2)} m` }
      },
    },
    select: 'e2',
    build: () =>
      new Rig()
        .add('in', 'inflow', 120, 300, { elevation: 0.6, flow: 0.4 }, 'Headworks')
        .add('g', 'gauge', 420, 300, { elevation: 0.3 }, 'Staff gauge')
        .add('w', 'weir', 760, 300, { elevation: 0, crestHeight: 0.3, crestWidth: 1.2 }, 'Weir')
        .add('out', 'outfall', 1000, 300, { elevation: -0.02 }, 'Drop')
        .channel('in', 'g', { length: 300, width: 1.2, bankHeight: 1.2 })
        .channel('g', 'w', { length: 300, width: 1.2, bankHeight: 1.2 })
        .channel('w', 'out', { length: 20, width: 1.2, bankHeight: 1.2 })
        .done(),
  },
  {
    id: 'hydraulic-jump',
    no: '42',
    title: 'Sluice gate and hydraulic jump',
    concept: 'Supercritical flow, conjugate depths',
    formula: 'y₂/y₁ = ½ (√(1 + 8 Fr₁²) − 1)',
    brief:
      'Under a sluice gate the water shoots out fast and shallow — supercritical. The channel downstream wants it slow and deep. The two can only meet in a hydraulic jump: a standing, churning step that destroys energy. Where it stands depends on the tailwater: deeper tailwater pushes the jump back towards the gate, and finally drowns it.',
    steps: [
      'Select the reach below the gate: M3 jet, then the jump, then tranquil flow.',
      'Raise the tail weir’s crest: the jump marches upstream.',
      'Raise it too far and the gate drowns — the jet disappears under the tailwater.',
    ],
    goal: {
      text: 'Hold the jump within 15 m of the gate — without drowning the gate',
      check: (r) => {
        const j = r.channel?.reaches.e2?.jump
        const drowned = !!r.nodes.sg?.extra?.submerged
        return { done: !!j && j.x <= 15 && !drowned, readout: drowned ? 'gate drowned' : j ? `jump ${j.x.toFixed(0)} m below the gate · ${(j.power / 1000).toFixed(1)} kW lost` : 'no jump' }
      },
    },
    select: 'e2',
    build: () =>
      new Rig()
        .add('in', 'inflow', 120, 300, { elevation: 0.15, flow: 0.6 }, 'Headworks')
        .add('sg', 'gate', 400, 300, { elevation: 0.1, opening: 0.15, width: 1 }, 'Sluice gate')
        .add('w', 'weir', 800, 300, { elevation: 0.02, variant: 'broad', crestHeight: 0.15, crestWidth: 1 }, 'Tail weir')
        .add('out', 'outfall', 1040, 300, { elevation: 0 }, 'Drop')
        .channel('in', 'sg', { length: 50, width: 1, bankHeight: 3, lining: 'glass' })
        .channel('sg', 'w', { length: 80, width: 1, bankHeight: 3, lining: 'glass' })
        .channel('w', 'out', { length: 20, width: 1, bankHeight: 3, lining: 'glass' })
        .done(),
  },
  {
    id: 'chute',
    no: '43',
    title: 'Spillway chute',
    concept: 'Mild → steep → mild',
    formula: 'Fr = v / √(g · A/T)',
    brief:
      'Where a gentle channel tips into a steep chute the flow passes through critical depth at the brink, then accelerates down an S2 curve. At the bottom it meets a gentle channel again and must jump back. If the jump forms in the tail channel it scours the bed; engineers raise the tailwater so that it sits on the concrete chute instead.',
    steps: [
      'Select each reach in turn: M2 drawdown, S2 acceleration, then the jump.',
      'Note the scour warning on the gravel tail channel.',
      'Raise the end sill until the jump climbs onto the chute (an S1 curve appears behind it).',
    ],
    goal: {
      text: 'Move the hydraulic jump out of the gravel channel and onto the concrete chute — without overtopping',
      check: (r) => {
        const [chute, tail] = [r.channel?.reaches.e2, r.channel?.reaches.e3]
        const top = Math.max(0, ...Object.values(r.channel?.reaches ?? {}).flatMap((c) => c.depth))
        return {
          done: !!chute?.jump && !tail?.jump && top <= 1.5,
          readout: chute?.jump ? `jump on the chute, ${chute.jump.x.toFixed(0)} m down it` : tail?.jump ? `jump in the tail channel, ${tail.jump.x.toFixed(0)} m along` : 'no jump',
        }
      },
    },
    select: 'e2',
    build: () =>
      new Rig()
        .add('in', 'inflow', 100, 160, { elevation: 6.1, flow: 1.5 }, 'Reservoir outlet')
        .add('brink', 'junction', 380, 160, { elevation: 6 }, 'Brink')
        .add('toe', 'junction', 620, 420, { elevation: 0.2 }, 'Toe')
        .add('sill', 'weir', 880, 420, { elevation: 0, variant: 'broad', crestHeight: 0.1, crestWidth: 3 }, 'End sill')
        .add('out', 'outfall', 1100, 420, { elevation: -0.05 }, 'River')
        .channel('in', 'brink', { length: 100, width: 2, bankHeight: 1.5 }, [], 'Approach')
        .channel('brink', 'toe', { length: 60, width: 2, bankHeight: 1.5 }, ['r', 'l'], 'Chute')
        .channel('toe', 'sill', { length: 100, width: 3, bankHeight: 1.5, lining: 'gravel' }, [], 'Tail channel')
        .channel('sill', 'out', { length: 20, width: 3, bankHeight: 1.5, lining: 'riprap' }, [], 'Apron')
        .done(),
  },
  {
    id: 'steam-main',
    no: '44',
    title: 'Sizing a steam main',
    concept: 'Velocity, pressure drop and temperature',
    formula: 'ṁ = Q̇ / h_fg    ·    v = ṁ / (ρ_g · A)',
    brief:
      'Steam carries heat as latent heat: each kilogram gives up about 2000 kJ when it condenses, so a load’s steam demand is its duty divided by h_fg. Steam is light, so mains run fast — 25 to 35 m/s is normal. Push more through a small pipe and the pressure drop climbs with the square of the velocity; and because saturated steam’s temperature is tied to its pressure, the far end arrives too cool to do its job.',
    steps: [
      'Select the main: 46 m/s, and nearly 3 bar lost along it.',
      'Select the heat exchanger: its steam is below the temperature the process needs.',
      'Give the main a bigger bore and watch velocity, pressure drop and steam temperature recover.',
    ],
    goal: {
      text: 'Keep every pipe at or below 35 m/s and get the heat exchanger its temperature margin',
      check: (r) => {
        const v = Math.max(0, ...Object.values(r.links).map((l) => l.velocity))
        const short = Object.values(r.steam?.loads ?? {}).some((l) => l.short)
        return { done: !!r.steam && v <= 35 && !short, readout: `fastest pipe ${v.toFixed(0)} m/s · exchanger steam ${r.steam?.loads.hx?.tSat.toFixed(0) ?? '—'} °C` }
      },
    },
    fluidId: 'steam',
    select: 'e1',
    build: () =>
      new Rig()
        .add('b', 'reservoir', 160, 300, { pressure: 800e3 }, 'Boiler')
        .add('j', 'junction', 620, 300)
        .add('hx', 'steamload', 900, 200, { variant: 'exchanger', duty: 500e3, processTemp: 160 }, 'Process exchanger')
        .add('uh', 'steamload', 900, 420, { variant: 'heater', duty: 60e3, processTemp: 60 }, 'Unit heater')
        .pipe('b', 'j', { length: 120, diameter: 0.0409, material: 'steel', roughness: 0.045e-3, insulation: 0.05 }, [], 'Steam main')
        .pipe('j', 'hx', { length: 10, diameter: 0.0525, material: 'steel', roughness: 0.045e-3, insulation: 0.05 }, ['t', 'l'])
        .pipe('j', 'uh', { length: 10, diameter: 0.0266, material: 'steel', roughness: 0.045e-3, insulation: 0.05 }, ['b', 'l'])
        .done(),
  },
  {
    id: 'steam-condensate',
    no: '45',
    title: 'Lagging and drip traps',
    concept: 'Heat loss makes condensate',
    formula: 'ṁ_cond = q · L / h_fg',
    brief:
      'A bare steam pipe is a radiator. Every watt it loses condenses steam inside it, and that water has to go somewhere: left in the main it is picked up by 30 m/s steam and thrown at the next bend — water hammer. So mains are lagged to make less of it, and drip traps are fitted to let it out. A trap that is too small, or blocked, is as bad as none.',
    steps: [
      'Select the main: kilowatts lost to the room, and the condensate that makes.',
      'Select the drip trap: it is blocked, so everything the main condenses is carried on into the kettles.',
      'Lag the main, put the trap back to work, and check it can pass what still arrives.',
    ],
    goal: {
      text: 'Lose less than 10 kW from the pipework, with the drip trap inside its capacity and no condensate reaching the kettle',
      check: (r) => {
        const st = r.steam
        const t = st?.traps.t
        const ok = !!st && !!t && st.totals.mainsLoss < 10000 && t.load <= t.capacity && !!st.loads.k && st.loads.k.carryover * 3600 < 1.5 && st.totals.stranded === 0
        return {
          done: ok,
          readout: st ? `pipework loses ${(st.totals.mainsLoss / 1000).toFixed(1)} kW · trap ${t && t.capacity > 0 ? `at ${((t.load / t.capacity) * 100).toFixed(0)} %` : 'blocked'}` : '—',
        }
      },
    },
    fluidId: 'steam',
    select: 'e1',
    build: () =>
      new Rig()
        .add('b', 'reservoir', 160, 260, { pressure: 600e3 }, 'Boiler')
        .add('j', 'junction', 640, 260, {}, 'Drip pocket')
        .add('t', 'trap', 640, 420, { orifice: 0.003, state: 'closed' }, 'Drip trap')
        .add('k', 'steamload', 920, 260, { variant: 'kettle', duty: 120e3, processTemp: 110 }, 'Kettles')
        .pipe('b', 'j', { length: 150, diameter: 0.0779, material: 'steel', roughness: 0.045e-3, insulation: 0 }, [], 'Steam main')
        .pipe('j', 't', { length: 0.5, diameter: 0.0209, material: 'steel', roughness: 0.045e-3, insulation: 0 }, ['b', 't'], 'Drip leg')
        .pipe('j', 'k', { length: 6, diameter: 0.0409, material: 'steel', roughness: 0.045e-3, insulation: 0.05 }, [], 'Branch')
        .done(),
  },
  {
    id: 'steam-prv',
    no: '46',
    title: 'Reducing station and a blowing trap',
    concept: 'Pressure sets temperature',
    formula: 't_sat = f(p)    ·    flash = (h_f1 − h_f2) / h_fg2',
    brief:
      'Steam is distributed at high pressure — small pipes — and reduced where it is used, because with saturated steam choosing the pressure is choosing the temperature. An autoclave sterilising at 134 °C needs steam at about 2.6 bar g; its chamber here is rated for 3.5. Meanwhile one trap on the main has failed open and is quietly venting live steam, all day, every day.',
    steps: [
      'Select the autoclave: the steam is too cool. Raise the reducing valve’s set pressure — but mind the chamber rating.',
      'Select the reducing valve: the steam leaves it superheated, because throttling keeps its enthalpy.',
      'Find the trap that is blowing, read what it costs in a year, and set it back to “working”.',
    ],
    goal: {
      text: 'Give the autoclave its temperature without exceeding 350 kPa there, and stop the live-steam loss',
      check: (r) => {
        const st = r.steam
        const p = r.nodes.ac?.pressure ?? 0
        return {
          done: !!st && !st.loads.ac?.short && p <= 350e3 && st.totals.trapLoss === 0,
          readout: st ? `autoclave ${(p / 1000).toFixed(0)} kPa · ${st.loads.ac?.tSat.toFixed(0)} °C · traps blowing ${(st.totals.trapLoss / 1000).toFixed(1)} kW` : '—',
        }
      },
    },
    fluidId: 'steam',
    select: 'ac',
    build: () =>
      new Rig()
        .add('b', 'reservoir', 140, 260, { pressure: 1000e3 }, 'Boiler')
        .add('j', 'junction', 420, 260, {}, 'Drip pocket')
        .add('t', 'trap', 420, 420, { state: 'open', orifice: 0.005 }, 'Drip trap')
        .add('prv', 'valve', 640, 260, { valveType: 'prv', pressureSetting: 150e3, diameter: 0.04, kOpen: 3 }, 'Reducing valve')
        .add('g', 'gauge', 820, 260, {}, 'Reduced')
        .add('ac', 'steamload', 1040, 260, { variant: 'autoclave', duty: 90e3, processTemp: 134 }, 'Autoclave')
        .pipe('b', 'j', { length: 60, diameter: 0.0409, material: 'steel', roughness: 0.045e-3, insulation: 0.05 }, [], 'HP main')
        .pipe('j', 't', { length: 0.5, diameter: 0.0209, material: 'steel', roughness: 0.045e-3, insulation: 0 }, ['b', 't'], 'Drip leg')
        .pipe('j', 'prv', { length: 3, diameter: 0.0409, material: 'steel', roughness: 0.045e-3, insulation: 0.05 })
        .pipe('prv', 'g', { length: 3, diameter: 0.0525, material: 'steel', roughness: 0.045e-3, insulation: 0.05 })
        .pipe('g', 'ac', { length: 12, diameter: 0.0525, material: 'steel', roughness: 0.045e-3, insulation: 0.05 })
        .done(),
  },
  {
    id: 'dead-leg',
    no: '47',
    title: 'Waiting for hot water',
    concept: 'Plug flow in a dead leg',
    formula: 't ≈ (V_water + wall) / Q',
    brief:
      'Open a hot tap and cold water comes first: everything sitting in the pipe between the cylinder and the tap has to be pushed out, and the cold copper takes its share of heat before the far end runs hot. The wait is the pipe’s volume divided by the flow — so it grows with the square of the diameter. This rig runs in “live heat” mode: temperatures are marched through time rather than shown settled.',
    steps: [
      'Press play and watch the hot front travel down the pipe. Select the pipe and open “Temperature” to see it as a curve.',
      'Note when the tap passes 50 °C — nearly a minute and a half.',
      'Change the pipe, then press reset (⟲) to start again from cold. A smaller bore holds far less water.',
    ],
    goal: {
      text: 'From a cold start, get 50 °C at the tap within 50 seconds — without shortening the run',
      check: (r, _n, _l, history) => {
        const hot = history.find((h) => (h.v['tap:T'] ?? 0) >= 50)
        const now = r.thermal?.nodes.tap
        return { done: !!hot && hot.t <= 50 && (history[0]?.v['tap:T'] ?? 99) < 30, readout: hot ? `hot after ${hot.t.toFixed(0)} s` : `${now?.toFixed(0) ?? '—'} °C at the tap` }
      },
    },
    timeScale: 1,
    heatMode: 'live',
    select: 'e1',
    build: () =>
      new Rig()
        .add('cyl', 'tank', 180, 260, { elevation: 6, initTemp: 60, heaterPower: 3000, heaterSetpoint: 60, diameter: 0.5, initLevel: 1.2, maxLevel: 1.5 }, 'Cylinder')
        .add('tt', 'thermo', 760, 330, { elevation: 0 }, 'At the tap')
        .add('tap', 'outlet', 960, 330, { mode: 'demand', demand: 6 * LPM }, 'Hot tap')
        .pipe('cyl', 'tt', { length: 18, diameter: 0.0199, material: 'copper', roughness: 0.0015e-3, std: 'copperL', size: '¾″' }, [], 'Hot run')
        .pipe('tt', 'tap', { length: 0.3, diameter: 0.0138, material: 'copper', roughness: 0.0015e-3 })
        .done(),
  },
  {
    id: 'warm-up',
    no: '48',
    title: 'Warming up a heating loop',
    concept: 'Thermal mass and boiler output',
    formula: 'C · dT/dt = Q̇_boiler − Q̇_emitted',
    brief:
      'A cold heating system is a lot of water and steel. The boiler’s output goes first into warming all of that, and only what is left over reaches the room; as the radiator warms it emits more, until output and emission meet. A boiler that is too small for its radiator never gets the loop up to temperature at all — it settles early, lukewarm.',
    steps: [
      'Press play: the supply warms first, the return lags by the time the water takes to get round.',
      'Select the return thermometer and watch its trend flatten out — well short of 60 °C.',
      'Give the boiler more output, press reset (⟲) and compare the curve.',
    ],
    goal: {
      text: 'From a cold start, get the return up to 55 °C within 30 minutes',
      check: (r, _n, _l, history) => {
        const hot = history.find((h) => (h.v.tt ?? 0) >= 55)
        return { done: !!hot && hot.t <= 1800 && (history[0]?.v.tt ?? 99) < 30, readout: hot ? `55 °C after ${(hot.t / 60).toFixed(0)} min` : `return at ${r.thermal?.nodes.tt?.toFixed(1) ?? '—'} °C` }
      },
    },
    timeScale: 60,
    heatMode: 'live',
    select: 'tt',
    build: () => {
      const cu = { diameter: 0.0199, std: 'copperL', size: '¾″', material: 'copper', roughness: 0.0015e-3 }
      return new Rig()
        .add('ev', 'vessel', 140, 200, { volume: 0.018, precharge: 100e3, initPressure: 150e3 }, 'Expansion')
        .add('j', 'junction', 140, 420)
        .add('p', 'pump', 300, 420, { pumpType: 'circulator', shutoffRatio: 1.15, runoutRatio: 2.5, designFlow: 12 * LPM, designHead: 4, npshr: 1 }, 'Circulator')
        .add('b', 'fitting', 480, 420, { variant: 'boiler', ratedDp: 10e3, ratedFlow: 30 * LPM, exponent: 2, fouling: 0, diameter: 0.02, supplyTemp: 75, ratedHeat: 5000 }, 'Boiler')
        .add('ts', 'thermo', 680, 420, {}, 'Supply')
        .add('r', 'fitting', 900, 420, { variant: 'radiator', ratedDp: 6e3, ratedFlow: 8 * LPM, exponent: 1.9, fouling: 0, diameter: 0.02, ratedHeat: 8000, roomTemp: 20 }, 'Radiators')
        .add('tt', 'thermo', 900, 140, {}, 'Return')
        .pipe('ev', 'j', { length: 1, ...cu }, ['b', 't'])
        .pipe('j', 'p', { length: 1, ...cu })
        .pipe('p', 'b', { length: 2, ...cu })
        .pipe('b', 'ts', { length: 2, ...cu })
        .pipe('ts', 'r', { length: 20, ...cu }, [], 'Supply')
        .pipe('r', 'tt', { length: 2, ...cu }, ['out', 'r'])
        .pipe('tt', 'j', { length: 20, ...cu }, ['l', 'l'], 'Return')
        .done()
    },
  },
  {
    id: 'heat-main',
    no: '49',
    title: 'Lagging a hot-water main',
    concept: 'Heat loss along a pipe',
    formula: 'T_out = T_room + (T_in − T_room) · e^(−U·L / ṁc)',
    brief:
      'Hot water sent down a long pipe arrives cooler: every metre leaks heat to its surroundings in proportion to how much hotter it is. The temperature decays exponentially with distance, faster when the flow is small (each litre spends longer in the pipe) and much faster when the pipe is bare.',
    steps: [
      'Select the main and open “Temperature”. Switch “live heat” on in the top bar to watch the hot front arrive.',
      'Halve the demand at the far end: the water arrives colder still.',
      'Lag the main and compare.',
    ],
    goal: {
      text: 'Deliver at least 78 °C at the far end',
      check: (r) => {
        const t = r.thermal?.nodes.tt
        return { done: (t ?? 0) >= 78, readout: `${t?.toFixed(1) ?? '—'} °C delivered` }
      },
    },
    select: 'e1',
    build: () =>
      new Rig()
        .add('src', 'reservoir', 160, 300, { head: 30, temp: 85 }, 'Heat plant')
        .add('tt', 'thermo', 760, 300, {}, 'Far end')
        .add('use', 'outlet', 960, 300, { mode: 'demand', demand: 30 * LPM }, 'Substation')
        .pipe('src', 'tt', { length: 400, diameter: 0.0525, material: 'steel', roughness: 0.045e-3, insulation: 0 }, [], 'Buried main')
        .pipe('tt', 'use', { length: 2, diameter: 0.0525, material: 'steel', roughness: 0.045e-3 })
        .done(),
  },
]
