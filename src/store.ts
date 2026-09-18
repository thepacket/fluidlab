import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import { solver } from './engine/client'
import type { TransientEvent, TransientResult } from './engine/transient'
import { EXPERIMENTS, NODE_SIZE, PORT_Y, type LabEdge, type LabNode } from './experiments'
import { EMPTY_CONTROL, PV_CONSUMERS, PV_SOURCES, SIGNAL_CONSUMERS, sameControl, stepControl, type ControlState } from './model/control'
import { catalogueSpec } from './model/catalog'
import { VESSEL_FILL_LIMIT, tankLevel, tankVolume, vesselWater } from './model/physics'
import { CONTROLLABLE, EMPTY_RESULTS, FLUIDS, KIND_META, ROTATABLE, isControl, defaultPipeProps, defaultProps, type Kind, type Model, type Props, type Results } from './model/types'
import { METRIC, type UnitPrefs } from './model/units'

export type Overlay = 'pressure' | 'velocity' | 'plain'
/** Everything undo/redo restores: the rig itself, not the simulation state around it. */
interface Snapshot {
  nodes: LabNode[]
  edges: LabEdge[]
  fluidId: string
  experimentId: string | null
  projectName: string
}
export interface Sample {
  t: number
  v: Record<string, number>
}

interface State {
  nodes: LabNode[]
  edges: LabEdge[]
  fluidId: string
  units: UnitPrefs
  overlay: Overlay
  results: Results
  engineReady: boolean
  levels: Record<string, number>
  /** live on/off commands from controllers, keyed by the device they switch */
  controls: Record<string, number>
  /** the controllers' own state: block outputs, measurements, PID memory, actuator positions */
  ctrl: ControlState
  simTime: number
  running: boolean
  timeScale: number
  history: Sample[]
  experimentId: string | null
  projectName: string
  /** bumps whenever a whole rig is loaded, so the view can re-fit */
  loadCount: number
  /** which slide-over panel is open on small screens */
  sheet: 'none' | 'parts' | 'insp'
  past: Snapshot[]
  future: Snapshot[]
  /** last water-hammer run, and the replay cursor while it is being played back on the bench (−1 = not playing) */
  surge: TransientResult | null
  surgeBusy: boolean
  surgeFrame: number

  onNodesChange: (c: NodeChange<LabNode>[]) => void
  onEdgesChange: (c: EdgeChange<LabEdge>[]) => void
  onConnect: (c: Connection) => void
  /** `variant` picks a catalogue entry when the kind is a data-driven family (loss devices) */
  addNode: (kind: Kind, x: number, y: number, variant?: string) => void
  updateNode: (id: string, patch: Props) => void
  updateEdge: (id: string, patch: Props) => void
  rename: (id: string, label: string) => void
  remove: (id: string) => void
  rotate: (id: string) => void
  /** Save an undo point. Calls sharing a `tag` within a short window collapse into one (slider drags, typing). */
  checkpoint: (tag?: string) => void
  undo: () => void
  redo: () => void
  select: (id: string | null) => void
  set: (patch: Partial<State>) => void
  loadExperiment: (id: string) => void
  newProject: () => void
  loadProject: (json: string) => void
  exportProject: () => string
  resetSim: () => void
  tick: (dtReal: number) => void
  runSurge: (event: TransientEvent) => void
  /** Play the last run back through the bench: gauges, pipe colours and flow all follow the pressure wave. */
  replaySurge: () => void
  stopSurge: () => void
  solve: () => void
}

let steadyBeforeReplay: Results | null = null
const STORAGE_KEY = 'fluidlab.project.v1'
let lastTag: string | undefined
let lastTagAt = 0
const snapshot = (s: Snapshot): Snapshot => ({ nodes: s.nodes, edges: s.edges, fluidId: s.fluidId, experimentId: s.experimentId, projectName: s.projectName })
let uid = Date.now() % 100000

