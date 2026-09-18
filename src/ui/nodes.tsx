import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { memo, useEffect, type ReactNode } from 'react'
import { NODE_SIZE, PORT_Y, type LabNode } from '../experiments'
import { fmtClock, timerState } from '../model/control'
import { beta, valveK } from '../model/physics'
import { CONTROLLABLE, ROTATABLE, type Kind } from '../model/types'
import { fmt, fmtU, toSI, unitLabel } from '../model/units'
import { useLab } from '../store'
import { SIGNAL_OFF, SIGNAL_ON } from './SignalEdge'
import { DRY, PLAIN, niceCeil, pressureColor } from './colors'

// ---- shared shell -----------------------------------------------------------

const SIDES = [Position.Left, Position.Top, Position.Right, Position.Bottom]
/** where a port that sits on `base` at 0° ends up once the part is turned */
const side = (base: Position, rot: number) => SIDES[(SIDES.indexOf(base) + rot / 90) % 4]

/** CSS transform for the artwork. 180° is drawn as a mirror image so stems, LEDs and handwheels stay upright. */
const artTransform = (rot: number) => (rot === 180 ? 'scaleX(-1)' : rot ? `rotate(${rot}deg)` : undefined)
/** SVG transform that keeps a text anchored at (cx, cy) readable whatever the artwork is doing. */
const upright = (rot: number, cx: number, cy: number) => (rot === 180 ? `translate(${2 * cx} 0) scale(-1 1)` : rot ? `rotate(${-rot} ${cx} ${cy})` : undefined)

/** Command input for anything a controller can switch. It takes whichever side the fluid ports leave free. */
function ControlPort({ kind, rot }: { kind: Kind; rot: number }) {
  if (!CONTROLLABLE.includes(kind)) return null
  return <Handle id="ctl" type="source" position={rot === 180 ? Position.Top : side(Position.Top, rot)} className="port port-signal" />
}

function Ports({ kind, rot }: { kind: Kind; rot: number }) {
  if (kind === 'timer') return <Handle id="sig" type="source" position={Position.Right} className="port port-signal" />
  if (kind === 'dpgauge' || ROTATABLE.includes(kind)) {
    const y = kind === 'dpgauge' ? { top: `${PORT_Y[kind] * 100}%` } : undefined
    if (kind === 'outlet') return <Handle id="l" type="source" position={side(Position.Left, rot)} className="port" />
    return (
      <>
        <Handle id="in" type="source" position={side(Position.Left, rot)} className="port port-in" style={y} />
        <Handle id="out" type="source" position={side(Position.Right, rot)} className="port port-out" style={y} />
      </>
    )
  }
  const y = `${PORT_Y[kind] * 100}%`
  return (
    <>
      <Handle id="l" type="source" position={Position.Left} className="port" style={{ top: y }} />
      <Handle id="r" type="source" position={Position.Right} className="port" style={{ top: y }} />
      {kind !== 'reservoir' && kind !== 'tank' && <Handle id="t" type="source" position={Position.Top} className="port" />}
      <Handle id="b" type="source" position={Position.Bottom} className="port" />
    </>
  )
}

interface ShellProps {
  id: string
  kind: Kind
  selected?: boolean
  label: string
  rot?: number
  sub?: ReactNode
  children: ReactNode
  extra?: ReactNode
}

function Shell({ id, kind, selected, label, rot = 0, sub, children, extra }: ShellProps) {
  const warn = useLab((s) => s.results.warnings.find((w) => w.id === id && w.level !== 'info'))
  const off = useLab((s) => s.results.excluded.includes(id))
  const updateInternals = useUpdateNodeInternals()
  useEffect(() => updateInternals(id), [id, rot, updateInternals])
  const [bw, bh] = NODE_SIZE[kind]
  const turned = rot % 180 === 90
  const [w, h] = turned ? [bh, bw] : [bw, bh]
  return (
    <div className={`eq eq-${kind} ${selected ? 'is-selected' : ''} ${off ? 'is-off' : ''} ${warn ? `has-${warn.level}` : ''}`} style={{ width: w, height: h }}>
      <div className="eq-art" style={{ left: (w - bw) / 2, top: (h - bh) / 2, width: bw, height: bh, transform: artTransform(rot) }}>
        {children}
      </div>
      <Ports kind={kind} rot={rot} />
      <ControlPort kind={kind} rot={rot} />
      <div className="eq-label">
        <b>{label}</b>
        {sub && <span>{sub}</span>}
      </div>
      {warn && (
        <div className={`eq-badge ${warn.level}`} title={warn.text}>
          !
        </div>
      )}
      {extra}
    </div>
  )
}

