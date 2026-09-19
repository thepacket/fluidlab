// Everything the bench editor draws on top of the rig: the right-click menu, quick-add, alignment guides,
// group frames, the multi-selection bar, the on-canvas value editor, hints, and the elevation view.
import { NodeToolbar, Position, ViewportPortal, useReactFlow, useViewport } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { addPart, align, canPaste, copy, disconnect, duplicate, group, keyValue, paste, removeSelected, renameGroup, reverse, saveAssembly, selectAll, ungroup, type Alignment } from '../editor'
import { isChannel } from '../model/openchannel'
import { ROTATABLE, isControl } from '../model/types'
import { fmt, toDisplay, toSI, unitLabel } from '../model/units'
import { useLab } from '../store'
import { PALETTE } from './Sidebar'
import { footprint, useEditor } from './editorState'
import { KindIcon } from './icons'
import { useIsMobile } from './useIsMobile'

// ---- right-click menu ---------------------------------------------------------------------------------

const ALIGN_ICONS: Record<Alignment, ReactNode> = {
  ports: <path d="M1 8h14M3 5h4v6H3zM9 6h4v4H9z" />,
  left: <path d="M2 1v14M4 3h9v4H4zM4 9h6v4H4z" />,
  centre: <path d="M8 1v14M3 3h10v4H3zM5 9h6v4H5z" />,
  right: <path d="M14 1v14M3 3h9v4H3zM6 9h6v4H6z" />,
  top: <path d="M1 2h14M3 4h4v9H3zM9 4h4v6H9z" />,
  bottom: <path d="M1 14h14M3 3h4v9H3zM9 6h4v6H9z" />,
  'spread-x': <path d="M1 1v14M15 1v14M4 4h3v8H4zM9 4h3v8H9z" />,
  'spread-y': <path d="M1 1h14M1 15h14M4 4h8v3H4zM4 9h8v3H4z" />,
}
const ALIGN_TITLES: Record<Alignment, string> = {
  ports: 'Line the ports up, so the pipes between run straight',
  left: 'Align left edges',
  centre: 'Align centres',
  right: 'Align right edges',
  top: 'Align tops',
  bottom: 'Align bottoms',
  'spread-x': 'Space evenly, left to right',
  'spread-y': 'Space evenly, top to bottom',
}

function AlignButtons({ count, done }: { count: number; done?: () => void }) {
  return (
    <div className="align-row">
      {(Object.keys(ALIGN_ICONS) as Alignment[]).map((a) => (
        <button key={a} title={ALIGN_TITLES[a]} disabled={a.startsWith('spread') && count < 3} onClick={() => (align(a), done?.())}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
            {ALIGN_ICONS[a]}
          </svg>
        </button>
      ))}
    </div>
  )
}

function nameAndSave() {
  const name = window.prompt('Name this assembly — it will appear in the parts list:', 'My assembly')?.trim()
  if (name) saveAssembly(name)
}

