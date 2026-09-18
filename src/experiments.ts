// The "Lab" part of FluidLab: ready-made rigs with something to discover.
import type { Edge, Node } from '@xyflow/react'
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
}

/** vertical position (fraction of height) of the side ports for each kind */
export const PORT_Y: Record<Kind, number> = { reservoir: 0.7, tank: 0.86, junction: 0.5, outlet: 0.5, gauge: 0.5, pump: 0.5, valve: 0.5, meter: 0.5 }

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
  goal?: { text: string; check: (r: Results, nodes: LabNode[], levels: Record<string, number>) => GoalState }
  fluidId?: string
  timeScale?: number
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
  done() {
    return { nodes: this.nodes, edges: this.edges }
  }
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
]