const rotOf = (data: LabNode['data']) => (ROTATABLE.includes(data.kind) ? (data.rot ?? 0) : 0)

const usePressureColor = (p: number | undefined) => {
  const overlay = useLab((s) => s.overlay)
  const pMax = useLab((s) => s.results.pMax)
  if (p === undefined) return DRY
  if (overlay === 'velocity') return '#51617f' // velocity is a pipe property; keep fittings neutral
  return overlay === 'pressure' ? pressureColor(p, pMax) : PLAIN
}

const wave = (y: number, width: number, depth: number) => {
  let d = `M-44,${y} q11,-4 22,0 t22,0`
  for (let x = 0; x < width + 44; x += 44) d += ' t22,0 t22,0'
  return `${d} V${y + depth} H-44 Z`
}

// ---- reservoir --------------------------------------------------------------

export const ReservoirNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const r = useLab((s) => s.results.nodes[id])
  const q = Math.abs(r?.outflow ?? 0)
  return (
    <Shell id={id} kind="reservoir" selected={selected} label={data.label} sub={q > 1e-8 ? `${r!.outflow < 0 ? '↑' : '↓'} ${fmtU(q, 'flow', units)}` : undefined}>
      <svg width="132" height="96" viewBox="0 0 132 96">
        <defs>
          <linearGradient id={`rw-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#38c6ff" stopOpacity=".95" />
            <stop offset="1" stopColor="#1443b8" stopOpacity=".9" />
          </linearGradient>
          <clipPath id={`rc-${id}`}>
            <path d="M8,10 V82 Q8,88 14,88 H118 Q124,88 124,82 V10 Z" />
          </clipPath>
        </defs>
        <g clipPath={`url(#rc-${id})`}>
          <rect x="0" y="0" width="132" height="96" fill="#0a1526" />
          <path className="wave wave-slow" d={wave(27, 132, 80)} fill="#2b7fe0" opacity=".5" />
          <path className="wave" d={wave(30, 132, 80)} fill={`url(#rw-${id})`} />
          <circle className="bubble b1" cx="36" cy="80" r="2" />
          <circle className="bubble b2" cx="78" cy="84" r="1.5" />
          <circle className="bubble b3" cx="102" cy="78" r="2.2" />
        </g>
        <path d="M7,6 V82 Q7,89 14,89 H118 Q125,89 125,82 V6" fill="none" stroke="#5a7099" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M2,6 H12 M120,6 H130" stroke="#5a7099" strokeWidth="2.5" strokeLinecap="round" />
        <text x="66" y="62" className="svg-readout">
          {fmt(data.props.head, 'head', units)}
          <tspan className="svg-unit"> {unitLabel('head', units)}</tspan>
        </text>
        <text x="66" y="76" className="svg-caption">
          HEAD
        </text>
      </svg>
    </Shell>
  )
})

// ---- tank -------------------------------------------------------------------

