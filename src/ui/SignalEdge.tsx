import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import { memo } from 'react'
import type { LabEdge } from '../experiments'
import { useLab } from '../store'

export const SIGNAL_ON = '#b7a9ff'
export const SIGNAL_OFF = '#4a4f7a'

/** A controller's command line: thin, dashed, and pulsing towards the device while the command is ON. */
function SignalEdgeImpl({ id, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps<LabEdge>) {
  const on = useLab((s) => s.controls[target])
  const paused = useLab((s) => !s.running)
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10, offset: 18 })
  const color = on ? SIGNAL_ON : SIGNAL_OFF
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
        strokeDasharray="5 6"
        style={{ filter: on ? `drop-shadow(0 0 4px ${color})` : undefined, animationPlayState: paused ? 'paused' : 'running' }}
      />
      <circle cx={targetX} cy={targetY} r={3.5} fill={color} />
      <BaseEdge id={id} path={path} interactionWidth={20} style={{ stroke: 'transparent' }} />
    </>
  )
}

export const SignalEdge = memo(SignalEdgeImpl)
