// What the bench editor is doing right now — menus, guides, hints. None of it is part of the rig, so none of it
// is saved, undone or sent to the solver.
import { create } from 'zustand'
import { NODE_SIZE, PORT_Y, type LabEdge, type LabNode } from '../experiments'
import { ROTATABLE } from '../model/types'

export interface Pt {
  x: number
  y: number
}
export interface MenuState {
  /** where to draw it, in pixels from the bench's top-left corner */
  x: number
  y: number
  /** the same point on the bench itself */
  flow: Pt
  /** and on the screen */
  client: Pt
  target: { type: 'node' | 'edge' | 'pane'; id?: string }
}
export interface Assembly {
  name: string
  nodes: LabNode[]
  edges: LabEdge[]
}

const ASSEMBLY_KEY = 'fluidlab.assemblies.v1'
const readAssemblies = (): Assembly[] => {
  try {
    const list = JSON.parse(localStorage.getItem(ASSEMBLY_KEY) ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

interface EditorState {
  menu: MenuState | null
  /** `client` is set when the part is to be cut into the pipe at that point of the screen */
  quick: { x: number; y: number; flow: Pt; client?: Pt } | null
  guides: { x?: number; y?: number }
  /** the pipe a dragged part would be spliced into if it were let go now */
  dropEdge: string | null
  /** the kind of port a connection is being pulled from */
  connecting: string | null
  toast: string | null
  /** the part whose key value is being edited on the bench */
  edit: string | null
  /** the part last clicked: the inspector shows it even when its whole group is selected */
  picked: string | null
  hoverEdge: string | null
  elevation: boolean
  labels: boolean
  assemblies: Assembly[]
  setAssemblies: (list: Assembly[]) => void
  say: (text: string) => void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export const useEditor = create<EditorState>((set) => ({
  menu: null,
  quick: null,
  guides: {},
  dropEdge: null,
  connecting: null,
  toast: null,
  edit: null,
  picked: null,
  hoverEdge: null,
  elevation: false,
  labels: true,
  assemblies: readAssemblies(),
  setAssemblies: (assemblies) => {
    try {
      localStorage.setItem(ASSEMBLY_KEY, JSON.stringify(assemblies))
    } catch {
      /* private mode: the list lasts for the session */
    }
    set({ assemblies })
  },
  say: (toast) => {
    clearTimeout(toastTimer)
    set({ toast })
    toastTimer = setTimeout(() => set({ toast: null }), 3200)
  },
}))

/** A part's outline and port line as drawn on the bench — a part turned 90° swaps its width and height. */
export function footprint(n: LabNode, at: Pt = n.position) {
  const [bw, bh] = NODE_SIZE[n.data.kind]
  const turned = ROTATABLE.includes(n.data.kind) && ((n.data.rot ?? 0) / 90) % 2 === 1
  const [w, h] = turned ? [bh, bw] : [bw, bh]
  return { x: at.x, y: at.y, w, h, cx: at.x + w / 2, cy: at.y + h / 2, port: at.y + h * (turned ? 0.5 : PORT_Y[n.data.kind]) }
}

/** What is being dragged out of the parts list — a drag's payload cannot be read until it is dropped. */
export const paletteDrag = { key: null as string | null }
/** Where the pointer last was over the bench, in screen pixels: paste and quick-add land there. */
export const pointer = { x: 0, y: 0, over: false }