export const TankNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const level = useLab((s) => s.levels[id] ?? data.props.initLevel)
  const r = useLab((s) => s.results.nodes[id])
  const p = data.props
  const frac = Math.min(1, Math.max(0, level / Math.max(0.01, p.maxLevel)))
  const top = 14
  const bottom = 124
  const y = bottom - frac * (bottom - top)
  const net = r?.outflow ?? 0
  const trend = Math.abs(net) < 1e-7 ? '' : net > 0 ? '▲' : '▼'
  return (
    <Shell id={id} kind="tank" selected={selected} label={data.label} sub={`${trend} ${fmtU(level, 'length', units)}`}>
      <svg width="112" height="136" viewBox="0 0 112 136">
        <defs>
          <linearGradient id={`tw-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4fd4ff" />
            <stop offset="1" stopColor="#1749c4" />
          </linearGradient>
          <clipPath id={`tc-${id}`}>
            <rect x="16" y="10" width="80" height="116" rx="10" />
          </clipPath>
        </defs>
        <rect x="16" y="10" width="80" height="116" rx="10" fill="#0a1526" />
        <g clipPath={`url(#tc-${id})`}>
          <g style={{ transform: `translateY(${y}px)`, transition: 'transform .25s linear' }}>
            <path className="wave wave-slow" d={wave(-3, 112, 140)} fill="#2b7fe0" opacity=".5" />
            <path className="wave" d={wave(0, 112, 140)} fill={`url(#tw-${id})`} opacity=".92" />
          </g>
          <rect x="22" y="10" width="9" height="116" fill="#fff" opacity=".07" />
        </g>
        <rect x="16" y="10" width="80" height="116" rx="10" fill="none" stroke="#5a7099" strokeWidth="2.5" />
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1="86" x2="95" y1={bottom - t * (bottom - top)} y2={bottom - t * (bottom - top)} stroke="#8aa0c6" strokeWidth="1.5" opacity=".7" />
        ))}
        <path d="M10,126 H102 M26,126 V134 M86,126 V134" stroke="#5a7099" strokeWidth="2.5" strokeLinecap="round" />
        <text x="56" y="74" className="svg-readout big">
          {Math.round(frac * 100)}
          <tspan className="svg-unit">%</tspan>
        </text>
      </svg>
    </Shell>
  )
})

// ---- junction ---------------------------------------------------------------

export const JunctionNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const r = useLab((s) => s.results.nodes[id])
  const c = usePressureColor(r?.pressure)
  return (
    <Shell id={id} kind="junction" selected={selected} label={data.label} sub={r ? fmtU(r.pressure, 'pressure', units) : undefined}>
      <svg width="26" height="26" viewBox="0 0 26 26">
        <circle cx="13" cy="13" r="11" fill="#04070d" />
        <circle cx="13" cy="13" r="8.5" fill={c} style={{ filter: `drop-shadow(0 0 4px ${c})` }} />
        <circle cx="10.5" cy="10" r="2.5" fill="#fff" opacity=".45" />
      </svg>
    </Shell>
  )
})

// ---- outlet -----------------------------------------------------------------

export const OutletNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const r = useLab((s) => s.results.nodes[id])
  const paused = useLab((s) => !s.running)
  const c = usePressureColor(r?.pressure)
  const q = r?.outflow ?? 0
  const on = q > 1e-8
  const held = useLab((s) => s.controls[id] === false)
  const vigor = Math.min(1, Math.sqrt(Math.max(0, r?.pressure ?? 0) / 150000))
  const droop = rotOf(data) % 180 === 90 ? 0 : 10 + (1 - vigor) * 14 // a vertical jet doesn't sag sideways
  return (
    <Shell id={id} kind="outlet" rot={rotOf(data)} selected={selected} label={data.label} sub={held ? 'SHUT · timer' : r ? fmtU(Math.abs(q), 'flow', units) : undefined}>
      <svg width="76" height="64" viewBox="0 0 76 64" style={{ overflow: 'visible' }}>
        <path d="M0,24 H24 L40,28 V36 L24,40 H0 Z" fill="#04070d" />
        <path d="M0,27 H24 L38,29.5 V34.5 L24,37 H0 Z" fill={c} style={{ filter: `drop-shadow(0 0 4px ${c})` }} />
        <rect x="20" y="21" width="5" height="22" rx="1.5" fill="#5a7099" />
        <rect x="38" y="26" width="4" height="12" rx="1.5" fill="#8aa0c6" />
        {on &&
          [-2, -1, 0, 1, 2].map((k) => (
            <path
              key={k}
              className="spray"
              d={`M43,32 Q${58 + vigor * 10},${32 + k * 3} ${62 + vigor * 34},${32 + k * (5 + vigor * 5) + droop}`}
              style={{ animationDuration: `${0.9 - vigor * 0.5}s`, animationDelay: `${-k * 0.13}s`, animationPlayState: paused ? 'paused' : 'running' }}
            />
          ))}
      </svg>
    </Shell>
  )
})