export function ContextMenu() {
  const menu = useEditor((s) => s.menu)
  const labels = useEditor((s) => s.labels)
  const elevation = useEditor((s) => s.elevation)
  const { fitView } = useReactFlow()
  useEffect(() => {
    if (!menu) return
    const close = () => useEditor.setState({ menu: null })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', close, { passive: true })
    return () => (window.removeEventListener('pointerdown', close), window.removeEventListener('keydown', onKey), window.removeEventListener('wheel', close))
  }, [menu])
  if (!menu) return null
  const s = useLab.getState()
  const close = () => useEditor.setState({ menu: null })
  const item = (label: string, run: () => void, opts: { key?: string; off?: boolean; danger?: boolean } = {}) => (
    <button key={label} className={opts.danger ? 'danger' : ''} disabled={opts.off} onClick={() => Date.now() - useEditor.getState().menuAt > 350 && (close(), run())}>
      {label}
      {opts.key && <kbd>{opts.key}</kbd>}
    </button>
  )
  const items: ReactNode[] = []
  const { target } = menu
  if (target.type === 'node') {
    const node = s.nodes.find((n) => n.id === target.id)
    const picked = s.nodes.filter((n) => n.selected)
    if (!node) return null
    const gid = node.data.group as string | undefined
    const solo = picked.length < 2 || (!!gid && picked.every((n) => n.data.group === gid))
    if (picked.length >= 2) {
      items.push(<AlignButtons key="align" count={picked.length} done={close} />, <hr key="h0" />)
      if (!gid || !solo) items.push(item('Group', group, { key: '⌘G' }))
    }
    if (picked.length < 2) {
      const kv = keyValue(node)
      if (kv) items.push(item(`Set ${kv.label.toLowerCase()}…`, () => useEditor.setState({ edit: node.id }), { key: 'dbl-click' }))
      if (ROTATABLE.includes(node.data.kind)) items.push(item('Rotate', () => s.rotate(node.id), { key: 'R' }))
      items.push(item('Take out of its pipes', () => disconnect(node.id), { off: !s.edges.some((e) => e.source === node.id || e.target === node.id) }))
    }
    if (gid)
      items.push(
        item('Ungroup', () => ungroup(gid)),
        item('Rename group…', () => ((n) => n && renameGroup(gid, n))(window.prompt('Group name:', String(node.data.groupName ?? ''))?.trim())),
      )
    if (picked.length >= 2) items.push(item('Save to the parts list…', nameAndSave))
    items.push(<hr key="h1" />, item('Duplicate', duplicate, { key: '⌘D' }), item('Copy', copy, { key: '⌘C' }), <hr key="h2" />, item('Delete', removeSelected, { key: '⌫', danger: true }))
  } else if (target.type === 'edge') {
    const edge = s.edges.find((e) => e.id === target.id)
    if (!edge) return null
    if (edge.type !== 'signal') {
      const client = { x: menu.client.x, y: menu.client.y }
      items.push(
        item(isChannel(edge) ? 'Insert a joint here' : 'Insert a junction here', () => addPart('junction', menu.flow, client)),
        item('Insert a part here…', () => useEditor.setState({ quick: { x: menu.x, y: menu.y, flow: menu.flow, client } })),
        item('Reverse direction', () => reverse(edge.id)),
        item('Straighten the route', () => (s.checkpoint(), s.routeEdge(edge.id, null)), { off: !edge.data?.route }),
        <hr key="h1" />,
      )
    }
    items.push(item('Delete', removeSelected, { key: '⌫', danger: true }))
  } else {
    items.push(
      item('Add a part…', () => useEditor.setState({ quick: { x: menu.x, y: menu.y, flow: menu.flow } }), { key: '/' }),
      item('Paste here', () => paste(menu.flow), { key: '⌘V', off: !canPaste() }),
      item('Select all', selectAll, { key: '⌘A', off: !s.nodes.length }),
      <hr key="h1" />,
      item('Fit the rig in view', () => fitView({ duration: 350, padding: 0.2, maxZoom: 1.2 })),
      item(labels ? 'Hide pipe labels' : 'Show pipe labels', () => useEditor.setState({ labels: !labels })),
      item(elevation ? 'Hide the elevation view' : 'Show the elevation view', () => useEditor.setState({ elevation: !elevation })),
    )
  }
  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {items}
    </div>
  )
}

// ---- quick-add ----------------------------------------------------------------------------------------