/** Does this component make lab time matter (so the accelerated clock applies)? */
export const usesClock = (n: LabNode) => n.data.kind === 'tank' || n.data.kind === 'vessel' || isControl(n.data.kind) || (!!n.data.props.pattern && n.data.props.pattern !== 'constant')

export const model = (s: Pick<State, 'nodes' | 'edges' | 'fluidId' | 'levels' | 'controls' | 'simTime'>): Model => ({
  nodes: s.nodes,
  edges: s.edges,
  fluid: FLUIDS.find((f) => f.id === s.fluidId) ?? FLUIDS[0],
  levels: s.levels,
  controls: s.controls,
  // demand patterns follow the clock; minute steps are plenty and avoid a re-solve on every tick
  time: s.nodes.some((n) => n.data.props.pattern && n.data.props.pattern !== 'constant') ? Math.floor(s.simTime / 60) * 60 : 0,
})

/**
 * Classify a new connection. Signal ports only pair output → input, and only where the pairing means something:
 *   instrument `pv` → switch / PID `cin`        controller `sig` → device `ctl`  or  logic / lamp `cin`
 * Fluid ports never accept a signal wire. Returns null for an ordinary pipe; wires come back stored output → input.
 */
export function signalEnds(c: { source: string | null; target: string | null; sourceHandle?: string | null; targetHandle?: string | null }, nodes: LabNode[]) {
  const ends = [
    { id: c.source, h: c.sourceHandle },
    { id: c.target, h: c.targetHandle },
  ]
  const isSignalPort = (h?: string | null) => h === 'sig' || h === 'ctl' || h === 'pv' || h === 'cin'
  if (!ends.some((e) => isSignalPort(e.h))) return null
  const from = ends.find((e) => e.h === 'sig' || e.h === 'pv')
  const to = ends.find((e) => e.h === 'ctl' || e.h === 'cin')
  const kindOf = (id?: string | null) => nodes.find((n) => n.id === id)?.data.kind
  const target = kindOf(to?.id)
  if (!from?.id || !to?.id || !target || from.id === to.id) return 'invalid' as const
  const ok = from.h === 'pv' ? to.h === 'cin' && PV_CONSUMERS.includes(target) : to.h === 'ctl' ? CONTROLLABLE.includes(target) : SIGNAL_CONSUMERS.includes(target)
  return ok ? { from: from.id, fromHandle: from.h as string, to: to.id, toHandle: to.h as string } : ('invalid' as const)
}

/** Sensible thresholds / setpoint the first time a controller is wired to a given kind of measurement. */
function pvDefaults(ctrl: LabNode, src: LabNode): Props {
  const info = PV_SOURCES[src.data.kind]
  if (!info || ctrl.data.props.pvKind === src.data.kind) return {}
  const span = src.data.kind === 'tank' ? src.data.props.maxLevel : info.quantity === 'flow' ? 100 / 60000 : 500e3
  return ctrl.data.kind === 'switch' ? { pvKind: src.data.kind, low: span * 0.3, high: span * 0.7 } : { pvKind: src.data.kind, span, setpoint: span * 0.5 }
}

/** Only hydraulically meaningful state — dragging a node must not trigger a re-solve. */
const signature = (s: State) =>
  JSON.stringify([
    s.nodes.map((n) => [n.id, n.data.kind, n.data.props]),
    s.edges.map((e) => [e.id, e.source, e.target, e.sourceHandle, e.targetHandle, e.data?.props]),
    s.fluidId,
    s.levels,
    s.controls,
    model(s).time,
  ])

function nextLabel(nodes: LabNode[], kind: Kind, prefixOverride?: string) {
  const prefix = prefixOverride ?? KIND_META[kind].prefix
  const used = new Set(nodes.map((n) => n.data.label))
  let i = 1
  while (used.has(`${prefix}${i}`)) i++
  return `${prefix}${i}`
}