// ---- pressure gauge ---------------------------------------------------------

export const GaugeNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const r = useLab((s) => s.results.nodes[id])
  const pMax = useLab((s) => s.results.pMax)
  const factor = toSI(1, 'pressure', units)
  const full = niceCeil(pMax / factor) // full-scale, display units (shared by every gauge on the rig)
  const val = (r?.pressure ?? 0) / factor
  const t = Math.min(1.04, Math.max(-0.04, val / full))
  const angle = -135 + t * 270
  const arc = (a0: number, a1: number, rad: number) => {
    const pt = (a: number) => [44 + rad * Math.sin((a * Math.PI) / 180), 44 - rad * Math.cos((a * Math.PI) / 180)]
    const [x0, y0] = pt(a0)
    const [x1, y1] = pt(a1)
    return `M${x0},${y0} A${rad},${rad} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`
  }
  const c = usePressureColor(r?.pressure)
  return (
    <Shell id={id} kind="gauge" selected={selected} label={data.label}>
      <svg width="88" height="88" viewBox="0 0 88 88">
        <defs>
          <linearGradient id={`gb-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9fb3d6" />
            <stop offset=".5" stopColor="#3b4a66" />
            <stop offset="1" stopColor="#7d8fb0" />
          </linearGradient>
          <radialGradient id={`gf-${id}`} cx=".4" cy=".3">
            <stop offset="0" stopColor="#16233a" />
            <stop offset="1" stopColor="#070c16" />
          </radialGradient>
        </defs>
        <circle cx="44" cy="44" r="42" fill={`url(#gb-${id})`} />
        <circle cx="44" cy="44" r="37.5" fill={`url(#gf-${id})`} />
        <path d={arc(-135, 135, 31)} fill="none" stroke="#22314d" strokeWidth="4" strokeLinecap="round" />
        {r && t > 0.005 && <path d={arc(-135, -135 + Math.min(1, t) * 270, 31)} fill="none" stroke={c} strokeWidth="4" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 3px ${c})` }} />}
        {Array.from({ length: 11 }, (_, i) => {
          const a = ((-135 + i * 27) * Math.PI) / 180
          const r0 = i % 5 === 0 ? 22 : 24.5
          return (
            <line
              key={i}
              x1={44 + r0 * Math.sin(a)}
              y1={44 - r0 * Math.cos(a)}
              x2={44 + 27 * Math.sin(a)}
              y2={44 - 27 * Math.cos(a)}
              stroke="#a9bbdb"
              strokeWidth={i % 5 === 0 ? 1.6 : 1}
              opacity=".8"
            />
          )
        })}
        <text x="21" y="70" className="svg-tick">
          0
        </text>
        <text x="67" y="70" className="svg-tick">
          {full}
        </text>
        <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: '44px 44px', transition: 'transform .35s cubic-bezier(.3,1.4,.5,1)' }}>
          <path d="M44,16 L46,44 L44,50 L42,44 Z" fill="#ff5d7a" />
        </g>
        <circle cx="44" cy="44" r="4" fill="#cfd9ec" />
        <text x="44" y="64" className="svg-readout small">
          {r ? fmt(r.pressure, 'pressure', units) : '—'}
        </text>
        <text x="44" y="74" className="svg-caption">
          {unitLabel('pressure', units)}
        </text>
      </svg>
    </Shell>
  )
})

// ---- pump -------------------------------------------------------------------

export const PumpNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const d = useLab((s) => s.results.devices[id])
  const paused = useLab((s) => !s.running)
  const cav = useLab((s) => s.results.warnings.some((w) => w.id === id && w.level === 'error'))
  const p = data.props
  const held = useLab((s) => s.controls[id] === false)
  const running = p.on && p.speed >= 0.01 && !held
  const cIn = usePressureColor(d?.pIn)
  const cOut = usePressureColor(d?.pOut)
  return (
    <Shell
      id={id}
      kind="pump"
      rot={rotOf(data)}
      selected={selected}
      label={data.label}
      sub={running ? (d ? `${fmtU(d.flow, 'flow', units)} · +${fmtU(Math.max(0, d.dH), 'head', units)}` : `${Math.round(p.speed * 100)} %`) : held ? 'OFF · timer' : 'OFF'}
    >
      <svg width="100" height="100" viewBox="0 0 100 100" className={cav ? 'cavitating' : ''}>
        <defs>
          <radialGradient id={`pc-${id}`} cx=".35" cy=".3">
            <stop offset="0" stopColor="#2a3b5c" />
            <stop offset="1" stopColor="#0c1424" />
          </radialGradient>
        </defs>
        <rect x="0" y="40" width="18" height="20" fill="#04070d" />
        <rect x="0" y="43" width="18" height="14" fill={cIn} />
        <rect x="82" y="40" width="18" height="20" fill="#04070d" />
        <rect x="82" y="43" width="18" height="14" fill={cOut} style={{ filter: `drop-shadow(0 0 4px ${cOut})` }} />
        <rect x="9" y="36" width="5" height="28" rx="1.5" fill="#5a7099" />
        <rect x="86" y="36" width="5" height="28" rx="1.5" fill="#5a7099" />
        <circle cx="50" cy="50" r="39" fill={`url(#pc-${id})`} stroke="#5a7099" strokeWidth="2.5" />
        <circle cx="50" cy="50" r="32" fill="#060b15" stroke={running ? 'var(--accent)' : '#2a3750'} strokeWidth="1.5" className="pump-ring" />
        <g className="impeller" style={{ transformOrigin: '50px 50px', animationDuration: `${1.1 / Math.max(0.05, p.speed)}s`, animationPlayState: running && !paused ? 'running' : 'paused' }}>
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <path key={a} d="M50,43 C58,36 70,38 77,48" transform={`rotate(${a} 50 50)`} fill="none" stroke={running ? '#7fe9ff' : '#51617f'} strokeWidth="4" strokeLinecap="round" />
          ))}
          <circle cx="50" cy="50" r="7.5" fill="#1b2a44" stroke={running ? '#7fe9ff' : '#51617f'} strokeWidth="2" />
        </g>
        <circle cx="50" cy="50" r="2.5" fill={running ? '#eaffff' : '#51617f'} />
        <circle cx="78" cy="20" r="4" fill={running ? (cav ? '#ff5d7a' : '#3ddc84') : '#2a3750'} className={running ? 'led' : ''} />
      </svg>
    </Shell>
  )
})

