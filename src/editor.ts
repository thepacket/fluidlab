// Bench editing commands: splice a part into a pipe, copy and paste, align, group, save an assembly.
// Each one that changes the rig saves an undo point first; none of them touches anything the solver reads
// unless the rig really changed.
import type { LabEdge, LabNode } from './experiments'
import { PV_CONSUMERS, SIGNAL_CONSUMERS } from './model/control'
import { isChannel, isChannelKind } from './model/openchannel'
import { CONTROLLABLE, KIND_META, ROTATABLE, isControl, type Kind } from './model/types'
import type { Quantity } from './model/units'
import { newId, nextLabel, useLab } from './store'
import { footprint, snapToGrid, useEditor, type Assembly, type Pt } from './ui/editorState'
import { routeOf } from './ui/route'

// ---- splice a part into a pipe ---------------------------------------------------------------------

/** The two ports a part would be cut into a pipe by — null for anything that is an end of the line. */
export function throughPorts(kind: Kind): [string, string] | null {
  if (isControl(kind) || ['reservoir', 'outlet', 'relief', 'inflow', 'outfall', 'steamload'].includes(kind)) return null
  if (kind === 'jetpump') return ['m', 'd']
  if (kind === 'threeway') return ['a', 'ab']
  if (kind === 'dpgauge' || kind === 'weir' || kind === 'gate' || ROTATABLE.includes(kind)) return ['in', 'out']
  return ['l', 'r']
}
const HAS_TOP: Kind[] = ['tank', 'junction', 'gauge', 'thermo', 'tee', 'leak', 'airvalve', 'trap']

/** May this kind of part be cut into this pipe? Weirs and gates belong in channels, and only they do. */
export function fitsEdge(kind: Kind, edge: LabEdge | undefined): boolean {
  if (!edge || edge.type === 'signal' || !throughPorts(kind)) return false
  const open = isChannel(edge)
  if (open) return isChannelKind(kind) || kind === 'junction' || kind === 'gauge'
  return !isChannelKind(kind)
}

/** The pipe under a point of the screen, if any. */
export function edgeAt(clientX: number, clientY: number): string | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const id = el.closest?.('.react-flow__edge')?.getAttribute('data-id')
    if (id && useLab.getState().edges.some((e) => e.id === id && e.type !== 'signal')) return id
  }
  return null
}

function pipeLabel(edges: LabEdge[], like: string) {
  const used = new Set(edges.map((e) => e.data?.label))
  // "Pipe 4" takes the next free number; a pipe someone named keeps its name and gains a part number
  const generic = like.match(/^(Pipe|Reach|Return) \d+$/)?.[1]
  const word = generic ?? like.replace(/ · \d+$/, '')
  let i = generic ? edges.length + 1 : 2
  while (used.has(`${word}${generic ? ' ' : ' · '}${i}`)) i++
  return `${word}${generic ? ' ' : ' · '}${i}`
}

/**
 * Cut a part that is already on the bench into a pipe: the pipe keeps its properties, each half takes half the
 * length, and the part is turned and placed so that the run stays straight. `at` is where it was dropped.
 */
