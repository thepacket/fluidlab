import { Background, BackgroundVariant, ConnectionMode, Controls, MiniMap, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EXPERIMENTS } from './experiments'
import type { Kind } from './model/types'
import { fmt, unitLabel } from './model/units'
import { useLab } from './store'
import { Inspector } from './ui/Inspector'
import { PipeEdge } from './ui/PipeEdge'
import { Sidebar } from './ui/Sidebar'
import { TopBar } from './ui/TopBar'
import { rampCss } from './ui/colors'
import { Icon } from './ui/icons'
import { nodeTypes } from './ui/nodes'

const edgeTypes = { pipe: PipeEdge }

function ExperimentCard() {
  const id = useLab((s) => s.experimentId)
  const results = useLab((s) => s.results)
  const nodes = useLab((s) => s.nodes)
  const levels = useLab((s) => s.levels)
  const close = useLab((s) => s.set)
  const [open, setOpen] = useState(true)
  const ex = EXPERIMENTS.find((e) => e.id === id)
  const goal = useMemo(() => (ex?.goal && results.ok ? ex.goal.check(results, nodes, levels) : null), [ex, results, nodes, levels])
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
  const loadCount = useLab((s) => s.loadCount)

  useEffect(() => {
    if (!initialized) return
    const t = setTimeout(() => fitView({ padding: { top: useLab.getState().experimentId ? '290px' : '70px', bottom: '110px', left: '60px', right: '70px' }, duration: 500, maxZoom: 1.2 }), 30)
    return () => clearTimeout(t)
  }, [initialized, loadCount, fitView])

  useEffect(() => {
    const onAdd = (e: Event) => {
      const el = document.querySelector('.bench')!.getBoundingClientRect()
      const p = screenToFlowPosition({ x: el.left + el.width / 2 + (Math.random() - 0.5) * 120, y: el.top + el.height / 2 + (Math.random() - 0.5) * 120 })
      addNode((e as CustomEvent<Kind>).detail, p.x, p.y)
    }
    window.addEventListener('fluidlab:add', onAdd)
    return () => window.removeEventListener('fluidlab:add', onAdd)
  }, [addNode, screenToFlowPosition])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const kind = e.dataTransfer.getData('application/fluidlab') as Kind
      if (!kind) return
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      addNode(kind, p.x, p.y)
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
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor="#2a9dff"
          maskColor="rgba(4,7,13,.72)"
          bgColor="#0a111d"
          nodeStrokeWidth={0}
          style={{ marginBottom: 118, width: 150, height: 96 }}
        />
      </ReactFlow>
      <ExperimentCard />
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
      <div className="app">
        <TopBar />
        <Sidebar />
        <Bench />
        <Inspector />
      </div>
    </ReactFlowProvider>
  )
}