export const useLab = create<State>((set, get) => ({
  nodes: [],
  edges: [],
  fluidId: 'water20',
  units: METRIC,
  overlay: 'pressure',
  results: EMPTY_RESULTS,
  engineReady: false,
  levels: {},
  controls: {},
  ctrl: EMPTY_CONTROL,
  simTime: 0,
  running: true,
  timeScale: 60,
  history: [],
  experimentId: null,
  projectName: 'Untitled rig',
  loadCount: 0,
  sheet: 'none',
  past: [],
  future: [],
  surge: null,
  surgeBusy: false,
  surgeFrame: -1,

  onNodesChange: (c) => {
    if (c.some((x) => x.type === 'remove')) get().checkpoint('delete')
    set({ nodes: applyNodeChanges(c, get().nodes) })
  },
  onEdgesChange: (c) => {
    if (c.some((x) => x.type === 'remove')) get().checkpoint('delete')
    set({ edges: applyEdgeChanges(c, get().edges) })
  },
  onConnect: (c) => {
    if (c.source === c.target) return
    const signal = signalEnds(c, get().nodes)
    if (signal === 'invalid') return
    const edges = get().edges
    if (signal && edges.some((e) => e.type === 'signal' && e.source === signal.from && e.target === signal.to)) return
    get().checkpoint()
    if (signal) {
      const wire = { id: `s${++uid}`, type: 'signal', source: signal.from, sourceHandle: signal.fromHandle, target: signal.to, targetHandle: signal.toHandle }
      // a controller listens to one measurement: a new one replaces the old
      const kept = signal.fromHandle === 'pv' ? edges.filter((e) => !(e.type === 'signal' && e.target === signal.to && e.sourceHandle === 'pv')) : edges
      const nodes = get().nodes
      const src = nodes.find((n) => n.id === signal.from)!
      set({
        edges: [...kept.map((e) => ({ ...e, selected: false })), wire as LabEdge],
        nodes: signal.fromHandle === 'pv' ? nodes.map((n) => (n.id === signal.to ? { ...n, data: { ...n.data, props: { ...n.data.props, ...pvDefaults(n, src) } } } : n)) : nodes,
      })
      return
    }
    const n = edges.length + 1
    let label = `Pipe ${n}`
    const used = new Set(edges.map((e) => e.data?.label))
    for (let i = n; used.has(label); i++) label = `Pipe ${i + 1}`
    set({
      edges: addEdge(
        { ...c, id: `e${++uid}`, type: 'pipe', data: { label, props: defaultPipeProps() } },
        edges.map((e) => ({ ...e, selected: false })),
      ) as LabEdge[],
    })
  },
  addNode: (kind, x, y, variant) => {
    get().checkpoint()
    const spec = catalogueSpec(kind, variant)
    const [w, h] = NODE_SIZE[kind]
    const nodes = get().nodes.map((n) => ({ ...n, selected: false }))
    const node: LabNode = {
      id: `n${++uid}`,
      type: kind,
      position: { x: x - w / 2, y: y - h * PORT_Y[kind] },
      selected: true,
      data: { kind, label: nextLabel(nodes, kind, spec?.prefix), props: { ...defaultProps(kind), ...spec?.defaults }, ...(spec?.rot ? { rot: spec.rot } : {}) },
    }
    set({ nodes: [...nodes, node], edges: get().edges.map((e) => ({ ...e, selected: false })) })
  },
  updateNode: (id, patch) => {
    get().checkpoint(`edit:${id}:${Object.keys(patch).join()}`)
    set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, props: { ...n.data.props, ...patch } } } : n)) })
  },
  updateEdge: (id, patch) => {
    get().checkpoint(`edit:${id}:${Object.keys(patch).join()}`)
    set({ edges: get().edges.map((e) => (e.id === id && e.data ? { ...e, data: { ...e.data, props: { ...e.data.props, ...patch } } } : e)) })
  },
  rename: (id, label) => {
    get().checkpoint(`rename:${id}`)
    set({
      nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)),
      edges: get().edges.map((e) => (e.id === id && e.data ? { ...e, data: { ...e.data, label } } : e)),
    })
  },
  remove: (id) => {
    get().checkpoint()
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.id !== id && e.source !== id && e.target !== id),
    })
  },
  rotate: (id) => {
    const node = get().nodes.find((n) => n.id === id)
    if (!node || !ROTATABLE.includes(node.data.kind)) return
    get().checkpoint()
    // the footprint of a non-square part swaps width and height: shift so it turns about its centre
    const [w, h] = NODE_SIZE[node.data.kind]
    const turned = ((node.data.rot ?? 0) / 90) % 2 === 1
    const shift = ((turned ? h : w) - (turned ? w : h)) / 2
    set({
      nodes: get().nodes.map((n) => (n.id === id ? { ...n, position: { x: n.position.x + shift, y: n.position.y - shift }, data: { ...n.data, rot: ((n.data.rot ?? 0) + 90) % 360 } } : n)),
    })
  },
  checkpoint: (tag) => {
    const now = Date.now()
    if (tag && tag === lastTag && now - lastTagAt < 900) {
      lastTagAt = now
      return
    }
    lastTag = tag
    lastTagAt = now
    set({ past: [...get().past.slice(-99), snapshot(get())], future: [] })
  },
  undo: () => {
    const { past, future } = get()
    if (!past.length) return
    lastTag = undefined
    set({ ...past[past.length - 1], past: past.slice(0, -1), future: [snapshot(get()), ...future], levels: {}, history: [] })
  },
  redo: () => {
    const { past, future } = get()
    if (!future.length) return
    lastTag = undefined
    set({ ...future[0], past: [...past, snapshot(get())], future: future.slice(1), levels: {}, history: [] })
  },
  select: (id) =>
    set({
      nodes: get().nodes.map((n) => (n.selected !== (n.id === id) ? { ...n, selected: n.id === id } : n)),
      edges: get().edges.map((e) => (e.selected !== (e.id === id) ? { ...e, selected: e.id === id } : e)),
    }),
  set: (patch) => set(patch),

  loadExperiment: (id) => {
    const ex = EXPERIMENTS.find((e) => e.id === id)
    if (!ex) return
    if (get().nodes.length) get().checkpoint()
    const { nodes, edges } = ex.build()
    set({
      nodes: nodes.map((n) => ({ ...n, selected: n.id === ex.select })),
      edges: edges.map((e) => ({ ...e, selected: e.id === ex.select })),
      fluidId: ex.fluidId ?? 'water20',
      experimentId: id,
      projectName: ex.title,
      loadCount: get().loadCount + 1,
      levels: {},
      simTime: 0,
      history: [],
      timeScale: ex.timeScale ?? 60,
      running: true,
    })
  },
  newProject: () => {
    if (get().nodes.length) get().checkpoint()
    set({ nodes: [], edges: [], experimentId: null, projectName: 'Untitled rig', levels: {}, simTime: 0, history: [] })
  },
  loadProject: (json) => {
    const p = JSON.parse(json)
    if (!Array.isArray(p.nodes) || !Array.isArray(p.edges)) throw new Error('Not a FluidLab project')
    if (get().nodes.length) get().checkpoint()
    set({
      nodes: p.nodes,
      edges: p.edges,
      fluidId: p.fluidId ?? 'water20',
      units: { ...METRIC, ...p.units },
      experimentId: p.experimentId ?? null,
      projectName: p.name ?? 'Imported rig',
      loadCount: get().loadCount + 1,
      levels: p.levels ?? {},
      simTime: 0,
      history: [],
    })
  },
  exportProject: () => {
    const s = get()
    return JSON.stringify(
      {
        app: 'FluidLab',
        version: 1,
        name: s.projectName,
        fluidId: s.fluidId,
        units: s.units,
        experimentId: s.experimentId,
        levels: s.levels,
        nodes: s.nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
        edges: s.edges.map(({ id, type, source, target, sourceHandle, targetHandle, data }) => ({ id, type, source, target, sourceHandle, targetHandle, data })),
      },
      null,
      1,
    )
  },
  resetSim: () => set({ levels: {}, simTime: 0, history: [], ctrl: EMPTY_CONTROL }),

  /** Quasi-steady time stepping: solve → integrate tank volumes → solve again. */
  tick: (dtReal) => {
    const s = get()
    if (s.surgeFrame >= 0 && s.surge) {
      // replay: paint the recorded wave over the steady results, one frame per tick
      const f = s.surge.frames[s.surgeFrame]
      if (!f || !steadyBeforeReplay) return get().stopSurge()
      const base = steadyBeforeReplay
      const results: Results = { ...base, nodes: { ...base.nodes }, devices: { ...base.devices }, links: { ...base.links } }
      for (const [id, p] of Object.entries(f.nodes)) if (results.nodes[id]) results.nodes[id] = { ...results.nodes[id], pressure: p }
      for (const [id, d] of Object.entries(f.devices)) if (results.devices[id]) results.devices[id] = { ...results.devices[id], flow: d.flow, pIn: d.pIn, pOut: d.pOut }
      for (const [id, l] of Object.entries(f.links))
        if (results.links[id])
          results.links[id] = {
            ...results.links[id],
            flow: l.flow,
            pStart: l.pStart,
            pEnd: l.pEnd,
            velocity: Math.abs(l.flow) / Math.max(1e-9, (Math.PI * (s.edges.find((e) => e.id === id)?.data?.props.diameter ?? 0.04) ** 2) / 4),
          }
      results.pMax = Math.max(base.pMax, s.surge.peak.pressure)
      results.pMin = Math.min(base.pMin, s.surge.trough.pressure)
      set({ results, surgeFrame: s.surgeFrame + 1 })
      return
    }
    if (!s.running || !s.results.ok) return
    // tanks and timers live on the accelerated lab clock; a purely steady rig just counts real seconds
    const clocked = s.nodes.some(usesClock)
    const dt = dtReal * (clocked ? s.timeScale : 1)
    const levels = { ...s.levels }
    let moved = false
    for (const n of s.nodes) {
      if (n.data.kind !== 'tank' && n.data.kind !== 'vessel') continue
      const r = s.results.nodes[n.id]
      if (!r) continue
      const p = n.data.props
      // storage is integrated as volume, so tanks of any shape (and gas-cushioned vessels) fill correctly
      let cur: number
      let next: number
      if (n.data.kind === 'vessel') {
        cur = levels[n.id] ?? vesselWater(p, p.initPressure) // a vessel's state is its water volume, m³
        next = Math.min(p.volume * VESSEL_FILL_LIMIT, Math.max(0, cur + r.outflow * dt))
      } else {
        cur = levels[n.id] ?? p.initLevel
        next = Math.max(p.minLevel, tankLevel(p, tankVolume(p, cur) + r.outflow * dt))
      }
      if (Math.abs(next - cur) > 1e-9) moved = true
      levels[n.id] = next
    }
    // one controller scan per tick, on the measurements of the network as last solved
    const ctrl = stepControl({ nodes: s.nodes, edges: s.edges, t: s.simTime + dt, dt, results: s.results, levels, prev: s.ctrl })
    const v: Record<string, number> = {}
    for (const n of s.nodes) {
      const nr = s.results.nodes[n.id]
      const dr = s.results.devices[n.id]
      if (n.data.kind === 'tank') v[n.id] = levels[n.id] ?? n.data.props.initLevel
      else if (ctrl.out[n.id] !== undefined) {
        v[n.id] = ctrl.out[n.id]
        if (ctrl.pv[n.id] !== undefined) v[`${n.id}:pv`] = ctrl.pv[n.id]
      } else if (n.data.kind === 'outlet' || n.data.kind === 'reservoir') v[n.id] = Math.abs(nr?.outflow ?? 0)
      else if (nr) v[n.id] = nr.pressure
      else if (dr) v[n.id] = n.data.kind === 'dpgauge' ? dr.pIn - dr.pOut : n.data.kind === 'element' ? (dr.tapDp ?? 0) : dr.flow
    }
    for (const e of s.edges) if (s.results.links[e.id]) v[e.id] = s.results.links[e.id].flow
    const simTime = s.simTime + dt
    const history = [...s.history.slice(-599), { t: simTime, v }]
    set(moved ? { levels, simTime, history, ctrl, controls: ctrl.commands } : { simTime, history, ctrl, controls: ctrl.commands })
  },

  runSurge: (event) => {
    const s = get()
    if (!s.engineReady || s.surgeBusy) return
    get().stopSurge()
    set({ surgeBusy: true })
    solver.transient(model(s), event).then((surge) => set(surge ? { surge, surgeBusy: false } : { surgeBusy: false }))
  },
  replaySurge: () => {
    const { surge } = get()
    if (!surge?.ok || !surge.frames.length) return
    steadyBeforeReplay = get().results
    set({ surgeFrame: 0, running: false })
  },
  stopSurge: () => {
    if (get().surgeFrame < 0) return
    set({ surgeFrame: -1, results: steadyBeforeReplay ?? get().results })
    steadyBeforeReplay = null
    get().solve()
  },

  solve: () => {
    const s = get()
    if (!s.engineReady) return
    // null = superseded by a newer request whose answer is already on its way
    solver.solve(model(s)).then((results) => results && set({ results }))
  },
}))