export function splice(nodeId: string, edgeId: string, at: Pt, checkpoint = true): boolean {
  const s = useLab.getState()
  const node = s.nodes.find((n) => n.id === nodeId)
  const edge = s.edges.find((e) => e.id === edgeId)
  if (!node || !edge?.data || !fitsEdge(node.data.kind, edge) || edge.source === nodeId || edge.target === nodeId) return false
  const kind = node.data.kind
  let [pin, pout] = throughPorts(kind)!
  // the run of the pipe nearest the drop point says which way the part should face
  const pts = routeOf(edgeId)
  let a = pts?.[0]
  let b = pts?.[pts.length - 1]
  let best = Infinity
  for (let i = 1; pts && i < pts.length; i++) {
    const [p, q] = [pts[i - 1], pts[i]]
    const len2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2 || 1
    const t = Math.max(0, Math.min(1, ((at.x - p.x) * (q.x - p.x) + (at.y - p.y) * (q.y - p.y)) / len2))
    const d = Math.hypot(at.x - (p.x + t * (q.x - p.x)), at.y - (p.y + t * (q.y - p.y)))
    if (d < best) [best, a, b] = [d, p, q]
  }
  if (!a || !b) return false
  const level = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
  const forward = level ? b.x >= a.x : b.y >= a.y
  let rot = node.data.rot ?? 0
  if (ROTATABLE.includes(kind)) rot = level ? (forward ? 0 : 180) : forward ? 90 : 270
  else if (pin === 'l' && !level && HAS_TOP.includes(kind)) [pin, pout] = forward ? ['t', 'b'] : ['b', 't']
  else if (!forward && level) [pin, pout] = [pout, pin]
  const turned: LabNode = { ...node, data: { ...node.data, rot: ROTATABLE.includes(kind) ? rot : node.data.rot } }
  const f = footprint(turned)
  // sit the port line on the pipe; along the pipe, stay where the part was dropped
  const tidy = (v: number) => Math.round(v * 10) / 10
  const position = level ? { x: snapToGrid(at.x - f.w / 2), y: tidy(a.y - (f.port - f.y)) } : { x: tidy(a.x - f.w / 2), y: snapToGrid(at.y - f.h / 2) }
  if (checkpoint) s.checkpoint()
  const half = { ...edge.data.props, length: Math.max(0.1, (edge.data.props.length ?? 10) / 2) }
  const first: LabEdge = { ...edge, target: nodeId, targetHandle: pin, selected: false, data: { ...edge.data, route: undefined, props: half } }
  const second: LabEdge = {
    ...edge,
    id: newId('e'),
    source: nodeId,
    sourceHandle: pout,
    selected: false,
    data: { ...edge.data, route: undefined, label: pipeLabel(s.edges, edge.data.label), props: { ...half } },
  }
  useLab.setState({
    nodes: s.nodes.map((n) => (n.id === nodeId ? { ...turned, position } : n)),
    edges: [...s.edges.map((e) => (e.id === edgeId ? first : e)), second],
  })
  return true
}

/** Add a part from the library; if it lands on a pipe it fits, cut it in. */
export function addPart(key: string, flow: Pt, client?: Pt) {
  const [kind, variant] = key.split(':') as [Kind, string?]
  const edgeId = client ? edgeAt(client.x, client.y) : null
  useLab.getState().addNode(kind, flow.x, flow.y, variant)
  const fresh = useLab.getState().nodes.at(-1)!
  if (
    edgeId &&
    fitsEdge(
      kind,
      useLab.getState().edges.find((e) => e.id === edgeId),
    )
  )
    splice(fresh.id, edgeId, flow, false)
}

// ---- copy, paste, duplicate ---------------------------------------------------------------------------

const CLIP_KEY = 'fluidlab.clipboard.v1'
let pasteCount = 0

function selection(): Assembly | null {
  const s = useLab.getState()
  const nodes = s.nodes.filter((n) => n.selected)
  if (!nodes.length) return null
  const ids = new Set(nodes.map((n) => n.id))
  return { name: '', nodes, edges: s.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }
}

export function copy(): boolean {
  const clip = selection()
  if (!clip) return false
  pasteCount = 0
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(clip)) // so a paste works in another tab too
  } catch {
    /* no storage: copy still works within this tab */
  }
  memory = clip
  return true
}
let memory: Assembly | null = null
const clipboard = (): Assembly | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(CLIP_KEY) ?? 'null')
    if (stored?.nodes?.length) return stored
  } catch {
    /* fall through to this tab's copy */
  }
  return memory
}
export const canPaste = () => !!clipboard()

