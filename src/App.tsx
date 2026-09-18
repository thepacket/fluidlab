import { Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EXPERIMENTS } from './experiments'
import type { Kind } from './model/types'
import { fmt, unitLabel } from './model/units'
import { selectedId, signalEnds, useLab } from './store'
import { Inspector } from './ui/Inspector'
import { PipeEdge } from './ui/PipeEdge'
import { SignalEdge } from './ui/SignalEdge'
import { Sidebar } from './ui/Sidebar'
import { TopBar } from './ui/TopBar'
import { rampCss, thermalCss } from './ui/colors'
import { Icon } from './ui/icons'
import { nodeTypes } from './ui/nodes'
import { useIsMobile } from './ui/useIsMobile'

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
  const list = [...(r.error ? [{ level: 'error' as const, text: r.error, id: undefined }] : []), ...r.warnings]
  const order = { error: 0, warn: 1, info: 2 }
  const shown = list.sort((a, b) => order[a.level] - order[b.level]).slice(0, 4)
  if (!shown.length) return null
  return (
    <div className="alerts">
      {shown.map((w, i) => (
        <button key={i} className={`alert ${w.level}`} onClick={() => w.id && select(w.id)}>
          <i>{w.level === 'info' ? 'i' : '!'}</i>
          {w.text}
        </button>
      ))}
      {list.length > 4 && <span className="muted">+{list.length - 4} more</span>}
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

  const initialized = useNodesInitialized()
  const mobile = useIsMobile()
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
        : { top: px(useLab.getState().experimentId ? Math.min(Math.max(290, card() + 40), Math.round(window.innerHeight * 0.55)) : 70), bottom: px(110), left: px(60), right: px(70) }
    for (const [ms, duration] of [
      [60, 350],
      [450, 350],
      [1000, 0],
    ])
      setTimeout(() => fitRef.current({ padding: padding(), duration, maxZoom: 1.2 }), ms)
  }, [initialized, loadCount, mobile, sheetOpen])

  useEffect(() => {
    const onAdd = (e: Event) => {
      const el = document.querySelector('.bench')!.getBoundingClientRect()
      const p = screenToFlowPosition({ x: el.left + el.width / 2 + (Math.random() - 0.5) * 120, y: el.top + el.height / 2 + (Math.random() - 0.5) * 120 })
      const [kind, variant] = (e as CustomEvent<string>).detail.split(':')
      addNode(kind as Kind, p.x, p.y, variant)
    }
    window.addEventListener('fluidlab:add', onAdd)
    return () => window.removeEventListener('fluidlab:add', onAdd)
  }, [addNode, screenToFlowPosition])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const [kind, variant] = e.dataTransfer.getData('application/fluidlab').split(':') as [Kind, string?]
      if (!kind) return
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      addNode(kind, p.x, p.y, variant)
    },
    [addNode, screenToFlowPosition],
  )

  return (
    <main className="bench" onDrop={onDrop} onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'))}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={() => checkpoint()}
        isValidConnection={(c) => c.source !== c.target && signalEnds(c, useLab.getState().nodes) !== 'invalid'}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={34}
        connectionLineStyle={{ stroke: '#35e0ff', strokeWidth: 5, strokeLinecap: 'round', strokeDasharray: '2 10' }}
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={0.25}
        maxZoom={2.5}
        snapToGrid
        snapGrid={[10, 10]}
        proOptions={{ hideAttribution: true }}
        elevateEdgesOnSelect={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="#1d2a42" />
        <Background id="major" variant={BackgroundVariant.Lines} gap={200} color="#101a2b" />
        {!mobile && <Controls position="bottom-right" showInteractive={false} />}
      </ReactFlow>
      <ExperimentCard />
      {mobile && (
        <button className="fab" onClick={() => set({ sheet: 'parts' })} aria-label="Components and experiments">
          {Icon.parts}
        </button>
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
