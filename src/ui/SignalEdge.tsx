import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import { memo } from 'react'
import type { LabEdge } from '../experiments'
import { useLab } from '../store'
import { SIGNAL_OFF, SIGNAL_ON, SIGNAL_PV } from './colors'

/**
 * A signal wire: thin and dashed so it never reads as a pipe. Commands are violet and pulse towards the device
 * while on; measurements are green and pulse towards the controller while the instrument has a reading.
 */
function SignalEdgeImpl({ id, source, target, sourceHandleId, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps<LabEdge>) {
  const measurement = sourceHandleId === 'pv'
  const value = useLab((s) => (measurement ? (s.ctrl.pv[target] !== undefined ? 1 : 0) : (s.ctrl.out[source] ?? 0)))
  const analog = useLab((s) => s.nodes.find((n) => n.id === source)?.data.kind === 'pid')
  const paused = useLab((s) => !s.running)
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10, offset: 18 })
  const on = value > 0.005
  const color = measurement ? (on ? SIGNAL_PV : SIGNAL_OFF) : on ? SIGNAL_ON : SIGNAL_OFF
  return (
    <>
      {selected && <path d={path} fill="none" stroke="var(--accent)" strokeWidth={9} strokeLinecap="round" opacity={0.25} />}
      <path d={path} fill="none" stroke="#04070d" strokeWidth={4.5} strokeLinecap="round" />
      <path
        d={path}
        className={on ? 'signal-live' : undefined}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={measurement ? '2 5' : '5 6'}
        opacity={analog ? 0.45 + 0.55 * value : 1}
        style={{ filter: on ? `drop-shadow(0 0 4px ${color})` : undefined, animationPlayState: paused ? 'paused' : 'running' }}
      />
      <circle cx={targetX} cy={targetY} r={3.5} fill={color} />
      <BaseEdge id={id} path={path} interactionWidth={20} style={{ stroke: 'transparent' }} />
      {analog && (
        <EdgeLabelRenderer>
          <div className="signal-chip" style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}>
            {Math.round(value * 100)} %
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const SignalEdge = memo(SignalEdgeImpl)