/** Put a set of parts on the bench under new names. `at` centres them there; otherwise they land beside the originals. */
export function place(clip: Assembly, at?: Pt) {
  const s = useLab.getState()
  s.checkpoint()
  const boxes = clip.nodes.map((n) => footprint(n))
  const cx = (Math.min(...boxes.map((b) => b.x)) + Math.max(...boxes.map((b) => b.x + b.w))) / 2
  const cy = (Math.min(...boxes.map((b) => b.y)) + Math.max(...boxes.map((b) => b.y + b.h))) / 2
  const step = 30 * ++pasteCount
  const [dx, dy] = at ? [snapToGrid(at.x - cx), snapToGrid(at.y - cy)] : [step, step]
  const ids = new Map<string, string>()
  for (const n of clip.nodes) ids.set(n.id, newId('n'))
  for (const g of new Set(clip.nodes.map((n) => n.data.group).filter(Boolean))) ids.set(g as string, newId('g'))
  // anything inside the properties that names a copied part must name the copy
  const remap = (v: unknown): unknown =>
    typeof v === 'string' ? (ids.get(v) ?? v) : Array.isArray(v) ? v.map(remap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x)])) : v
  let nodes = s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n))
  for (const n of clip.nodes) {
    const prefix = n.data.label.match(/^(.*?)\d+$/)?.[1] ?? `${n.data.label} `
    const copyOf: LabNode = {
      ...n,
      id: ids.get(n.id)!,
      position: { x: n.position.x + dx, y: n.position.y + dy },
      selected: true,
      dragging: false,
      data: { ...n.data, label: nextLabel(nodes, n.data.kind, prefix), props: remap(n.data.props) as LabNode['data']['props'], group: n.data.group ? ids.get(n.data.group as string) : undefined },
    }
    nodes = [...nodes, copyOf]
  }
  let edges = s.edges.map((e) => (e.selected ? { ...e, selected: false } : e))
  for (const e of clip.edges) {
    const data = e.data ? { ...e.data, route: undefined, label: pipeLabel(edges, e.data.label) } : undefined
    edges = [...edges, { ...e, id: newId(e.type === 'signal' ? 's' : 'e'), source: ids.get(e.source)!, target: ids.get(e.target)!, selected: false, data } as LabEdge]
  }
  useLab.setState({ nodes, edges })
}

export function paste(at?: Pt) {
  const clip = clipboard()
  if (clip) place(clip, at)
}
export function duplicate() {
  const clip = selection()
  if (!clip) return
  pasteCount = 0
  place(clip)
}

export function selectAll() {
  const s = useLab.getState()
  useLab.setState({ nodes: s.nodes.map((n) => ({ ...n, selected: true })), edges: s.edges.map((e) => ({ ...e, selected: true })) })
}

export function removeSelected() {
  const s = useLab.getState()
  const gone = new Set(s.nodes.filter((n) => n.selected).map((n) => n.id))
  if (!gone.size && !s.edges.some((e) => e.selected)) return
  s.checkpoint()
  useLab.setState({ nodes: s.nodes.filter((n) => !gone.has(n.id)), edges: s.edges.filter((e) => !e.selected && !gone.has(e.source) && !gone.has(e.target)) })
}

/** Take a part out of its pipes without deleting it. */
export function disconnect(id: string) {
  const s = useLab.getState()
  if (!s.edges.some((e) => e.source === id || e.target === id)) return
  s.checkpoint()
  useLab.setState({ edges: s.edges.filter((e) => e.source !== id && e.target !== id) })
}

/** Swap a pipe's ends: its positive flow direction turns round. */
export function reverse(id: string) {
  const s = useLab.getState()
  s.checkpoint()
  useLab.setState({ edges: s.edges.map((e) => (e.id === id ? { ...e, source: e.target, sourceHandle: e.targetHandle, target: e.source, targetHandle: e.sourceHandle } : e)) })
}

// ---- align and distribute -----------------------------------------------------------------------------

export type Alignment = 'left' | 'centre' | 'right' | 'top' | 'ports' | 'bottom' | 'spread-x' | 'spread-y'