export function QuickAdd() {
  const quick = useEditor((s) => s.quick)
  const assemblies = useEditor((s) => s.assemblies)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => (setQuery(''), setCursor(0)), [quick])
  const all = useMemo(
    () => [
      ...PALETTE.flatMap((g) => g.items.map((i) => ({ ...i, group: g.name }))),
      ...assemblies.map((a) => ({ key: `assembly:${a.name}`, kind: 'junction' as const, name: a.name, blurb: `${a.nodes.length} parts`, group: 'Assemblies' })),
    ],
    [assemblies],
  )
  if (!quick) return null
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const score = (i: (typeof all)[number]) => {
    const name = i.name.toLowerCase()
    const hay = `${name} ${i.blurb} ${i.group} ${i.kind}`.toLowerCase()
    if (!words.every((w) => hay.includes(w))) return -1
    return (name.startsWith(words[0] ?? '') ? 4 : 0) + (words.every((w) => name.includes(w)) ? 2 : 0) + (i.key.includes(':') ? 0 : 1)
  }
  const hits = all
    .map((i) => ({ i, s: score(i) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 9)
    .map((x) => x.i)
  const close = () => useEditor.setState({ quick: null })
  const choose = (key: string) => {
    close()
    if (key.startsWith('assembly:')) window.dispatchEvent(new CustomEvent('fluidlab:assembly', { detail: { name: key.slice(9), flow: quick.flow } }))
    else addPart(key, quick.flow, quick.client)
  }
  return (
    <>
      <div className="quick-scrim" onPointerDown={close} onContextMenu={(e) => (e.preventDefault(), close())} />
      <div className="quick-add" style={{ left: quick.x, top: quick.y }}>
        <input
          autoFocus
          placeholder={quick.client ? 'Insert into this pipe…' : 'Add a part…'}
          value={query}
          onChange={(e) => (setQuery(e.target.value), setCursor(0))}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'Enter' && hits[cursor]) choose(hits[cursor].key)
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((cursor + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % Math.max(1, hits.length))
            }
          }}
        />
        <div ref={list} className="quick-list">
          {hits.map((h, i) => (
            <button key={h.key} className={i === cursor ? 'on' : ''} onMouseEnter={() => setCursor(i)} onClick={() => choose(h.key)}>
              <KindIcon kind={h.kind} />
              <b>{h.name}</b>
              <span>{h.group}</span>
            </button>
          ))}
          {!hits.length && <p className="muted">Nothing in the library matches.</p>}
        </div>
      </div>
    </>
  )
}

// ---- guides and group frames (drawn on the bench itself, so they pan and zoom with it) ------------------