// ---- valve ------------------------------------------------------------------

const VALVE_TAG: Record<string, string> = { prv: 'PRV', psv: 'PSV', fcv: 'FCV' }

export const ValveNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const d = useLab((s) => s.results.devices[id])
  const update = useLab((s) => s.updateNode)
  const p = data.props
  const type: string = p.valveType
  const rot = rotOf(data)
  const cIn = usePressureColor(d?.pIn)
  const cOut = usePressureColor(d?.pOut)
  const held = useLab((s) => s.controls[id] === false)
  const open = held ? 0 : type === 'throttle' ? p.opening : d?.status === 'closed' ? 0 : 1
  const K = valveK(p.opening, p.kOpen)
  let sub: string
  if (held) sub = 'SHUT · timer'
  else if (type === 'throttle') sub = p.opening <= 0.001 ? 'CLOSED' : `${Math.round(p.opening * 100)} % · K ${K > 999 ? K.toExponential(1) : K.toFixed(1)}`
  else if (type === 'check') sub = d?.status === 'closed' ? 'seated' : 'open'
  else if (type === 'fcv') sub = `set ${fmtU(p.flowSetting, 'flow', units)}`
  else sub = `set ${fmtU(p.pressureSetting, 'pressure', units)}`
  const body =
    d?.status === 'closed' || open <= 0.001
      ? '#ff5d7a'
      : type === 'throttle'
        ? `color-mix(in oklab, #fab219 ${Math.round((1 - open) * 100)}%, #3ddc84)`
        : d?.status === 'active'
          ? '#fab219'
          : '#3ddc84'
  return (
    <Shell
      id={id}
      kind="valve"
      rot={rot}
      selected={selected}
      label={data.label}
      sub={sub}
      extra={
        selected && type === 'throttle' ? (
          <input
            className="node-slider nodrag nopan"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(p.opening * 100)}
            onChange={(e) => update(id, { opening: Number(e.target.value) / 100 })}
          />
        ) : undefined
      }
    >
      <svg width="92" height="76" viewBox="0 0 92 76">
        <rect x="0" y="28" width="24" height="20" fill="#04070d" />
        <rect x="0" y="31" width="24" height="14" fill={cIn} />
        <rect x="68" y="28" width="24" height="20" fill="#04070d" />
        <rect x="68" y="31" width="24" height="14" fill={cOut} />
        <path d="M20,20 V56 L46,38 Z M72,20 V56 L46,38 Z" fill="#101a2c" stroke="#5a7099" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M24,27 V49 L40,38 Z M68,27 V49 L52,38 Z" fill={body} opacity=".9" style={{ filter: `drop-shadow(0 0 4px ${body})`, transition: 'fill .2s' }} />
        {type === 'check' ? (
          <path d="M34,14 H58 M52,9 L58,14 L52,19" fill="none" stroke="#a9bbdb" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        ) : VALVE_TAG[type] ? (
          <>
            <line x1="46" y1="38" x2="46" y2="22" stroke="#8aa0c6" strokeWidth="3" />
            <path d="M30,22 A16,14 0 0 1 62,22 Z" fill="#1b2a44" stroke="#5a7099" strokeWidth="2" />
            <text x="46" y="19" className="svg-tag" transform={upright(rot, 46, 16)}>
              {VALVE_TAG[type]}
            </text>
          </>
        ) : (
          <>
            <line x1="46" y1="38" x2="46" y2={12 + (1 - open) * 8} stroke="#8aa0c6" strokeWidth="3" style={{ transition: 'all .2s' }} />
            <g style={{ transform: `translateY(${(1 - open) * 8}px)`, transition: 'transform .2s' }}>
              <ellipse cx="46" cy="11" rx="15" ry="4.5" fill="#1b2a44" stroke="#ff5d7a" strokeWidth="2.5" />
            </g>
          </>
        )}
        <circle cx="46" cy="38" r="3.5" fill="#cfd9ec" />
      </svg>
    </Shell>
  )
})

