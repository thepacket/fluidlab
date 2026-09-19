import { BaseEdge, EdgeLabelRenderer, Position, getSmoothStepPath, useReactFlow, type EdgeProps } from '@xyflow/react'
import { memo, useEffect, useMemo, useRef } from 'react'
import type { LabEdge } from '../experiments'
import { fmt, unitLabel } from '../model/units'
import { useLab } from '../store'
import { snapToGrid, useEditor } from './editorState'
import { buildPath, labelSpot, middleRun, publishRoute, useRoutes, vertices } from './route'
import { DRY, PLAIN, pressureColor, thermalColor, velocityColor } from './colors'

function PipeEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<LabEdge>) {
  const r = useLab((s) => s.results.links[id])
  const ok = useLab((s) => s.results.ok)
  const pMax = useLab((s) => s.results.pMax)
  const vMax = useLab((s) => s.results.vMax)
  const overlay = useLab((s) => s.overlay)
  const thermal = useLab((s) => s.results.thermal)
  const heat = thermal?.links[id] ? { t: thermal.links[id], tMin: thermal.tMin, tMax: thermal.tMax } : null
  const units = useLab((s) => s.units)
  const paused = useLab((s) => !s.running)
  const reach = useLab((s) => s.results.channel?.reaches[id])
  const open = data?.props.conduit === 'channel'
  const back = data?.props.conduit === 'condensate' // condensate return: a thinner, green line

  const hovered = useEditor((s) => s.hoverEdge === id)
  const dropping = useEditor((s) => s.dropEdge === id)
  const labels = useEditor((s) => s.labels)
  const version = useRoutes((s) => s.version)
  const routeEdge = useLab((s) => s.routeEdge)
  const checkpoint = useLab((s) => s.checkpoint)
  const { screenToFlowPosition } = useReactFlow()
  const route = data?.route as { cx?: number; cy?: number } | undefined

  const [proposed] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 18, centerX: route?.cx, centerY: route?.cy })
  // the same corners, redrawn so the pipe can hop over the ones it crosses
  const pts = useMemo(() => vertices(proposed), [proposed])
  useEffect(() => publishRoute(id, pts), [id, pts])
  useEffect(() => () => publishRoute(id, null), [id])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the other pipes' routes changing
  const path = useMemo(() => buildPath(id, pts), [id, pts, version])
  // a pipe that hops is drawn above the ones it hops over, or its arches would be cut by them
  const mark = useRef<SVGGElement>(null)
  const hops = path.includes('A')
  useEffect(() => {
    const svg = mark.current?.closest('svg')
    if (svg) svg.style.zIndex = hops ? '1' : '0'
  }, [hops])
  const d = data?.props.diameter ?? 0.04
  const w = open ? Math.min(24, Math.max(10, 8 + (data?.props.shape === 'circ' ? d : (data?.props.width ?? 0.5)) * 7)) : Math.min(15, Math.max(5, 3.5 + d * 1000 * 0.16))
  const live = ok && !!r
  const flowing = live && Math.abs(r.flow) > 1e-8

  let c1 = DRY
  let c2 = DRY
  if (live) {
    if (overlay === 'pressure') [c1, c2] = [pressureColor(r.pStart, pMax), pressureColor(r.pEnd, pMax)]
    else if (overlay === 'velocity') c1 = c2 = velocityColor(r.velocity, vMax)
    else if (overlay === 'thermal' && heat) [c1, c2] = [thermalColor(heat.t.tStart, heat.tMin, heat.tMax), thermalColor(heat.t.tEnd, heat.tMin, heat.tMax)]
    else c1 = c2 = PLAIN
    if (back) c1 = c2 = '#2fbf8f'
  }
  const gid = `grad-${id}`
  // dash pattern period is 18px; speed in px/s grows with velocity but saturates so fast pipes stay readable
  const speed = flowing ? 18 + 95 * (1 - Math.exp(-r.velocity / 1.6)) : 0
  const roomy = Math.abs(sourceX - targetX) + Math.abs(sourceY - targetY) > 170
  const spot = labelSpot(id, pts, w / 2 + 9)
  const full = selected || hovered
  // a pipe between facing ports has a middle run that can be dragged aside
  const facing =
    (sourcePosition === Position.Left || sourcePosition === Position.Right) === (targetPosition === Position.Left || targetPosition === Position.Right) && sourcePosition !== targetPosition
  const bend = selected && facing ? middleRun(pts) : null
  const flat = Math.abs(sourceX - targetX) < 1 && Math.abs(sourceY - targetY) < 1

  return (
    <>
      <g ref={mark} />
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={flat ? sourceX + 1 : targetX} y2={targetY}>
          {/* live heat: one stop per cell, so a hot front can be seen travelling down the pipe */}
          {live && overlay === 'thermal' && heat?.t.cells ? (
            heat.t.cells.map((t, i, all) => <stop key={i} offset={(i + 0.5) / all.length} stopColor={thermalColor(t, heat.tMin, heat.tMax)} />)
          ) : (
            <>
              <stop offset="0" stopColor={c1} />
              <stop offset="1" stopColor={c2} />
            </>
          )}
        </linearGradient>
      </defs>
      {selected && <path d={path} fill="none" stroke="var(--accent)" strokeWidth={w + 12} strokeLinecap="round" opacity={0.28} />}
      {dropping && <path className="pipe-drop" d={path} fill="none" stroke="var(--good)" strokeWidth={w + 14} strokeLinecap="round" />}
      {/* an open channel is drawn from above: two banks with the water between them */}
      {open && <path d={path} fill="none" stroke="#6b7fa6" strokeWidth={w + 9} strokeLinecap="butt" />}
      <path d={path} fill="none" stroke="#04070d" strokeWidth={w + 5} strokeLinecap={open ? 'butt' : 'round'} />
      <path d={path} fill="none" stroke={`url(#${gid})`} strokeWidth={w + 2} strokeLinecap="round" opacity={0.45} />
      <path
        d={path}
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth={w - 1}
        strokeLinecap="round"
        style={{
          filter: live ? `drop-shadow(0 0 ${flowing ? 5 : 2}px ${c1})` : undefined,
        }}
        strokeDasharray={live ? undefined : '3 9'}
      />
      {!open && <path d={path} fill="none" stroke="rgba(255,255,255,.22)" strokeWidth={1} transform="translate(0,-1.5)" strokeLinecap="round" />}
      {open && reach?.jump && (
        <g style={{ offsetPath: `path('${path}')`, offsetDistance: `${(r && r.flow < 0 ? 1 - reach.jump.x / data!.props.length : reach.jump.x / data!.props.length) * 100}%`, offsetRotate: 'auto' }}>
          <path
            className="jump-mark"
            d={`M-3,${-w / 2} q3,${w / 4} 0,${w / 2} t0,${w / 2} M3,${-w / 2} q3,${w / 4} 0,${w / 2} t0,${w / 2}`}
            fill="none"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
      )}
      {flowing && (
        <path
          d={path}
          className="pipe-flow"
          fill="none"
          stroke="#f4fdff"
          strokeWidth={Math.max(2, w * 0.36)}
          strokeLinecap="round"
          strokeDasharray="0.1 18"
          style={{
            animationDuration: `${18 / speed}s`,
            animationDirection: r.flow > 0 ? 'normal' : 'reverse',
            animationPlayState: paused ? 'paused' : 'running',
          }}
        />
      )}
      <BaseEdge id={id} path={path} interactionWidth={26} style={{ stroke: 'transparent' }} />
      {bend && (
        <EdgeLabelRenderer>
          <div
            className={`pipe-bend nodrag nopan ${bend.axis}`}
            title="Drag to move this run · double-click to reset"
            style={{ transform: `translate(-50%,-50%) translate(${bend.at.x}px,${bend.at.y}px)` }}
            onPointerDown={(e) => {
              e.stopPropagation()
              e.currentTarget.setPointerCapture(e.pointerId)
              checkpoint()
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
              const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
              routeEdge(id, bend.axis === 'x' ? { cx: snapToGrid(p.x) } : { cy: snapToGrid(p.y) })
            }}
            onDoubleClick={(e) => (e.stopPropagation(), checkpoint(), routeEdge(id, null))}
          />
        </EdgeLabelRenderer>
      )}
      {(full || (labels && roomy)) && (
        <EdgeLabelRenderer>
          <div
            className={`pipe-label nopan ${selected ? 'is-selected' : ''} ${full ? 'is-full' : ''}`}
            style={{
              transform: `translate(${spot.side === 'above' ? '-50%,-100%' : '0,-50%'}) translate(${spot.x}px,${spot.y}px)`,
            }}
          >
            <span className="pipe-name">{data?.label}</span>
            {live && !flowing ? (
              <em>static</em>
            ) : live ? (
              <>
                <b>{fmt(Math.abs(r.flow), 'flow', units)}</b>
                <em>{unitLabel('flow', units)}</em>
                {full && <span className="sep" />}
                {!full ? null : reach ? (
                  <>
                    <b>{fmt(reach.depth[reach.depth.length >> 1], 'length', units, 2)}</b>
                    <em>{unitLabel('length', units)} deep</em>
                    <span className="sep" />
                    <em>{reach.profile}</em>
                  </>
                ) : (
                  <>
                    <b>{fmt(r.velocity, 'velocity', units, 2)}</b>
                    <em>{unitLabel('velocity', units)}</em>
                  </>
                )}
              </>
            ) : (
              <em>dry</em>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const PipeEdge = memo(PipeEdgeImpl)