export function align(how: Alignment) {
  const s = useLab.getState()
  const picked = s.nodes.filter((n) => n.selected)
  if (picked.length < 2) return
  const box = new Map(picked.map((n) => [n.id, footprint(n)]))
  const all = [...box.values()]
  const move = new Map<string, Pt>()
  if (how === 'spread-x' || how === 'spread-y') {
    if (picked.length < 3) return
    const key = how === 'spread-x' ? 'cx' : 'cy'
    const order = [...picked].sort((m, n) => box.get(m.id)![key] - box.get(n.id)![key])
    const first = box.get(order[0].id)![key]
    const gap = (box.get(order.at(-1)!.id)![key] - first) / (order.length - 1)
    order.forEach((n, i) => {
      const d = Math.round(first + gap * i - box.get(n.id)![key])
      move.set(n.id, how === 'spread-x' ? { x: n.position.x + d, y: n.position.y } : { x: n.position.x, y: n.position.y + d })
    })
  } else {
    const target = {
      left: Math.min(...all.map((b) => b.x)),
      right: Math.max(...all.map((b) => b.x + b.w)),
      centre: all.reduce((t, b) => t + b.cx, 0) / all.length,
      top: Math.min(...all.map((b) => b.y)),
      bottom: Math.max(...all.map((b) => b.y + b.h)),
      ports: box.get(picked[0].id)!.port, // the first part picked stays put; the others line their ports up with it
    }[how]
    for (const n of picked) {
      const b = box.get(n.id)!
      const x = how === 'left' ? target : how === 'right' ? target - b.w : how === 'centre' ? target - b.w / 2 : n.position.x
      const y = how === 'top' ? target : how === 'bottom' ? target - b.h : how === 'ports' ? target - (b.port - b.y) : n.position.y
      move.set(n.id, { x: Math.round(x), y: Math.round(y) })
    }
  }
  s.checkpoint()
  useLab.setState({ nodes: s.nodes.map((n) => (move.has(n.id) ? { ...n, position: move.get(n.id)! } : n)) })
}

// ---- groups and saved assemblies ----------------------------------------------------------------------

export function group() {
  const s = useLab.getState()
  const picked = s.nodes.filter((n) => n.selected)
  if (picked.length < 2) return
  s.checkpoint()
  const id = newId('g')
  const taken = new Set(s.nodes.map((n) => n.data.groupName))
  let i = 1
  while (taken.has(`Assembly ${i}`)) i++
  useLab.setState({ nodes: s.nodes.map((n) => (n.selected ? { ...n, data: { ...n.data, group: id, groupName: `Assembly ${i}` } } : n)) })
}
export function ungroup(groupId: string) {
  const s = useLab.getState()
  s.checkpoint()
  useLab.setState({ nodes: s.nodes.map((n) => (n.data.group === groupId ? { ...n, data: { ...n.data, group: undefined, groupName: undefined } } : n)) })
}
export function renameGroup(groupId: string, name: string) {
  const s = useLab.getState()
  s.checkpoint(`group:${groupId}`)
  useLab.setState({ nodes: s.nodes.map((n) => (n.data.group === groupId ? { ...n, data: { ...n.data, groupName: name } } : n)) })
}

/** Keep the selected parts, with the pipes and wires between them, in the parts list for other rigs. */
export function saveAssembly(name: string) {
  const clip = selection()
  if (!clip) return
  const ed = useEditor.getState()
  const clean = { name, nodes: clip.nodes.map((n) => ({ ...n, selected: false, dragging: false, measured: undefined })), edges: clip.edges.map((e) => ({ ...e, selected: false })) }
  ed.setAssemblies([...ed.assemblies.filter((a) => a.name !== name), clean as Assembly])
  ed.say(`“${name}” is in the parts list, under Assemblies`)
}

// ---- hints ---------------------------------------------------------------------------------------------

const SIGNAL_PORTS = ['sig', 'ctl', 'pv', 'cin', 'cin2', 'rsp']