// ---- flow meter -------------------------------------------------------------

export const MeterNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const d = useLab((s) => s.results.devices[id])
  const paused = useLab((s) => !s.running)
  const c = usePressureColor(d?.pIn)
  const q = d?.flow ?? 0
  const spin = Math.abs(q) > 1e-8
  const rot = rotOf(data)
  const turned = rot % 180 === 90
  return (
    <Shell id={id} kind="meter" rot={rot} selected={selected} label={data.label} sub={rot % 180 === 90 && d ? fmtU(Math.abs(q), 'flow', units) : undefined}>
      <svg width="104" height="56" viewBox="0 0 104 56">
        <rect x="0" y="18" width="104" height="20" fill="#04070d" />
        <rect x="0" y="21" width="104" height="14" fill={c} />
        <rect x="10" y="4" width="84" height="48" rx="9" fill="#0c1424" stroke="#5a7099" strokeWidth="2.5" />
        <rect x="35" y="11" width="53" height="34" rx="5" fill="#03140f" stroke="#15382c" />
        <g
          className="impeller"
          style={{
            transformOrigin: '23px 28px',
            animationDuration: `${Math.max(0.25, 1.6 - (d?.velocity ?? 0) * 0.5)}s`,
            animationDirection: q < 0 ? 'reverse' : 'normal',
            animationPlayState: spin && !paused ? 'running' : 'paused',
          }}
        >
          {[0, 90, 180, 270].map((a) => (
            <path key={a} d="M23,28 q4,-7 0,-10" transform={`rotate(${a} 23 28)`} fill="none" stroke="#7fe9ff" strokeWidth="2.5" strokeLinecap="round" />
          ))}
        </g>
        <circle cx="23" cy="28" r="2" fill="#eaffff" />
        <text x={turned ? 61.5 : 84} y="31" className={`svg-lcd ${turned ? 'turned' : ''}`} transform={upright(rot, 61.5, 28)}>
          {d ? fmt(Math.abs(q), 'flow', units) : '—'}
        </text>
        <text x={turned ? 61.5 : 84} y="41" className={`svg-lcd-unit ${turned ? 'turned' : ''}`} transform={upright(rot, 61.5, 28)}>
          {unitLabel('flow', units)}
        </text>
      </svg>
    </Shell>
  )
})

