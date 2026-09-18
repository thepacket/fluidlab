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
  element: [120, 64],
  dpgauge: [96, 96],
  timer: [96, 104],
  manual: [84, 84],
  switch: [92, 88],
  pid: [116, 104],
  logic: [76, 64],
  lamp: [60, 68],
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
  timer: 0.54,
  manual: 0.5,
  switch: 0.5,
  pid: 0.5,
  logic: 0.5,
  lamp: 0.5,
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
  goal?: { text: string; check: (r: Results, nodes: LabNode[], levels: Record<string, number>, history: { t: number; v: Record<string, number> }[]) => GoalState }
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
]
