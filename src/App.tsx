import { Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, SelectionMode, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addPart, pipeMiddle, removeSelected, copy, duplicate, edgeAt, fitsEdge, group, paste, place, portName, selectAll, splice, throughPorts, whyNot } from './editor'
import { EXPERIMENTS } from './experiments'
import type { Kind } from './model/types'
import { fmt, unitLabel } from './model/units'
import { selectedId, signalEnds, useLab } from './store'
import { Inspector } from './ui/Inspector'
import { PipeEdge } from './ui/PipeEdge'
import { SignalEdge } from './ui/SignalEdge'
import { Sidebar } from './ui/Sidebar'
import { BenchMarks, ContextMenu, ElevationStrip, InlineEdit, QuickAdd, SelectionBar, Toast } from './ui/EditorLayer'
import { GRID, paletteDrag, pointer, useEditor } from './ui/editorState'
import { TopBar } from './ui/TopBar'
import { rampCss, thermalCss } from './ui/colors'
import { Icon } from './ui/icons'
import { nodeTypes } from './ui/nodes'
import { useIsMobile, useIsTouch } from './ui/useIsMobile'

const edgeTypes = { pipe: PipeEdge, signal: SignalEdge }

function ExperimentCard() {
  const id = useLab((s) => s.experimentId)
  const results = useLab((s) => s.results)
  const nodes = useLab((s) => s.nodes)
  const levels = useLab((s) => s.levels)
  const history = useLab((s) => s.history)
  const surge = useLab((s) => s.surge)
  const close = useLab((s) => s.set)
  const mobile = useIsMobile()
  const [open, setOpen] = useState(!mobile)
  const ex = EXPERIMENTS.find((e) => e.id === id)
  const goal = useMemo(() => (ex?.goal && results.ok ? ex.goal.check(results, nodes, levels, history, surge) : null), [ex, results, nodes, levels, history, surge])
  if (!ex) return null
  return (
    <div className={`exp-card ${goal?.done ? 'done' : ''}`}>
      <div className="exp-head" onClick={() => setOpen(!open)}>
        <i>{ex.no}</i>
        <div>
          <b>{ex.title}</b>
          <span>{ex.concept}</span>
        </div>
        <button className={`icon-btn ${open ? 'flip' : ''}`}>{Icon.chevron}</button>
      </div>
      {open && (
        <div className="exp-body">
          {ex.formula && <div className="formula">{ex.formula}</div>}
          <p>{ex.brief}</p>
          <ol>
            {ex.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <button className="link" onClick={() => close({ experimentId: null })}>
            Dismiss — keep the rig as a free build
          </button>
        </div>
      )}
      {ex.goal && (
        <div className="goal">
          <div className="goal-check">{goal?.done ? Icon.check : null}</div>
          <div>
            <span>{goal?.done ? 'Goal reached' : 'Goal'}</span>
            <b>{ex.goal.text}</b>
          </div>
          <em>{goal?.readout ?? '—'}</em>
        </div>
      )}
    </div>
  )
}

function Legend() {
  const overlay = useLab((s) => s.overlay)
  const r = useLab((s) => s.results)
  const units = useLab((s) => s.units)
  if (overlay === 'plain' || !r.ok) return null
  if (overlay === 'thermal')
    return r.thermal ? (
      <div className="legend">
        <span>{r.steam ? 'steam' : 'water'} temperature · °C</span>
        <div className="legend-bar" style={{ background: thermalCss }} />
        <div className="legend-scale">
          <b>{r.thermal.tMin.toFixed(0)}</b>
          <b>{((r.thermal.tMin + r.thermal.tMax) / 2).toFixed(0)}</b>
          <b>{r.thermal.tMax.toFixed(0)}</b>
        </div>
      </div>
    ) : null
  const q = overlay === 'pressure' ? 'pressure' : 'velocity'
  return (
    <div className="legend">
      <span>
        {overlay} · {unitLabel(q, units)}
      </span>
      <div className="legend-bar" style={{ background: rampCss(overlay) }} />
      <div className="legend-scale">
        <b>0</b>
        <b>{fmt((overlay === 'pressure' ? r.pMax : r.vMax) / 2, q, units, 2)}</b>
        <b>{fmt(overlay === 'pressure' ? r.pMax : r.vMax, q, units, 2)}</b>
      </div>
      {overlay === 'pressure' && r.pMin < -500 && (
        <span className="legend-neg">
          <i /> below atmospheric
        </span>
      )}
    </div>
  )
}

function Alerts() {
  const r = useLab((s) => s.results)
  const select = useLab((s) => s.select)
  const { fitView } = useReactFlow()
  const [all, setAll] = useState(false)
  // show the culprit, not just name it: a pipe is framed by the two parts it joins
  const focus = (id: string) => {
    select(id)
    const edge = useLab.getState().edges.find((e) => e.id === id)
    fitView({ nodes: edge ? [{ id: edge.source }, { id: edge.target }] : [{ id }], duration: 450, maxZoom: 1.3, padding: 0.6 })
  }
  const list = [...(r.error ? [{ level: 'error' as const, text: r.error, id: undefined }] : []), ...r.warnings]
  const order = { error: 0, warn: 1, info: 2 }
  const shown = list.sort((a, b) => order[a.level] - order[b.level]).slice(0, all ? list.length : 4)
  if (!shown.length) return null
  return (
    <div className={`alerts ${all ? 'all' : ''}`}>
      {shown.map((w, i) => (
        <button key={i} className={`alert ${w.level} ${w.id ? 'goes' : ''}`} title={w.id ? 'Show this on the bench' : undefined} onClick={() => w.id && focus(w.id)}>
          <i>{w.level === 'info' ? 'i' : '!'}</i>
          {w.text}
        </button>
      ))}
      {list.length > 4 && (
        <button className="link" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `+${list.length - 4} more — list all ${list.length}`}
        </button>
      )}
    </div>
  )
}

