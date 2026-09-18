import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import { engine } from './engine/epanet'
import { EXPERIMENTS, NODE_SIZE, PORT_Y, type LabEdge, type LabNode } from './experiments'
import { area } from './model/physics'
import { EMPTY_RESULTS, FLUIDS, KIND_META, defaultPipeProps, defaultProps, type Kind, type Model, type Props, type Results } from './model/types'
import { METRIC, type UnitPrefs } from './model/units'

export type Overlay = 'pressure' | 'velocity' | 'plain'
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
  simTime: number
  running: boolean
  timeScale: number
  history: Sample[]
  experimentId: string | null
  projectName: string
  /** bumps whenever a whole rig is loaded, so the view can re-fit */
  loadCount: number

  onNodesChange: (c: NodeChange<LabNode>[]) => void
  onEdgesChange: (c: EdgeChange<LabEdge>[]) => void
  onConnect: (c: Connection) => void
  addNode: (kind: Kind, x: number, y: number) => void
  updateNode: (id: string, patch: Props) => void
  updateEdge: (id: string, patch: Props) => void
  rename: (id: string, label: string) => void
  remove: (id: string) => void
  select: (id: string | null) => void
  set: (patch: Partial<State>) => void
  loadExperiment: (id: string) => void
  newProject: () => void
  loadProject: (json: string) => void
  exportProject: () => string
  resetSim: () => void
  tick: (dtReal: number) => void
  solve: () => void
}

const STORAGE_KEY = 'fluidlab.project.v1'
let uid = Date.now() % 100000

export const model = (s: Pick<State, 'nodes' | 'edges' | 'fluidId' | 'levels'>): Model => ({
  nodes: s.nodes,
  edges: s.edges,
  fluid: FLUIDS.find((f) => f.id === s.fluidId) ?? FLUIDS[0],
  levels: s.levels,
})

/** Only hydraulically meaningful state — dragging a node must not trigger a re-solve. */
const signature = (s: State) =>
  JSON.stringify([s.nodes.map((n) => [n.id, n.data.kind, n.data.props]), s.edges.map((e) => [e.id, e.source, e.target, e.sourceHandle, e.targetHandle, e.data?.props]), s.fluidId, s.levels])

function nextLabel(nodes: LabNode[], kind: Kind) {
  const prefix = KIND_META[kind].prefix
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
  simTime: 0,
  running: true,
  timeScale: 60,
  history: [],
  experimentId: null,
  projectName: 'Untitled rig',
  loadCount: 0,

  onNodesChange: (c) => set({ nodes: applyNodeChanges(c, get().nodes) }),
  onEdgesChange: (c) => set({ edges: applyEdgeChanges(c, get().edges) }),
  onConnect: (c) => {
    if (c.source === c.target) return
    const edges = get().edges
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
  addNode: (kind, x, y) => {
    const [w, h] = NODE_SIZE[kind]
    const nodes = get().nodes.map((n) => ({ ...n, selected: false }))
    const node: LabNode = {
      id: `n${++uid}`,
      type: kind,
      position: { x: x - w / 2, y: y - h * PORT_Y[kind] },
      selected: true,
      data: { kind, label: nextLabel(nodes, kind), props: defaultProps(kind) },
    }
    set({ nodes: [...nodes, node], edges: get().edges.map((e) => ({ ...e, selected: false })) })
  },
  updateNode: (id, patch) => set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, props: { ...n.data.props, ...patch } } } : n)) }),
  updateEdge: (id, patch) => set({ edges: get().edges.map((e) => (e.id === id && e.data ? { ...e, data: { ...e.data, props: { ...e.data.props, ...patch } } } : e)) }),
  rename: (id, label) =>
    set({
      nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)),
      edges: get().edges.map((e) => (e.id === id && e.data ? { ...e, data: { ...e.data, label } } : e)),
    }),
  remove: (id) =>
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.id !== id && e.source !== id && e.target !== id),
    }),
  select: (id) =>
    set({
      nodes: get().nodes.map((n) => (n.selected !== (n.id === id) ? { ...n, selected: n.id === id } : n)),
      edges: get().edges.map((e) => (e.selected !== (e.id === id) ? { ...e, selected: e.id === id } : e)),
    }),
  set: (patch) => set(patch),

  loadExperiment: (id) => {
    const ex = EXPERIMENTS.find((e) => e.id === id)
    if (!ex) return
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
  newProject: () => set({ nodes: [], edges: [], experimentId: null, projectName: 'Untitled rig', levels: {}, simTime: 0, history: [] }),
  loadProject: (json) => {
    const p = JSON.parse(json)
    if (!Array.isArray(p.nodes) || !Array.isArray(p.edges)) throw new Error('Not a FluidLab project')
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
  resetSim: () => set({ levels: {}, simTime: 0, history: [] }),

  /** Quasi-steady time stepping: solve → integrate tank volumes → solve again. */
  tick: (dtReal) => {
    const s = get()
    if (!s.running || !s.results.ok) return
    const hasTanks = s.nodes.some((n) => n.data.kind === 'tank')
    const dt = dtReal * (hasTanks ? s.timeScale : 1)
    const levels = { ...s.levels }
    let moved = false
    for (const n of s.nodes) {
      if (n.data.kind !== 'tank') continue
      const r = s.results.nodes[n.id]
      if (!r) continue
      const p = n.data.props
      const cur = levels[n.id] ?? p.initLevel
      const next = Math.min(p.maxLevel, Math.max(p.minLevel, cur + (r.outflow * dt) / area(p.diameter)))
      if (Math.abs(next - cur) > 1e-7) moved = true
      levels[n.id] = next
    }
    const v: Record<string, number> = {}
    for (const n of s.nodes) {
      const nr = s.results.nodes[n.id]
      const dr = s.results.devices[n.id]
      if (n.data.kind === 'tank') v[n.id] = levels[n.id] ?? n.data.props.initLevel
      else if (n.data.kind === 'outlet' || n.data.kind === 'reservoir') v[n.id] = Math.abs(nr?.outflow ?? 0)
      else if (nr) v[n.id] = nr.pressure
      else if (dr) v[n.id] = dr.flow
    }
    for (const e of s.edges) if (s.results.links[e.id]) v[e.id] = s.results.links[e.id].flow
    const simTime = s.simTime + dt
    const history = [...s.history.slice(-359), { t: simTime, v }]
    set(moved ? { levels, simTime, history } : { simTime, history })
  },

  solve: () => {
    const s = get()
    if (!s.engineReady) return
    set({ results: engine.solve(model(s)) })
  },
}))

// ---- wiring: boot the solver, re-solve on hydraulic change, autosave ------

let lastSig = ''
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
    const sig = signature(s)
    if (sig !== lastSig && s.engineReady) {
      lastSig = sig
      scheduleSolve()
    }
  })
  let saveTimer = 0
  useLab.subscribe((s, prev) => {
    if (s.nodes === prev.nodes && s.edges === prev.edges && s.fluidId === prev.fluidId && s.units === prev.units) return
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => localStorage.setItem(STORAGE_KEY, useLab.getState().exportProject()), 400)
  })
  engine.ready().then(() => useLab.setState({ engineReady: true }))
}

export const selectedId = (s: State) => s.nodes.find((n) => n.selected)?.id ?? s.edges.find((e) => e.selected)?.id ?? null