// ---- venturi / orifice ------------------------------------------------------

export const ElementNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const d = useLab((s) => s.results.devices[id])
  const overlay = useLab((s) => s.overlay)
  const pMax = useLab((s) => s.results.pMax)
  const p = data.props
  const rot = rotOf(data)
  const cIn = usePressureColor(d?.pIn)
  const cOut = usePressureColor(d?.pOut)
  // the throat really does run at a lower pressure — show it
  const cThroat = d && overlay === 'pressure' ? pressureColor(Math.min(d.pIn, d.pOut) - (d.tapDp ?? 0), pMax) : cIn
  const venturi = p.elementType !== 'orifice'
  const half = 3 + 11 * beta(p) // half-height of the throat / orifice opening
  return (
    <Shell id={id} kind="element" rot={rot} selected={selected} label={data.label} sub={d ? `Δp ${fmtU(d.tapDp, 'pressure', units)}` : undefined}>
      <svg width="120" height="64" viewBox="0 0 120 64">
        <defs>
          <linearGradient id={`fe-${id}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={cIn} />
            <stop offset={venturi ? '.42' : '.5'} stopColor={cThroat} />
            <stop offset="1" stopColor={cOut} />
          </linearGradient>
        </defs>
        {venturi ? (
          <>
            <path d={`M0,17 H22 L46,${32 - half - 3} H56 L98,17 H120 V47 H98 L56,${32 + half + 3} H46 L22,47 H0 Z`} fill="#04070d" />
            <path d={`M0,21 H22 L46,${32 - half} H56 L98,21 H120 V43 H98 L56,${32 + half} H46 L22,43 H0 Z`} fill={`url(#fe-${id})`} style={{ filter: `drop-shadow(0 0 4px ${cThroat})` }} />
            <path d={`M22,17 L46,${32 - half - 3} H56 L98,17 M22,47 L46,${32 + half + 3} H56 L98,47`} fill="none" stroke="#5a7099" strokeWidth="2.5" strokeLinejoin="round" />
            <path d="M30,18 V6 H51 V23" fill="none" stroke="#8aa0c6" strokeWidth="1.5" strokeDasharray="2 2" />
          </>
        ) : (
          <>
            <rect x="0" y="17" width="120" height="30" fill="#04070d" />
            <rect x="0" y="21" width="120" height="22" fill={`url(#fe-${id})`} />
            <path d={`M60,6 V${32 - half} M60,${32 + half} V58`} stroke="#cfd9ec" strokeWidth="4" strokeLinecap="round" />
            <path d="M53,8 V56 M67,8 V56" stroke="#5a7099" strokeWidth="4" strokeLinecap="round" />
            <path d={`M64,${32 - half + 1} Q82,32 104,23 M64,${32 + half - 1} Q82,32 104,41`} fill="none" stroke="#fff" strokeWidth="1" opacity=".35" />
            <path d="M42,18 V6 H76 V18" fill="none" stroke="#8aa0c6" strokeWidth="1.5" strokeDasharray="2 2" />
          </>
        )}
        <rect x="8" y="13" width="5" height="38" rx="1.5" fill="#5a7099" />
        <rect x="107" y="13" width="5" height="38" rx="1.5" fill="#5a7099" />
        <text x="60" y="61" className="svg-tag" transform={upright(rot, 60, 58)}>
          β {beta(p).toFixed(2)}
        </text>
      </svg>
    </Shell>
  )
})

// ---- differential pressure gauge ----------------------------------------------

