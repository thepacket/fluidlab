import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import { memo } from 'react'
import type { LabEdge } from '../experiments'
import { fmt, unitLabel } from '../model/units'
import { useLab } from '../store'
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

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 18,
  })
  const d = data?.props.diameter ?? 0.04
  const w = Math.min(15, Math.max(5, 3.5 + d * 1000 * 0.16))
  const live = ok && !!r
  const flowing = live && Math.abs(r.flow) > 1e-8

  let c1 = DRY
  let c2 = DRY
  if (live) {
    if (overlay === 'pressure') [c1, c2] = [pressureColor(r.pStart, pMax), pressureColor(r.pEnd, pMax)]
    else if (overlay === 'velocity') c1 = c2 = velocityColor(r.velocity, vMax)
    else if (overlay === 'thermal' && heat) [c1, c2] = [thermalColor(heat.t.tStart, heat.tMin, heat.tMax), thermalColor(heat.t.tEnd, heat.tMin, heat.tMax)]
    else c1 = c2 = PLAIN
  }
  const gid = `grad-${id}`
  // dash pattern period is 18px; speed in px/s grows with velocity but saturates so fast pipes stay readable
  const speed = flowing ? 18 + 95 * (1 - Math.exp(-r.velocity / 1.6)) : 0
  const roomy = Math.abs(sourceX - targetX) + Math.abs(sourceY - targetY) > 170
  const flat = Math.abs(sourceX - targetX) < 1 && Math.abs(sourceY - targetY) < 1

  return (
    <>
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={flat ? sourceX + 1 : targetX} y2={targetY}>
          <stop offset="0" stopColor={c1} />
          <stop offset="1" stopColor={c2} />
        </linearGradient>
      </defs>
      {selected && <path d={path} fill="none" stroke="var(--accent)" strokeWidth={w + 12} strokeLinecap="round" opacity={0.28} />}
      <path d={path} fill="none" stroke="#04070d" strokeWidth={w + 5} strokeLinecap="round" />
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
      <path d={path} fill="none" stroke="rgba(255,255,255,.22)" strokeWidth={1} transform="translate(0,-1.5)" strokeLinecap="round" />
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
      {(roomy || selected) && (
        <EdgeLabelRenderer>
          <div
            className={`pipe-label nopan ${selected ? 'is-selected' : ''}`}
            style={{
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            <span className="pipe-name">{data?.label}</span>
            {live && !flowing ? (
              <em>static</em>
            ) : live ? (
              <>
                <b>{fmt(Math.abs(r.flow), 'flow', units)}</b>
                <em>{unitLabel('flow', units)}</em>
                <span className="sep" />
                <b>{fmt(r.velocity, 'velocity', units, 2)}</b>
                <em>{unitLabel('velocity', units)}</em>
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