// ---- wiring: boot the solver, re-solve on hydraulic change, autosave ------

let lastSig = ''
let lastStruct = ''
let queued = false
function scheduleSolve() {
  if (queued) return
  queued = true
  // a timeout (not rAF) so the bench keeps solving while the tab is in the background
  setTimeout(() => {
    queued = false
    useLab.getState().solve()
  }, 0)
}

export function bootLab() {
  const saved = localStorage.getItem(STORAGE_KEY)
  let restored = false
  if (saved) {
    try {
      useLab.getState().loadProject(saved)
      restored = useLab.getState().nodes.length > 0
    } catch {
      /* fall through to the default rig */
    }
  }
  if (!restored) useLab.getState().loadExperiment('pump')

  useLab.subscribe((s) => {
    // controllers first: if a timer just switched something, that lands in the signature below
    // (dt = 0: nothing integrates, so re-running this on every change is harmless)
    const ctrl = stepControl({ nodes: s.nodes, edges: s.edges, t: s.simTime, dt: 0, results: s.results, levels: s.levels, prev: s.ctrl })
    if (!sameControl(ctrl, s.ctrl)) {
      useLab.setState({ ctrl, controls: ctrl.commands })
      return
    }
    const sig = signature(s)
    if (sig !== lastSig && s.engineReady) {
      lastSig = sig
      // a surge run describes one particular rig: forget it once the rig itself is edited (tank levels moving is fine)
      const struct = JSON.stringify([s.nodes.map((n) => [n.id, n.data.props]), s.edges.map((e) => [e.id, e.source, e.target, e.data?.props]), s.fluidId])
      if (struct !== lastStruct) {
        lastStruct = struct
        if (s.surgeFrame >= 0) steadyBeforeReplay = null
        if (s.surge || s.surgeFrame >= 0) useLab.setState({ surge: null, surgeFrame: -1 })
      }
      scheduleSolve()
    }
  })
  let saveTimer = 0
  useLab.subscribe((s, prev) => {
    if (s.nodes === prev.nodes && s.edges === prev.edges && s.fluidId === prev.fluidId && s.units === prev.units) return
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => localStorage.setItem(STORAGE_KEY, useLab.getState().exportProject()), 400)
  })
  solver.ready().then(() => useLab.setState({ engineReady: true }))
}

export const selectedId = (s: State) => s.nodes.find((n) => n.selected)?.id ?? s.edges.find((e) => e.selected)?.id ?? null