export const DpGaugeNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const d = useLab((s) => s.results.devices[id])
  const dp = d ? d.pIn - d.pOut : undefined
  return (
    <Shell id={id} kind="dpgauge" selected={selected} label={data.label}>
      <svg width="96" height="96" viewBox="0 0 96 96">
        <defs>
          <linearGradient id={`dp-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9fb3d6" />
            <stop offset=".5" stopColor="#3b4a66" />
            <stop offset="1" stopColor="#7d8fb0" />
          </linearGradient>
        </defs>
        <path d="M0,77 H14 M82,77 H96" stroke="#5a7099" strokeWidth="7" strokeLinecap="round" />
        <rect x="8" y="4" width="80" height="88" rx="14" fill={`url(#dp-${id})`} />
        <rect x="12" y="8" width="72" height="80" rx="11" fill="#0a111d" />
        <text x="48" y="25" className="svg-tag big">
          ΔP
        </text>
        <rect x="18" y="31" width="60" height="32" rx="5" fill="#03140f" stroke="#15382c" />
        <text x="74" y="51" className="svg-lcd">
          {dp !== undefined ? fmt(dp, 'pressure', units) : '—'}
        </text>
        <text x="74" y="60" className="svg-lcd-unit">
          {unitLabel('pressure', units)}
        </text>
        <text x="23" y="81" className="svg-port hi">
          HI
        </text>
        <text x="73" y="81" className="svg-port lo">
          LO
        </text>
        <path d={`M34,77 H62`} stroke="#22314d" strokeWidth="2" strokeDasharray="2 3" />
      </svg>
    </Shell>
  )
})

// ---- timer ------------------------------------------------------------------

export const TimerNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const t = useLab((s) => s.simTime)
  const wired = useLab((s) => s.edges.some((e) => e.type === 'signal' && e.source === id))
  const p = data.props
  const st = timerState(p, t)
  const live = p.enabled
  const color = !live ? '#51617f' : st.on ? SIGNAL_ON : SIGNAL_OFF
  const R = 30
  const C = 2 * Math.PI * R
  return (
    <Shell
      id={id}
      kind="timer"
      selected={selected}
      label={data.label}
      sub={!live ? 'disabled' : !wired ? 'not wired' : p.mode === 'once' ? `one-shot → ${p.action.toUpperCase()}` : `${fmtClock(p.onTime)} on / ${fmtClock(p.offTime)} off`}
    >
      <svg width="96" height="104" viewBox="0 0 96 104">
        <defs>
          <linearGradient id={`tb-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9fb3d6" />
            <stop offset=".5" stopColor="#3b4a66" />
            <stop offset="1" stopColor="#7d8fb0" />
          </linearGradient>
        </defs>
        <rect x="41" y="0" width="14" height="9" rx="2.5" fill="#5a7099" />
        <rect x="35" y="0" width="26" height="5" rx="2.5" fill="#8aa0c6" />
        <path d="M74,22 l7,-7" stroke="#5a7099" strokeWidth="5" strokeLinecap="round" />
        <circle cx="48" cy="56" r="42" fill={`url(#tb-${id})`} />
        <circle cx="48" cy="56" r="37.5" fill="#080d18" />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i * Math.PI) / 6
          return <line key={i} x1={48 + 33 * Math.sin(a)} y1={56 - 33 * Math.cos(a)} x2={48 + 36 * Math.sin(a)} y2={56 - 36 * Math.cos(a)} stroke="#6f819f" strokeWidth={i % 3 === 0 ? 2 : 1} />
        })}
        <circle cx="48" cy="56" r={R} fill="none" stroke="#1a2438" strokeWidth="5" />
        <circle
          cx="48"
          cy="56"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${C * (live ? st.progress : 0)} ${C}`}
          transform="rotate(-90 48 56)"
          style={{ filter: live && st.on ? `drop-shadow(0 0 4px ${color})` : undefined }}
        />
        <text x="48" y="53" className="svg-readout small timer-state" style={{ fill: color }}>
          {!live ? '– –' : st.on ? 'ON' : 'OFF'}
        </text>
        <text x="48" y="68" className="svg-lcd timer-count">
          {live && st.next !== null ? fmtClock(st.next) : '∞'}
        </text>
      </svg>
    </Shell>
  )
})

export const nodeTypes = {
  reservoir: ReservoirNode,
  tank: TankNode,
  junction: JunctionNode,
  outlet: OutletNode,
  gauge: GaugeNode,
  pump: PumpNode,
  valve: ValveNode,
  meter: MeterNode,
  element: ElementNode,
  dpgauge: DpGaugeNode,
  timer: TimerNode,
}