function Bench() {
  const nodes = useLab((s) => s.nodes)
  const edges = useLab((s) => s.edges)
  const onNodesChange = useLab((s) => s.onNodesChange)
  const onEdgesChange = useLab((s) => s.onEdgesChange)
  const onConnect = useLab((s) => s.onConnect)
  const addNode = useLab((s) => s.addNode)
  const { screenToFlowPosition, fitView } = useReactFlow()
  const onReconnect = useLab((s) => s.onReconnect)
  const connecting = useEditor((s) => s.connecting)
  const elevation = useEditor((s) => s.elevation)
  const gridLight = useEditor((s) => s.gridLight)
  const boxSelect = useEditor((s) => s.boxSelect)
  const anySelected = useLab((s) => s.nodes.some((n) => n.selected) || s.edges.some((e) => e.selected))
  const setGridLight = useEditor((s) => s.setGridLight)
  const reconnecting = useRef<string | null>(null)
  const benchRef = useRef<HTMLElement>(null)

  /** open the menu or quick-add at a point of the screen, kept inside the bench */
  const spot = useCallback(
    (clientX: number, clientY: number, w = 240, h = 330) => {
      const box = benchRef.current!.getBoundingClientRect()
      return {
        x: Math.max(8, Math.min(clientX - box.left, box.width - w)),
        y: Math.max(8, Math.min(clientY - box.top, box.height - h)),
        flow: screenToFlowPosition({ x: clientX, y: clientY }),
        client: { x: clientX, y: clientY },
      }
    },
    [screenToFlowPosition],
  )
  const openMenuAt = useCallback(
    (x: number, y: number, target: { type: 'node' | 'edge' | 'pane'; id?: string }) => {
      const s = useLab.getState()
      const hit = target.id ? (s.nodes.find((n) => n.id === target.id) ?? s.edges.find((e) => e.id === target.id)) : null
      if (hit && !hit.selected) s.select(target.id!)
      // on a phone the details sheet lies over the foot of the bench: keep the menu above it
      useEditor.setState({ menu: { ...spot(x, y, 240, window.innerWidth <= 860 ? 440 : 330), target }, menuAt: Date.now(), quick: null, edit: null })
    },
    [spot],
  )
  const openMenu = (e: MouseEvent | React.MouseEvent, target: { type: 'node' | 'edge' | 'pane'; id?: string }) => {
    e.preventDefault()
    openMenuAt(e.clientX, e.clientY, target)
  }

  // Fingers have no right button and no reliable double-click: a long press opens the menu, and a double tap does
  // what a double-click does. Listened for in the capture phase, because the bench swallows pointer events it uses.
  useEffect(() => {
    const el = benchRef.current!
    const OWN = '.ctx-menu, .quick-add, .elev-strip, .exp-card, .alerts, .legend, .select-bar, .bench-tools, .fab, .box-toggle, .react-flow__controls, .react-flow__handle, .inline-edit, .pipe-bend'
    const what = (t: HTMLElement) => {
      if (t.closest(OWN)) return null
      const node = t.closest('.react-flow__node')?.getAttribute('data-id')
      const edge = t.closest('.react-flow__edge')?.getAttribute('data-id')
      return node ? { type: 'node' as const, id: node } : edge ? { type: 'edge' as const, id: edge } : t.closest('.react-flow__pane') ? { type: 'pane' as const } : null
    }
    let press: { x: number; y: number; at: number; timer: number } | null = null
    let lastTap = { x: 0, y: 0, at: 0 }
    const cancel = () => (press && clearTimeout(press.timer), (press = null))
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      cancel()
      if (!e.isPrimary) return // a second finger: this is a pinch
      const target = what(e.target as HTMLElement)
      if (!target) return
      const timer = window.setTimeout(() => {
        press = null
        lastTap.at = 0
        navigator.vibrate?.(8)
        openMenuAt(e.clientX, e.clientY, target)
      }, 480)
      press = { x: e.clientX, y: e.clientY, at: Date.now(), timer }
    }
    const move = (e: PointerEvent) => press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10 && cancel()
    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !press) return cancel()
      const quick = Date.now() - press.at < 300
      cancel()
      if (!quick) return
      const now = Date.now()
      const twice = now - lastTap.at < 340 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30
      lastTap = twice ? { x: 0, y: 0, at: 0 } : { x: e.clientX, y: e.clientY, at: now }
      const target = twice ? what(e.target as HTMLElement) : null
      if (target?.type === 'node') useEditor.setState({ edit: target.id, menu: null })
      else if (target?.type === 'pane') useEditor.setState({ quick: spot(e.clientX, e.clientY, 300, 360), menu: null })
    }
    el.addEventListener('pointerdown', down, true)
    el.addEventListener('pointermove', move, true)
    el.addEventListener('pointerup', up, true)
    el.addEventListener('pointercancel', cancel, true)
    return () => (
      cancel(),
      el.removeEventListener('pointerdown', down, true),
      el.removeEventListener('pointermove', move, true),
      el.removeEventListener('pointerup', up, true),
      el.removeEventListener('pointercancel', cancel, true)
    )
  }, [openMenuAt, spot])

  // a loose part dragged over a pipe it fits lights the pipe up; letting go cuts it in
  const spliceTarget = (nodeId: string, x: number, y: number) => {
    const s = useLab.getState()
    const node = s.nodes.find((n) => n.id === nodeId)
    if (!node || !throughPorts(node.data.kind) || s.nodes.filter((n) => n.selected).length > 1) return null
    if (s.edges.some((e) => e.type !== 'signal' && (e.source === nodeId || e.target === nodeId))) return null
    const id = edgeAt(x, y)
    return id &&
      fitsEdge(
        node.data.kind,
        s.edges.find((e) => e.id === id),
      )
      ? id
      : null
  }
  const xy = (e: MouseEvent | TouchEvent | React.MouseEvent) => ('clientX' in e ? { x: e.clientX, y: e.clientY } : { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY })

  // name a port when the pointer rests on it
  useEffect(() => {
    const el = benchRef.current!
    const onOver = (e: MouseEvent) => {
      const h = (e.target as HTMLElement).closest?.('.react-flow__handle') as HTMLElement | null
      if (!h || h.title) return
      const kind = useLab.getState().nodes.find((n) => n.id === h.dataset.nodeid)?.data.kind
      h.title = portName(kind, h.dataset.handleid ?? '')
    }
    el.addEventListener('mouseover', onOver)
    return () => el.removeEventListener('mouseover', onOver)
  }, [])

  useEffect(() => {
    const onAssembly = (e: Event) => {
      const { name, flow } = (e as CustomEvent<{ name: string; flow?: { x: number; y: number } }>).detail
      const a = useEditor.getState().assemblies.find((x) => x.name === name)
      const box = benchRef.current!.getBoundingClientRect()
      if (a) place(a, flow ?? screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }))
    }
    window.addEventListener('fluidlab:assembly', onAssembly)
    return () => window.removeEventListener('fluidlab:assembly', onAssembly)
  }, [screenToFlowPosition])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return // fields keep their own undo
      const s = useLab.getState()
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
      } else if (!mod && e.key.toLowerCase() === 'r') {
        const id = selectedId(s)
        if (id) s.rotate(id)
      } else if (mod && 'cvdag'.includes(e.key.toLowerCase()) && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'c') {
          if (window.getSelection()?.toString()) return // text on the page is selected: let the browser copy it
          if (copy()) useEditor.getState().say('Copied — ⌘V pastes at the pointer')
          return
        }
        e.preventDefault()
        if (k === 'v') paste(pointer.over ? screenToFlowPosition({ x: pointer.x, y: pointer.y }) : undefined)
        else if (k === 'd') duplicate()
        else if (k === 'a') selectAll()
        else group()
      } else if (!mod && e.key === '/') {
        e.preventDefault()
        const box = document.querySelector('.bench')!.getBoundingClientRect()
        const at = pointer.over ? pointer : { x: box.left + box.width / 2, y: box.top + box.height / 3 }
        useEditor.setState({
          quick: { x: Math.max(8, Math.min(at.x - box.left, box.width - 300)), y: Math.max(8, Math.min(at.y - box.top, box.height - 360)), flow: screenToFlowPosition({ x: at.x, y: at.y }) },
          menu: null,
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screenToFlowPosition])

  const initialized = useNodesInitialized()
  const mobile = useIsMobile()
  const touch = useIsTouch() || mobile
  const checkpoint = useLab((s) => s.checkpoint)
  const sheetOpen = useLab((s) => s.sheet === 'insp') && mobile
  const set = useLab((s) => s.set)
  const loadCount = useLab((s) => s.loadCount)

  // Frame the rig whenever a new one is loaded or the layout around the bench changes. The attempts are
  // deliberately not cancelled on re-render: nodes are measured a few frames after they mount, and the
  // last, un-animated pass guarantees the final framing even if an earlier animation was interrupted.
  const fitRef = useRef(fitView)
  useEffect(() => {
    fitRef.current = fitView
  }, [fitView])
  useEffect(() => {
    const px = (n: number) => `${n}px` as const
    // leave room for the experiment card as it actually is — a long brief makes a tall card
    const card = () => Math.round(document.querySelector('.exp-card')?.getBoundingClientRect().height ?? 0)
    const padding = () =>
      mobile
        ? { top: px(useLab.getState().experimentId ? 150 : 24), bottom: px(sheetOpen ? Math.round(window.innerHeight * 0.5) + 24 : 100), left: px(18), right: px(18) }
        : {
            top: px(useLab.getState().experimentId ? Math.min(Math.max(290, card() + 40), Math.round(window.innerHeight * 0.55)) : 70),
            bottom: px(useEditor.getState().elevation ? 280 : 110),
            left: px(60),
            right: px(70),
          }
    for (const [ms, duration] of [
      [60, 350],
      [450, 350],
      [1000, 0],
    ])
      setTimeout(() => fitRef.current({ padding: padding(), duration, maxZoom: 1.2 }), ms)
  }, [initialized, loadCount, mobile, sheetOpen, elevation])

  useEffect(() => {
    const onAdd = (e: Event) => {
      const el = document.querySelector('.bench')!.getBoundingClientRect()
      const p = screenToFlowPosition({ x: el.left + el.width / 2 + (Math.random() - 0.5) * 120, y: el.top + el.height / 2 + (Math.random() - 0.5) * 120 })
      const key = (e as CustomEvent<string>).detail
      // with a pipe selected, a part picked from the list is cut into it — the way in for a finger, which cannot drag from the list
      const s = useLab.getState()
      const pipe = s.nodes.some((n) => n.selected) ? undefined : s.edges.find((x) => x.selected && x.type !== 'signal')
      const middle = pipe && fitsEdge(key.split(':')[0] as Kind, pipe) ? pipeMiddle(pipe.id) : null
      if (pipe && middle) return addPart(key, middle, undefined, pipe.id)
      const [kind, variant] = key.split(':')
      addNode(kind as Kind, p.x, p.y, variant)
    }
    window.addEventListener('fluidlab:add', onAdd)
    return () => window.removeEventListener('fluidlab:add', onAdd)
  }, [addNode, screenToFlowPosition])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const key = e.dataTransfer.getData('application/fluidlab')
      paletteDrag.key = null
      useEditor.setState({ dropEdge: null })
      if (!key) return
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (key.startsWith('assembly:')) window.dispatchEvent(new CustomEvent('fluidlab:assembly', { detail: { name: key.slice(9), flow: p } }))
      else addPart(key, p, { x: e.clientX, y: e.clientY }) // on a pipe it fits, the part is cut in
    },
    [screenToFlowPosition],
  )
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const kind = paletteDrag.key?.split(':')[0] as Kind | undefined
    const id = kind && throughPorts(kind) ? edgeAt(e.clientX, e.clientY) : null
    const fits =
      id &&
      fitsEdge(
        kind!,
        useLab.getState().edges.find((x) => x.id === id),
      )
        ? id
        : null
    if (useEditor.getState().dropEdge !== fits) useEditor.setState({ dropEdge: fits })
  }

  return (
    <main
      ref={benchRef}
      className={`bench ${connecting ? `connecting connecting-${connecting}` : ''} ${elevation ? 'has-elev' : ''}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onMouseMove={(e) => ((pointer.x = e.clientX), (pointer.y = e.clientY), (pointer.over = true))}
      onMouseLeave={() => (pointer.over = false)}
      onDoubleClick={(e) => (e.target as HTMLElement).classList.contains('react-flow__pane') && useEditor.setState({ quick: spot(e.clientX, e.clientY, 300, 360), menu: null })}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={() => checkpoint()}
        onNodeDrag={(e, n) => {
          const p = xy(e)
          const id = spliceTarget(n.id, p.x, p.y)
          if (useEditor.getState().dropEdge !== id) useEditor.setState({ dropEdge: id })
        }}
        onNodeDragStop={(e, n) => {
          const p = xy(e)
          const id = spliceTarget(n.id, p.x, p.y)
          useEditor.setState({ dropEdge: null, guides: {} })
          if (id) splice(n.id, id, screenToFlowPosition(p), false) // the drag already saved an undo point
        }}
        onReconnect={onReconnect}
        onReconnectStart={(_, edge) => (reconnecting.current = edge.type ?? 'pipe')}
        onReconnectEnd={() => (reconnecting.current = null)}
        isValidConnection={(c) => {
          const ends = signalEnds(c, useLab.getState().nodes)
          // a pipe end may only move to a fluid port, a wire end to a signal port
          if (reconnecting.current && (reconnecting.current === 'signal') !== !!ends) return false
          return c.source !== c.target && ends !== 'invalid'
        }}
        onConnectStart={(_, from) => useEditor.setState({ connecting: ['sig', 'ctl', 'pv', 'cin', 'cin2', 'rsp'].includes(from.handleId ?? '') ? from.handleId : 'fluid' })}
        onConnectEnd={(_, state) => {
          useEditor.setState({ connecting: null })
          if (state.isValid || !state.toHandle || !state.toNode || !state.fromHandle || !state.fromNode) return
          const all = useLab.getState().nodes
          const [a, b] = [all.find((n) => n.id === state.fromNode!.id), all.find((n) => n.id === state.toNode!.id)]
          const why = a && b && whyNot({ node: a, port: state.fromHandle.id ?? '' }, { node: b, port: state.toHandle.id ?? '' })
          if (why) useEditor.getState().say(why)
        }}
        onNodeContextMenu={(e, n) => openMenu(e, { type: 'node', id: n.id })}
        onEdgeContextMenu={(e, edge) => openMenu(e, { type: 'edge', id: edge.id })}
        onPaneContextMenu={(e) => openMenu(e, { type: 'pane' })}
        onSelectionContextMenu={(e, picked) => openMenu(e, { type: 'node', id: picked[0]?.id })}
        onNodeDoubleClick={(_, n) => useEditor.setState({ edit: n.id, menu: null })}
        onEdgeMouseEnter={(_, edge) => useEditor.setState({ hoverEdge: edge.id })}
        onEdgeMouseLeave={() => useEditor.setState({ hoverEdge: null })}
        zoomOnDoubleClick={false}
        // a drag on the empty bench draws a selection box, as in any drawing tool; the bench is moved with the middle
        // button or with Space held. On a touch screen one finger moves the bench, unless box-select is switched on.
        selectionOnDrag={touch ? boxSelect : true}
        panOnDrag={touch ? !boxSelect : [1]}
        reconnectRadius={touch ? 26 : 16}
        selectionMode={SelectionMode.Partial}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={34}
        connectionLineStyle={{ stroke: '#35e0ff', strokeWidth: 5, strokeLinecap: 'round', strokeDasharray: '2 10' }}
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={0.25}
        maxZoom={2.5}
        snapToGrid
        snapGrid={[GRID, GRID]}
        proOptions={{ hideAttribution: true }}
        elevateEdgesOnSelect={false}
      >
        {/* drawn at full brightness and faded by the grid slider: half-way is the everyday look */}
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.6} color="#7f9fd6" style={{ opacity: gridLight }} />
        <Background id="major" variant={BackgroundVariant.Lines} gap={200} color="#3b5480" style={{ opacity: gridLight }} />
        {!mobile && <Controls position="bottom-right" showInteractive={false} />}
        <BenchMarks />
        <InlineEdit />
      </ReactFlow>
      <SelectionBar />
      <ContextMenu />
      <QuickAdd />
      <Toast />
      <ElevationStrip />
      {!mobile && (
        <div className="bench-tools">
          <label className="grid-light" title="Brightness of the bench grid">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
              <circle cx="3" cy="3" r="1.3" />
              <circle cx="8" cy="3" r="1.3" />
              <circle cx="13" cy="3" r="1.3" />
              <circle cx="3" cy="8" r="1.3" />
              <circle cx="8" cy="8" r="1.3" />
              <circle cx="13" cy="8" r="1.3" />
              <circle cx="3" cy="13" r="1.3" />
              <circle cx="8" cy="13" r="1.3" />
              <circle cx="13" cy="13" r="1.3" />
            </svg>
            <input type="range" min="0" max="1" step="0.05" value={gridLight} onChange={(e) => setGridLight(Number(e.target.value))} aria-label="Grid brightness" />
          </label>
          {!elevation && nodes.length > 0 && (
            <button className="elev-toggle" onClick={() => useEditor.setState({ elevation: true })} title="A side view of the rig: elevations and the hydraulic grade line">
              Elevation
            </button>
          )}
        </div>
      )}
      <ExperimentCard />
      {mobile && (
        <button className="fab" onClick={() => set({ sheet: 'parts' })} aria-label="Components and experiments">
          {Icon.parts}
        </button>
      )}
      {touch && nodes.length > 0 && (
        <div className={`touch-tools ${mobile ? '' : 'wide'}`}>
          <button className={boxSelect ? 'on' : ''} onClick={() => useEditor.setState({ boxSelect: !boxSelect })} aria-pressed={boxSelect} title="Drag a box round parts to select them">
            <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2.6">
              <rect x="3" y="3" width="14" height="14" rx="2" />
            </svg>
          </button>
          {anySelected && (
            <button className="danger" onClick={removeSelected} aria-label="Delete the selection">
              <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10M9 9v5M11 9v5" />
              </svg>
            </button>
          )}
        </div>
      )}
      <Legend />
      <Alerts />
      {nodes.length === 0 && (
        <div className="empty">
          <b>An empty bench.</b>
          <span>Drag components in from the left and pull pipes between their ports — or open an experiment.</span>
        </div>
      )}
    </main>
  )
}

export default function App() {
  const tick = useLab((s) => s.tick)
  const sheet = useLab((s) => s.sheet)
  const set = useLab((s) => s.set)
  const mobile = useIsMobile()

  useEffect(() => {
    let last = performance.now()
    const t = setInterval(() => {
      const now = performance.now()
      tick(Math.min(0.25, (now - last) / 1000))
      last = now
    }, 100)
    return () => clearInterval(t)
  }, [tick])

  return (
    <ReactFlowProvider>
      <div className={`app ${mobile ? 'is-mobile' : ''} sheet-${sheet}`}>
        <TopBar />
        <Sidebar />
        <Bench />
        <div className="insp-wrap">
          <button className="sheet-grab" onClick={() => set({ sheet: sheet === 'insp' ? 'none' : 'insp' })} aria-label="Toggle details">
            <i />
          </button>
          <Inspector />
        </div>
        {mobile && sheet === 'parts' && <div className="scrim" onClick={() => set({ sheet: 'none' })} />}
      </div>
    </ReactFlowProvider>
  )
}
