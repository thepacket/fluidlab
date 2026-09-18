import { useMemo, useRef, useState } from 'react'
import { fmtNum } from '../model/units'
import { niceTicks } from './colors'

export interface Series {
  name: string
  color: string
  points: { x: number; y: number }[]
  dashed?: boolean
  area?: boolean
  step?: boolean
}
export interface Marker {
  x: number
  y: number
  label: string
  color?: string
}

// Categorical slots, dark-surface steps (validated order: blue, orange, aqua).
export const SERIES = { blue: '#3987e5', orange: '#d95926', aqua: '#199e70' }

interface Props {
  series: Series[]
  markers?: Marker[]
  xLabel: string
  yLabel: string
  height?: number
  yMinZero?: boolean
  empty?: string
}

const tickFmt = (t: number) => (Math.abs(t) >= 1e5 || (t !== 0 && Math.abs(t) < 1e-3) ? t.toExponential(1) : String(Number(t.toPrecision(6))))

const W = 316
const M = { l: 44, r: 12, t: 10, b: 30 }

export function Chart({ series, markers = [], xLabel, yLabel, height = 190, yMinZero = true, empty }: Props) {
  const ref = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const H = height

  const g = useMemo(() => {
    const pts = [...series.flatMap((s) => s.points), ...markers]
    if (!pts.length) return null
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs, x0 + 1e-9)
    let y0 = Math.min(...ys)
    let y1 = Math.max(...ys)
    if (yMinZero && y0 > 0) y0 = 0
    if (y1 - y0 < 1e-9) y1 = y0 + 1
    const yt = niceTicks(y0, y1 + (y1 - y0) * 0.08, 4)
    y0 = Math.min(y0, yt[0])
    y1 = Math.max(y1 + (y1 - y0) * 0.08, yt[yt.length - 1])
    const xt = niceTicks(x0, x1, 4)
    const sx = (x: number) => M.l + ((x - x0) / (x1 - x0)) * (W - M.l - M.r)
    const sy = (y: number) => H - M.b - ((y - y0) / (y1 - y0)) * (H - M.t - M.b)
    return { x0, x1, y0, y1, xt, yt, sx, sy }
  }, [series, markers, H, yMinZero])

  if (!g) return <div className="chart-empty">{empty ?? 'Nothing to plot yet'}</div>
  const { sx, sy } = g

  const path = (s: Series) =>
    s.points
      .map((p, i) => {
        if (s.step && i > 0) return `H${sx(p.x).toFixed(1)}V${sy(p.y).toFixed(1)}`
        return `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`
      })
      .join('')

  const interp = (s: Series, x: number) => {
    const p = s.points
    if (!p.length || x < p[0].x || x > p[p.length - 1].x) return null
    for (let i = 1; i < p.length; i++)
      if (x <= p[i].x) {
        const f = (x - p[i - 1].x) / (p[i].x - p[i - 1].x || 1)
        return p[i - 1].y + (p[i].y - p[i - 1].y) * f
      }
    return null
  }

  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const x = g.x0 + ((px - M.l) / (W - M.l - M.r)) * (g.x1 - g.x0)
    setHover(x < g.x0 || x > g.x1 ? null : x)
  }

  const hoverRows = hover === null ? [] : series.map((s) => ({ s, y: interp(s, hover) })).filter((r) => r.y !== null)

  return (
    <div className="chart">
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color, opacity: s.dashed ? 0.7 : 1 }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y' }}>
        {g.yt.map((t) => (
          <g key={`y${t}`}>
            <line x1={M.l} x2={W - M.r} y1={sy(t)} y2={sy(t)} className="grid" />
            <text x={M.l - 6} y={sy(t) + 3.5} textAnchor="end" className="tick">
              {tickFmt(t)}
            </text>
          </g>
        ))}
        {g.xt.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={H - M.b + 14} textAnchor="middle" className="tick">
            {tickFmt(t)}
          </text>
        ))}
        <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} className="axis" />
        <text x={(M.l + W - M.r) / 2} y={H - 2} textAnchor="middle" className="axis-label">
          {xLabel}
        </text>
        <text x={10} y={(M.t + H - M.b) / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 10 ${(M.t + H - M.b) / 2})`}>
          {yLabel}
        </text>

        {series.map((s) => (
          <g key={s.name}>
            {s.area && s.points.length > 1 && <path d={`${path(s)}L${sx(s.points[s.points.length - 1].x)},${sy(g.y0)}L${sx(s.points[0].x)},${sy(g.y0)}Z`} fill={s.color} opacity={0.12} />}
            <path d={path(s)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}

        {hover !== null && hoverRows.length > 0 && (
          <g pointerEvents="none">
            <line x1={sx(hover)} x2={sx(hover)} y1={M.t} y2={H - M.b} className="crosshair" />
            {hoverRows.map(({ s, y }) => (
              <circle key={s.name} cx={sx(hover)} cy={sy(y!)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
            ))}
          </g>
        )}

        {markers.map((m) => {
          const flip = sx(m.x) > W - 110
          return (
            <g key={m.label} pointerEvents="none">
              <circle cx={sx(m.x)} cy={sy(m.y)} r={9} fill={m.color ?? '#fff'} opacity={0.18}>
                <animate attributeName="r" values="6;12;6" dur="2.4s" repeatCount="indefinite" />
              </circle>
              <circle cx={sx(m.x)} cy={sy(m.y)} r={4.5} fill={m.color ?? '#fff'} stroke="var(--panel)" strokeWidth={2} />
              <text x={sx(m.x) + (flip ? -10 : 10)} y={sy(m.y) - 8} textAnchor={flip ? 'end' : 'start'} className="marker-label">
                {m.label}
              </text>
            </g>
          )
        })}
      </svg>
      {hover !== null && hoverRows.length > 0 && (
        <div className="chart-tip" style={{ left: `${(sx(hover) / W) * 100}%`, transform: `translateX(${sx(hover) > W / 2 ? '-105%' : '5%'})` }}>
          <b>
            {fmtNum(hover)} <em>{xLabel.match(/\(([^)]+)\)/)?.[1] ?? ''}</em>
          </b>
          {hoverRows.map(({ s, y }) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name} <b>{fmtNum(y!)}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