export function BenchMarks() {
  const guides = useEditor((s) => s.guides)
  const nodes = useLab((s) => s.nodes)
  const frames = useMemo(() => {
    const by = new Map<string, { name: string; x0: number; y0: number; x1: number; y1: number }>()
    for (const n of nodes) {
      const g = n.data.group as string | undefined
      if (!g) continue
      const f = footprint(n)
      const b = by.get(g) ?? { name: String(n.data.groupName ?? 'Assembly'), x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      by.set(g, { name: b.name, x0: Math.min(b.x0, f.x), y0: Math.min(b.y0, f.y), x1: Math.max(b.x1, f.x + f.w), y1: Math.max(b.y1, f.y + f.h) })
    }
    return [...by.entries()]
  }, [nodes])
  return (
    <ViewportPortal>
      {frames.map(([id, b]) => (
        <div key={id} className="group-frame" style={{ transform: `translate(${b.x0 - 22}px,${b.y0 - 30}px)`, width: b.x1 - b.x0 + 44, height: b.y1 - b.y0 + 72 }}>
          <span>{b.name}</span>
        </div>
      ))}
      {guides.x !== undefined && <div className="guide guide-x" style={{ transform: `translate(${guides.x}px,-5000px)` }} />}
      {guides.y !== undefined && <div className="guide guide-y" style={{ transform: `translate(-5000px,${guides.y}px)` }} />}
    </ViewportPortal>
  )
}

// ---- bar shown while several parts are selected -------------------------------------------------------

export function SelectionBar() {
  const count = useLab((s) => s.nodes.reduce((t, n) => t + (n.selected ? 1 : 0), 0))
  if (count < 2) return null
  return (
    <div className="select-bar">
      <b>{count} parts</b>
      <AlignButtons count={count} />
      <i />
      <button onClick={group} title="Group — the parts move, copy and delete as one (⌘G)">
        Group
      </button>
      <button onClick={nameAndSave} title="Keep these parts and their pipes in the parts list">
        Save
      </button>
      <button onClick={duplicate} title="Duplicate (⌘D)">
        Duplicate
      </button>
    </div>
  )
}

// ---- the key value, edited on the bench ----------------------------------------------------------------

export function InlineEdit() {
  const id = useEditor((s) => s.edit)
  const node = useLab((s) => s.nodes.find((n) => n.id === id))
  const units = useLab((s) => s.units)
  const update = useLab((s) => s.updateNode)
  const mobile = useIsMobile()
  useEffect(() => {
    if (!id) return
    const close = () => useEditor.setState({ edit: null })
    const onKey = (e: KeyboardEvent) => (e.key === 'Escape' || e.key === 'Enter') && close()
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => (window.removeEventListener('pointerdown', close), window.removeEventListener('keydown', onKey))
  }, [id])
  const kv = node ? keyValue(node) : null
  if (!node || !kv) return null
  const value: number = node.data.props[kv.prop] ?? 0
  const setValue = (si: number) => {
    if (!Number.isFinite(si)) return
    update(node.id, { [kv.prop]: si })
    // a tank's level is live state: start it again from the level just set
    if (node.data.kind === 'tank') useLab.setState({ levels: Object.fromEntries(Object.entries(useLab.getState().levels).filter(([k]) => k !== node.id)) })
  }
  const shown = toDisplay(value, kv.q, units)
  const body = (
    <div className={`inline-edit nodrag nopan ${mobile ? 'docked' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
      <span>
        {node.data.label} · {kv.label}
      </span>
      <input type="range" min={kv.min} max={Math.max(kv.max, value)} step={kv.step} value={value} onChange={(e) => setValue(Number(e.target.value))} />
      <input
        autoFocus={!window.matchMedia('(pointer: coarse)').matches} // on a touch screen the slider comes first; the keyboard only when asked for
        type="number"
        inputMode="decimal"
        value={Number(shown.toPrecision(4))}
        step={toDisplay(kv.step, kv.q, units)}
        onChange={(e) => setValue(toSI(Number(e.target.value), kv.q, units))}
        onFocus={(e) => e.target.select()}
      />
      <em>{unitLabel(kv.q, units)}</em>
    </div>
  )
  // on a phone there is no room beside the part: the editor docks across the bench instead
  return mobile ? (
    body
  ) : (
    <NodeToolbar nodeId={node.id} isVisible position={Position.Top} offset={14}>
      {body}
    </NodeToolbar>
  )
}

export function Toast() {
  const toast = useEditor((s) => s.toast)
  return toast ? <div className="bench-toast">{toast}</div> : null
}

// ---- elevation view -----------------------------------------------------------------------------------

const ELEV_H = 168
const PAD = { top: 26, bottom: 22 }

/**
 * A side view that lines up with the bench above it: every part sits at its elevation, pipes join them, and the
 * hydraulic grade line shows where the water would stand in a tube tapped into the pipe. Drag a part up or down
 * to change its elevation.
 */
export function ElevationStrip() {
  const open = useEditor((s) => s.elevation)
  const nodes = useLab((s) => s.nodes)
  const edges = useLab((s) => s.edges)
  const results = useLab((s) => s.results)
  const levels = useLab((s) => s.levels)
  const units = useLab((s) => s.units)
  const update = useLab((s) => s.updateNode)
  const select = useLab((s) => s.select)
  const vp = useViewport()
  const frozen = useRef<{ lo: number; hi: number } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  if (!open) return null

  const parts = nodes.filter((n) => !isControl(n.data.kind) && 'elevation' in n.data.props)
  const liquid = results.ok && !results.gas && !results.steam
  const headOf = (id: string) => (liquid ? results.nodes[id]?.head : undefined)
  const zs = parts.flatMap((n) => [n.data.props.elevation as number, headOf(n.id)]).filter((v): v is number => v !== undefined && Number.isFinite(v))
  const span = frozen.current ?? { lo: Math.min(0, ...zs), hi: Math.max(1, ...zs) }
  const room = Math.max(1, span.hi - span.lo)
  const y = (z: number) => PAD.top + (1 - (z - span.lo) / room) * (ELEV_H - PAD.top - PAD.bottom)
  const x = (n: (typeof parts)[number]) => footprint(n).cx * vp.zoom + vp.x
  const at = new Map(parts.map((n) => [n.id, n]))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => span.lo + t * room)

  return (
    <div className="elev-strip" style={{ height: ELEV_H }}>
      <header>
        <b>Elevation</b>
        <span className="key key-pipe">pipework</span>
        {liquid && <span className="key key-hgl">hydraulic grade line</span>}
        <em>drag a part up or down to move it</em>
        <button className="icon-btn" onClick={() => useEditor.setState({ elevation: false })} aria-label="Close the elevation view">
          ×
        </button>
      </header>
      <svg width="100%" height={ELEV_H}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1="0" x2="100%" y1={y(t)} y2={y(t)} className={Math.abs(t) < 1e-9 ? 'elev-zero' : 'elev-grid'} />
            <text x="8" y={y(t) - 3} className="elev-tick">
              {fmt(t, 'length', units, 3)} {unitLabel('length', units)}
            </text>
          </g>
        ))}
        {edges.map((e) => {
          const [a, b] = [at.get(e.source), at.get(e.target)]
          if (e.type === 'signal' || !a || !b) return null
          const [ha, hb] = [headOf(a.id), headOf(b.id)]
          return (
            <g key={e.id}>
              <line x1={x(a)} y1={y(a.data.props.elevation)} x2={x(b)} y2={y(b.data.props.elevation)} className="elev-pipe" />
              {ha !== undefined && hb !== undefined && <line x1={x(a)} y1={y(ha)} x2={x(b)} y2={y(hb)} className="elev-hgl" />}
            </g>
          )
        })}
        {parts.map((n) => {
          const z = n.data.props.elevation as number
          const water = n.data.kind === 'tank' ? (levels[n.id] ?? n.data.props.initLevel) : n.data.kind === 'reservoir' && headOf(n.id) !== undefined ? headOf(n.id)! - z : 0
          return (
            <g
              key={n.id}
              className={`elev-part ${n.selected ? 'on' : ''} ${dragging === n.id ? 'dragging' : ''}`}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                frozen.current = span // the scale must hold still while a part is dragged against it
                setDragging(n.id)
                select(n.id)
              }}
              onPointerMove={(e) => {
                if (dragging !== n.id) return
                const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect()
                const raw = span.lo + (1 - (e.clientY - box.top - PAD.top) / (ELEV_H - PAD.top - PAD.bottom)) * room
                const step = room > 20 ? 0.5 : 0.1
                update(n.id, { elevation: Math.round(raw / step) * step })
              }}
              onPointerUp={() => ((frozen.current = null), setDragging(null))}
            >
              {water > 0 && <line x1={x(n)} x2={x(n)} y1={y(z)} y2={y(z + water)} className="elev-water" />}
              <circle cx={x(n)} cy={y(z)} r="16" fill="transparent" />
              <circle cx={x(n)} cy={y(z)} r="4.5" className="elev-dot" />
              <text x={x(n)} y={y(z) + 16} textAnchor="middle" className="elev-name">
                {n.data.label}
              </text>
              <title>{`${n.data.label} — elevation ${fmt(z, 'length', units, 3)} ${unitLabel('length', units)}${headOf(n.id) !== undefined ? `, head ${fmt(headOf(n.id)!, 'length', units, 3)} ${unitLabel('length', units)}` : ''}`}</title>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