/** Why a connection between these two ports is refused, in words — null when it is fine. */
export function whyNot(a: { node: LabNode; port: string }, b: { node: LabNode; port: string }): string | null {
  if (a.node.id === b.node.id) return 'A part cannot be connected to itself'
  const sa = SIGNAL_PORTS.includes(a.port)
  const sb = SIGNAL_PORTS.includes(b.port)
  if (sa !== sb) return 'Square ports carry signals and round ports carry fluid — a pipe cannot join one to the other'
  if (!sa) return null
  const from = [a, b].find((e) => e.port === 'sig' || e.port === 'pv')
  const to = [a, b].find((e) => e.port !== 'sig' && e.port !== 'pv')
  if (!from) return 'Both of these are inputs — a wire runs from an output to an input'
  if (!to) return 'Both of these are outputs — a wire runs from an output to an input'
  const bare = KIND_META[to.node.data.kind].name.toLowerCase()
  const name = `${/^[aeiou]/.test(bare) ? 'an' : 'a'} ${bare}`
  if (from.port === 'pv') return to.port === 'cin' && PV_CONSUMERS.includes(to.node.data.kind) ? null : `A measurement goes to the input of a switch or a PID controller, not to ${name}`
  if (to.port === 'ctl') return CONTROLLABLE.includes(to.node.data.kind) || to.node.data.props.variant === 'boiler' ? null : `${name[0].toUpperCase()}${name.slice(1)} cannot be commanded`
  if (to.port === 'cin' && !SIGNAL_CONSUMERS.includes(to.node.data.kind)) return `${name[0].toUpperCase()}${name.slice(1)} reads a measurement here, not a command — wire it from an instrument`
  return null
}

const PORT_NAMES: Record<string, string> = {
  in: 'Inlet',
  out: 'Outlet',
  l: 'Pipe connection',
  r: 'Pipe connection',
  t: 'Top connection',
  b: 'Bottom connection',
  o: 'Discharge — run an open channel from here',
  m: 'Motive (driving) flow in',
  s: 'Suction — the flow being lifted',
  d: 'Discharge',
  a: 'Port A',
  ab: 'Common port AB',
  ctl: 'Command input — wire a controller here',
  pv: 'Measurement output — wire to a switch or PID',
  sig: 'Signal output',
  cin: 'Signal input',
  cin2: 'Reset input',
  rsp: 'Remote setpoint input',
}
export function portName(kind: Kind | undefined, port: string): string {
  if (kind === 'threeway' && port === 'b') return 'Port B'
  if (kind === 'tank' && port === 't') return 'Top connection — the hot end of a stratified tank'
  if (kind === 'steamload' && port === 'b') return 'Condensate out — to a trap'
  return PORT_NAMES[port] ?? 'Connection'
}

// ---- the value worth changing without opening the inspector --------------------------------------------

export interface KeyValue {
  prop: string
  label: string
  q: Quantity
  min: number
  max: number
  step: number
}
export function keyValue(node: LabNode): KeyValue | null {
  const p = node.data.props
  switch (node.data.kind) {
    case 'valve':
      return { prop: 'opening', label: 'Opening', q: 'percent', min: 0, max: 1, step: 0.01 }
    case 'threeway':
      return { prop: 'position', label: 'Position towards A', q: 'percent', min: 0, max: 1, step: 0.01 }
    case 'pump':
      return { prop: 'speed', label: 'Speed', q: 'percent', min: 0, max: 1.2, step: 0.01 }
    case 'steamload':
      return { prop: 'load', label: 'Load', q: 'percent', min: 0, max: 1, step: 0.01 }
    case 'tank':
      return { prop: 'initLevel', label: 'Level', q: 'length', min: p.minLevel ?? 0, max: p.maxLevel ?? 3, step: 0.05 }
    case 'reservoir':
      return p.sourceType === 'surface' || !p.sourceType ? { prop: 'head', label: 'Water surface', q: 'length', min: 0, max: 60, step: 0.5 } : null
    case 'gate':
      return { prop: 'opening', label: 'Gate opening', q: 'length', min: 0, max: 1, step: 0.01 }
    case 'inflow':
      return { prop: 'flow', label: 'Flow', q: 'flow', min: 0, max: 0.5, step: 0.005 }
    case 'junction':
      return { prop: 'demand', label: 'Demand', q: 'flow', min: 0, max: 0.005, step: 0.00005 }
    case 'weir':
      return { prop: 'crestHeight', label: 'Crest height', q: 'length', min: 0.05, max: 1.5, step: 0.01 }
    case 'relief':
      return { prop: 'setPressure', label: 'Set pressure', q: 'pressure', min: 50e3, max: 1500e3, step: 10e3 }
    default:
      return 'elevation' in p ? { prop: 'elevation', label: 'Elevation', q: 'length', min: -20, max: 60, step: 0.5 } : null
  }
}
