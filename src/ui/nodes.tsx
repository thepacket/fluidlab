import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { memo, useEffect, type ReactNode } from 'react'
import { NODE_SIZE, PORT_Y, type LabNode } from '../experiments'
import { dischargeDevice, lossDevice, type Glyph } from '../model/catalog'
import { PV_CONSUMERS, PV_SOURCES, fmtClock, timerState } from '../model/control'
import { beta, fittingK, tankHeight, valveK, vesselPressure, vesselWater } from '../model/physics'
import { CONTROLLABLE, ROTATABLE, isControl, type Kind } from '../model/types'
import { fmt, fmtU, toSI, unitLabel } from '../model/units'
import { useLab } from '../store'
import { DRY, PLAIN, SIGNAL_OFF, SIGNAL_ON, niceCeil, pressureColor } from './colors'

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

/** Measurement output: wiring it turns a gauge, meter or tank into a transmitter. */
function MeasurementPort({ kind, rot }: { kind: Kind; rot: number }) {
  if (!PV_SOURCES[kind]) return null
  // the plain gauge already has a fluid port top-centre, so its transmitter lug sits off to the side
  return (
    <Handle
      id="pv"
      type="source"
      position={kind === 'meter' ? (rot === 180 ? Position.Top : side(Position.Top, rot)) : Position.Top}
      className="port port-signal port-pv"
      style={kind === 'gauge' ? { left: '86%' } : undefined}
    />
  )
}

function Ports({ kind, rot }: { kind: Kind; rot: number }) {
  if (isControl(kind))
    return (
      <>
        {kind !== 'timer' && kind !== 'manual' && <Handle id="cin" type="source" position={Position.Left} className={`port port-signal ${PV_CONSUMERS.includes(kind) ? 'port-pv' : ''}`} />}
        {kind !== 'lamp' && <Handle id="sig" type="source" position={Position.Right} className="port port-signal" />}
      </>
    )
  if (kind === 'dpgauge' || ROTATABLE.includes(kind)) {
    const y = kind === 'dpgauge' ? { top: `${PORT_Y[kind] * 100}%` } : undefined
    if (kind === 'outlet' || kind === 'relief') return <Handle id="l" type="source" position={side(Position.Left, rot)} className="port" />
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
      {kind !== 'reservoir' && kind !== 'tank' && kind !== 'vessel' && <Handle id="t" type="source" position={Position.Top} className="port" />}
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
      <MeasurementPort kind={kind} rot={rot} />
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
  const type: string = data.props.sourceType ?? 'surface'
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
          {type === 'mains' ? fmt(data.props.pressure, 'pressure', units) : fmt(type === 'well' ? (r?.head ?? data.props.staticLevel) : data.props.head, 'head', units)}
          <tspan className="svg-unit"> {unitLabel(type === 'mains' ? 'pressure' : 'head', units)}</tspan>
        </text>
        <text x="66" y="76" className="svg-caption">
          {type === 'mains' ? 'MAINS' : type === 'well' ? 'PUMPING LEVEL' : 'HEAD'}
        </text>
        {type === 'mains' && <path d="M2,48 H130" stroke="#8aa0c6" strokeWidth="7" opacity=".35" />}
        {type === 'well' && <path d="M40,4 V92 M92,4 V92" stroke="#c98500" strokeWidth="2" strokeDasharray="3 4" opacity=".7" />}
      </svg>
    </Shell>
  )
})

// ---- tank -------------------------------------------------------------------

/** Outline of each tank shape in the 112×136 box, with the y of its full and empty marks. */
const TANK_ART: Record<string, { d: string; top: number; bottom: number }> = {
  cylinder: { d: 'M16,20 a10,10 0 0 1 10,-10 h60 a10,10 0 0 1 10,10 v96 a10,10 0 0 1 -10,10 h-60 a10,10 0 0 1 -10,-10 z', top: 14, bottom: 124 },
  cone: { d: 'M8,10 H104 L62,126 H50 Z', top: 12, bottom: 126 },
  sphere: { d: 'M56,14 a52,52 0 1 0 0.010,0 z', top: 16, bottom: 118 },
  drum: { d: 'M44,32 h24 a38,38 0 0 1 0,76 h-24 a38,38 0 0 1 0,-76 z', top: 33, bottom: 108 },
}

export const TankNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const level = useLab((s) => s.levels[id] ?? data.props.initLevel)
  const r = useLab((s) => s.results.nodes[id])
  const p = data.props
  const art = TANK_ART[p.shape] ?? TANK_ART.cylinder
  const frac = Math.min(1, Math.max(0, level / Math.max(0.01, tankHeight(p))))
  const { top, bottom } = art
  const y = bottom - frac * (bottom - top)
  const net = r?.outflow ?? 0
  const trend = Math.abs(net) < 1e-7 ? '' : net > 0 ? '▲' : '▼'
  const spilling = !!p.overflow && frac >= 0.999 && net > 1e-7
  const paused = useLab((s) => !s.running)
  return (
    <Shell id={id} kind="tank" selected={selected} label={data.label} sub={spilling ? `overflowing ${fmtU(net, 'flow', units)}` : `${trend} ${fmtU(level, 'length', units)}`}>
      <svg width="112" height="136" viewBox="0 0 112 136">
        <defs>
          <linearGradient id={`tw-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4fd4ff" />
            <stop offset="1" stopColor="#1749c4" />
          </linearGradient>
          <clipPath id={`tc-${id}`}>
            <path d={art.d} />
          </clipPath>
        </defs>
        <path d={art.d} fill="#0a1526" />
        <g clipPath={`url(#tc-${id})`}>
          <g style={{ transform: `translateY(${y}px)`, transition: 'transform .25s linear' }}>
            <path className="wave wave-slow" d={wave(-3, 112, 140)} fill="#2b7fe0" opacity=".5" />
            <path className="wave" d={wave(0, 112, 140)} fill={`url(#tw-${id})`} opacity=".92" />
          </g>
          <rect x="22" y="0" width="9" height="136" fill="#fff" opacity=".07" />
        </g>
        <path d={art.d} fill="none" stroke="#5a7099" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M10,126 H102 M26,126 V134 M86,126 V134" stroke="#5a7099" strokeWidth="2.5" strokeLinecap="round" />
        {p.overflow && <path d="M96,18 H108 V30" fill="none" stroke="#8aa0c6" strokeWidth="4" strokeLinecap="round" />}
        {spilling &&
          [0, 1, 2].map((k) => (
            <path
              key={k}
              className="spray"
              d={`M${106 + k * 2},32 Q${108 + k * 3},80 ${104 + k * 6},130`}
              style={{ animationDuration: '.6s', animationDelay: `${-k * 0.2}s`, animationPlayState: paused ? 'paused' : 'running' }}
            />
          ))}
        <text x="56" y={p.shape === 'cone' ? 58 : 74} className="svg-readout big">
          {Math.round(frac * 100)}
          <tspan className="svg-unit">%</tspan>
        </text>
      </svg>
    </Shell>
  )
})

// ---- pressure vessel -------------------------------------------------------------------

export const VesselNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const p = data.props
  const water = useLab((s) => s.levels[id] ?? vesselWater(p, p.initPressure))
  const r = useLab((s) => s.results.nodes[id])
  const frac = Math.min(1, Math.max(0, water / Math.max(1e-9, p.volume)))
  const y = 112 - frac * 100 // the bladder rises as water comes in
  const pressure = vesselPressure(p, water)
  const net = r?.outflow ?? 0
  return (
    <Shell id={id} kind="vessel" selected={selected} label={data.label} sub={`${Math.abs(net) < 1e-7 ? '' : net > 0 ? '▲ ' : '▼ '}${(water * 1000).toFixed(0)} L water`}>
      <svg width="92" height="124" viewBox="0 0 92 124">
        <defs>
          <clipPath id={`vc-${id}`}>
            <rect x="12" y="8" width="68" height="108" rx="30" />
          </clipPath>
          <linearGradient id={`vw-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4fd4ff" />
            <stop offset="1" stopColor="#1749c4" />
          </linearGradient>
        </defs>
        <g clipPath={`url(#vc-${id})`}>
          <rect x="12" y="8" width="68" height="108" fill="#1a1630" />
          {/* the gas cushion brightens as it is squeezed */}
          <rect x="12" y="8" width="68" height="108" fill="#9085e9" opacity={0.12 + 0.45 * frac} />
          <g style={{ transform: `translateY(${y}px)`, transition: 'transform .25s linear' }}>
            <rect x="0" y="0" width="92" height="124" fill={`url(#vw-${id})`} />
            <path d="M12,0 Q46,-14 80,0" fill="none" stroke="#e8d9ff" strokeWidth="3" />
          </g>
        </g>
        <rect x="12" y="8" width="68" height="108" rx="30" fill="none" stroke="#5a7099" strokeWidth="2.5" />
        <path d="M46,8 V2 M40,2 H52" stroke="#8aa0c6" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M24,116 V122 M68,116 V122" stroke="#5a7099" strokeWidth="2.5" strokeLinecap="round" />
        <text x="46" y="56" className="svg-readout">
          {fmt(pressure, 'pressure', units)}
        </text>
        <text x="46" y="68" className="svg-caption">
          {unitLabel('pressure', units).toUpperCase()}
        </text>
      </svg>
    </Shell>
  )
})

// ---- leaky joint ----------------------------------------------------------------------

export const LeakNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const r = useLab((s) => s.results.nodes[id])
  const paused = useLab((s) => !s.running)
  const c = usePressureColor(r?.pressure)
  const q = r?.outflow ?? 0
  return (
    <Shell id={id} kind="leak" selected={selected} label={data.label} sub={data.props.active === false ? 'intact' : r ? `${fmtU(q, 'flow', units)} lost` : undefined}>
      <svg width="44" height="44" viewBox="0 0 44 44" style={{ overflow: 'visible' }}>
        <circle cx="22" cy="22" r="13" fill="#04070d" />
        <circle cx="22" cy="22" r="10" fill={c} style={{ filter: `drop-shadow(0 0 4px ${c})` }} />
        {data.props.active !== false && <path d="M17,15 l4,5 l-3,3 l5,6" fill="none" stroke="#04070d" strokeWidth="2" strokeLinejoin="round" />}
        {data.props.variant === 'burst' && <circle cx="22" cy="22" r="16" fill="none" stroke="#ff5d7a" strokeWidth="1.500" strokeDasharray="3 3" />}
        {q > 1e-8 &&
          [-1, 0, 1].map((k) => (
            <path
              key={k}
              className="spray"
              d={`M24,28 Q${30 + k * 5},40 ${32 + k * 9},56`}
              style={{ animationDuration: '.7s', animationDelay: `${-k * 0.2}s`, animationPlayState: paused ? 'paused' : 'running' }}
            />
          ))}
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
  const held = useLab((s) => (s.controls[id] ?? 1) < 0.5)
  const glyph = dischargeDevice(data.props.variant)?.glyph ?? 'nozzle'
  const sealed = glyph === 'sprinkler' && !data.props.fused
  const vigor = Math.min(1, Math.sqrt(Math.max(0, r?.pressure ?? 0) / 150000))
  const droop = rotOf(data) % 180 === 90 ? 0 : 10 + (1 - vigor) * 14 // a vertical jet doesn't sag sideways
  const anim = (k: number, base = 0.9) => ({ animationDuration: `${base - vigor * 0.5}s`, animationDelay: `${-k * 0.13}s`, animationPlayState: paused ? 'paused' : 'running' }) as const
  return (
    <Shell id={id} kind="outlet" rot={rotOf(data)} selected={selected} label={data.label} sub={held ? 'SHUT · held' : sealed ? 'sealed' : r ? fmtU(Math.abs(q), 'flow', units) : undefined}>
      <svg width="76" height="64" viewBox="0 0 76 64" style={{ overflow: 'visible' }}>
        {glyph === 'sprinkler' ? (
          <>
            <path d="M0,27 H26 V37 H0 Z" fill={c} stroke="#04070d" strokeWidth="3" />
            <path d="M26,24 H34 V40 H26 Z" fill="#8aa0c6" />
            {/* frame arms, deflector, and the glass bulb that holds it shut */}
            <path d="M34,26 Q48,22 54,32 Q48,42 34,38" fill="none" stroke="#8aa0c6" strokeWidth="2.5" />
            <path d="M56,20 V44" stroke="#cfd9ec" strokeWidth="3.500" strokeLinecap="round" />
            {sealed && <rect x="35" y="29.500" width="18" height="5" rx="2.500" fill="#ff5d7a" style={{ filter: 'drop-shadow(0 0 3px #ff5d7a)' }} />}
            {on &&
              [-3, -2, -1, 1, 2, 3].map((k) => (
                <path key={k} className="spray" d={`M58,${32 + k * 3} Q${70 + vigor * 8},${32 + k * 10} ${72 + vigor * 22},${32 + k * (13 + vigor * 6)}`} style={anim(k)} />
              ))}
          </>
        ) : glyph === 'hydrant' ? (
          <>
            <path d="M0,24 H22 V40 H0 Z" fill="#04070d" />
            <path d="M0,27 H22 V37 H0 Z" fill={c} />
            <path d="M22,12 H40 Q46,12 46,18 V46 Q46,52 40,52 H22 Z" fill="#c0392b" stroke="#ff8f80" strokeWidth="2" />
            <path d="M28,8 H40 M34,8 V12" stroke="#ff8f80" strokeWidth="3" strokeLinecap="round" />
            <rect x="46" y="25" width="9" height="14" rx="2" fill="#8aa0c6" />
            {on &&
              [-2, -1, 0, 1, 2].map((k) => (
                <path key={k} className="spray" d={`M56,32 Q${72 + vigor * 12},${32 + k * 2} ${80 + vigor * 40},${32 + k * 6 + droop}`} style={{ ...anim(k), strokeWidth: 3.2 }} />
              ))}
          </>
        ) : glyph === 'drip' ? (
          <>
            <path d="M0,27 H24 V37 H0 Z" fill={c} stroke="#04070d" strokeWidth="3" />
            <rect x="24" y="22" width="16" height="20" rx="5" fill="#1b2a44" stroke="#5a7099" strokeWidth="2" />
            <circle cx="40" cy="32" r="2.500" fill="#8aa0c6" />
            {on && <path className="spray" d="M44,32 H74" style={{ animationDuration: '1.6s', strokeDasharray: '2 12', animationPlayState: paused ? 'paused' : 'running' }} />}
          </>
        ) : glyph === 'tap' || glyph === 'shower' ? (
          <>
            <path d="M0,27 H30 Q44,27 44,40 V46 H36 V40 Q36,35 30,35 H0 Z" fill={c} stroke="#04070d" strokeWidth="3" strokeLinejoin="round" />
            <path d="M22,27 V16 M14,15 H30" stroke="#cfd9ec" strokeWidth="3.500" strokeLinecap="round" />
            {glyph === 'shower' && <path d="M30,46 H50 L54,52 H26 Z" fill="#8aa0c6" />}
            {on &&
              (glyph === 'shower' ? [-2, -1, 0, 1, 2] : [0]).map((k) => (
                <path
                  key={k}
                  className="spray"
                  d={`M${40 + k * 5},${glyph === 'shower' ? 54 : 48} L${40 + k * 9},${70 + vigor * 14}`}
                  style={{ ...anim(k), strokeWidth: glyph === 'shower' ? 1.8 : 3.2 }}
                />
              ))}
          </>
        ) : glyph === 'rotor' ? (
          <>
            <path d="M0,27 H22 V37 H0 Z" fill={c} stroke="#04070d" strokeWidth="3" />
            <rect x="22" y="20" width="18" height="24" rx="4" fill="#1b2a44" stroke="#5a7099" strokeWidth="2" />
            <rect x="40" y="27" width="8" height="10" rx="2" fill="#8aa0c6" />
            {on && [-2, -1, 0, 1, 2].map((k) => <path key={k} className="spray" d={`M49,32 Q${66 + vigor * 12},${32 + k * 7} ${78 + vigor * 30},${32 + k * 16 + droop * 0.5}`} style={anim(k)} />)}
          </>
        ) : (
          <>
            <path d="M0,24 H24 L40,28 V36 L24,40 H0 Z" fill="#04070d" />
            <path d="M0,27 H24 L38,29.5 V34.5 L24,37 H0 Z" fill={c} style={{ filter: `drop-shadow(0 0 4px ${c})` }} />
            <rect x="20" y="21" width="5" height="22" rx="1.5" fill="#5a7099" />
            <rect x="38" y="26" width="4" height="12" rx="1.5" fill="#8aa0c6" />
            {glyph === 'hose' && <circle cx="14" cy="32" r="12" fill="none" stroke="#c0392b" strokeWidth="4" strokeDasharray="5 3" />}
            {on &&
              [-2, -1, 0, 1, 2].map((k) => <path key={k} className="spray" d={`M43,32 Q${58 + vigor * 10},${32 + k * 3} ${62 + vigor * 34},${32 + k * (5 + vigor * 5) + droop}`} style={anim(k)} />)}
          </>
        )}
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
  const cmd = useLab((s) => s.controls[id])
  const speed = p.speed * (cmd ?? 1) // a controller trims the drive's own speed
  const held = cmd !== undefined && speed < 0.01
  const running = p.on && speed >= 0.01
  const cIn = usePressureColor(d?.pIn)
  const cOut = usePressureColor(d?.pOut)
  return (
    <Shell
      id={id}
      kind="pump"
      rot={rotOf(data)}
      selected={selected}
      label={data.label}
      sub={running ? (d ? `${fmtU(d.flow, 'flow', units)} · +${fmtU(Math.max(0, d.dH), 'head', units)}` : `${Math.round(speed * 100)} %`) : held ? 'OFF · held' : 'OFF'}
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
        <g className="impeller" style={{ transformOrigin: '50px 50px', animationDuration: `${1.1 / Math.max(0.05, speed)}s`, animationPlayState: running && !paused ? 'running' : 'paused' }}>
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

const VALVE_TAG: Record<string, string> = { prv: 'PRV', psv: 'PSV', fcv: 'FCV', float: 'FLT' }

export const ValveNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const d = useLab((s) => s.results.devices[id])
  const update = useLab((s) => s.updateNode)
  const p = data.props
  const type: string = p.valveType
  const rot = rotOf(data)
  const cIn = usePressureColor(d?.pIn)
  const cOut = usePressureColor(d?.pOut)
  const cmd = useLab((s) => s.controls[id])
  // where the plug actually is: its own setting, scaled by any command — or wherever its float has put it
  const position = type === 'float' ? (d?.position ?? p.opening) : p.opening * (cmd ?? 1)
  const throttling = type === 'throttle' || type === 'float'
  const held = cmd !== undefined && (throttling ? position <= 0.001 : cmd < 0.5)
  const open = held ? 0 : throttling ? position : d?.status === 'closed' ? 0 : 1
  const K = valveK(position, p.kOpen, p.trim)
  let sub: string
  if (held) sub = 'SHUT · held'
  else if (type === 'float') sub = position <= 0.001 ? 'float up · shut' : `float · ${Math.round(position * 100)} %`
  else if (type === 'throttle') sub = position <= 0.001 ? 'CLOSED' : `${Math.round(position * 100)} %${cmd !== undefined ? ' auto' : ''} · K ${K > 999 ? K.toExponential(1) : K.toFixed(1)}`
  else if (type === 'check') sub = d?.status === 'closed' ? 'seated' : 'open'
  else if (type === 'fcv') sub = `set ${fmtU(p.flowSetting, 'flow', units)}`
  else sub = `set ${fmtU(p.pressureSetting, 'pressure', units)}`
  const body =
    d?.status === 'closed' || open <= 0.001 ? '#ff5d7a' : throttling ? `color-mix(in oklab, #fab219 ${Math.round((1 - open) * 100)}%, #3ddc84)` : d?.status === 'active' ? '#fab219' : '#3ddc84'
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

// ---- catalogue loss devices -----------------------------------------------------------

/** P&ID-style symbols, drawn in a 96×64 box around the pipe axis y = 32. `c` is the fluid colour. */
function glyph(g: Glyph, c: string, fouling: number): ReactNode {
  const steel = '#5a7099'
  const body = { fill: '#0c1424', stroke: steel, strokeWidth: 2.5, strokeLinejoin: 'round' as const }
  switch (g) {
    case 'elbow':
      return <path d="M30,32 H52 Q66,32 66,18 V8" fill="none" stroke={c} strokeWidth="12" strokeLinecap="butt" />
    case 'elbow45':
      return <path d="M30,32 H50 L66,16" fill="none" stroke={c} strokeWidth="12" strokeLinejoin="round" />
    case 'tee':
      return <path d="M30,32 H66 M48,32 V8" fill="none" stroke={c} strokeWidth="12" />
    case 'reducer':
      return <path d="M28,16 L68,25 V39 L28,48 Z" {...body} fill={c} />
    case 'expander':
      return <path d="M28,25 L68,16 V48 L28,39 Z" {...body} fill={c} />
    case 'entrance':
      return (
        <>
          <path d="M26,6 V58" stroke={steel} strokeWidth="4" strokeLinecap="round" />
          <path d="M14,18 Q30,22 40,30 M14,46 Q30,42 40,34 M10,32 H38" fill="none" stroke="#fff" strokeWidth="1.5" opacity=".5" />
        </>
      )
    case 'exit':
      return (
        <>
          <path d="M70,6 V58" stroke={steel} strokeWidth="4" strokeLinecap="round" />
          <path d="M58,30 Q70,22 84,16 M58,34 Q70,42 84,48 M58,32 H88" fill="none" stroke="#fff" strokeWidth="1.5" opacity=".5" />
        </>
      )
    case 'strainer':
      return (
        <>
          <path d="M26,20 H70 V44 H58 L40,62 L30,52 L44,44 H26 Z" {...body} />
          <path d="M44,44 L58,44 M47,47 L41,53 M52,47 L44,55" stroke={steel} strokeWidth="1.5" strokeDasharray="2 2" />
          <path d="M34,50 L42,58" stroke="#c98500" strokeWidth={1 + fouling * 7} strokeLinecap="round" opacity={fouling > 0.02 ? 0.9 : 0} />
        </>
      )
    case 'filter':
      return (
        <>
          <rect x="30" y="8" width="36" height="50" rx="6" {...body} />
          <path d="M38,16 V50 M44,16 V50 M50,16 V50 M56,16 V50" stroke={steel} strokeWidth="1.5" />
          <rect x="31.500" y={57 - fouling * 46} width="33" height={fouling * 46} fill="#c98500" opacity=".55" />
        </>
      )
    case 'plate':
      return (
        <>
          <rect x="28" y="8" width="40" height="48" rx="3" {...body} />
          <path d="M34,8 V56 M40,8 V56 M46,8 V56 M52,8 V56 M58,8 V56 M62,8 V56" stroke={c} strokeWidth="1.5" opacity=".8" />
        </>
      )
    case 'shell':
      return (
        <>
          <rect x="22" y="14" width="52" height="36" rx="18" {...body} />
          <path d="M30,24 H66 M28,32 H68 M30,40 H66" stroke={c} strokeWidth="2" />
        </>
      )
    case 'coil':
      return <path d="M24,32 H30 V12 H38 V52 H46 V12 H54 V52 H62 V12 H68 V32 H72" fill="none" stroke={c} strokeWidth="4" strokeLinejoin="round" />
    case 'mixer':
      return (
        <>
          <rect x="24" y="20" width="48" height="24" rx="4" {...body} />
          <path d="M28,40 L38,24 L48,40 L58,24 L68,40" fill="none" stroke={c} strokeWidth="2" />
        </>
      )
    case 'membrane':
      return (
        <>
          <rect x="22" y="16" width="52" height="32" rx="4" {...body} />
          <path d="M26,44 L70,20" stroke={c} strokeWidth="2" strokeDasharray="3 2.500" />
          <rect x="23.500" y="17.500" width="49" height="29" rx="3" fill="#c98500" opacity={fouling * 0.5} />
        </>
      )
    case 'uv':
      return (
        <>
          <rect x="22" y="18" width="52" height="28" rx="14" {...body} />
          <path d="M30,32 H66" stroke="#b7a9ff" strokeWidth="4" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 5px #9085e9)' }} />
        </>
      )
    default:
      return (
        <>
          <rect x="26" y="14" width="44" height="36" rx="6" {...body} />
          <path d="M34,40 Q48,14 62,40" fill="none" stroke={c} strokeWidth="2" />
        </>
      )
  }
}

export const FittingNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const d = useLab((s) => s.results.devices[id])
  const p = data.props
  const spec = lossDevice(p.variant)
  const rot = rotOf(data)
  const cIn = usePressureColor(d?.pIn)
  const cOut = usePressureColor(d?.pOut)
  const dp = d ? Math.abs(d.pIn - d.pOut) : undefined
  const sub =
    spec.model === 'k'
      ? `K ${fittingK(p, spec.byDiameters).K.toFixed(2)}${dp !== undefined ? ` · ${fmtU(dp, 'pressure', units)}` : ''}`
      : `${dp !== undefined ? `Δp ${fmtU(dp, 'pressure', units)}` : spec.name}${p.fouling > 0.02 ? ` · ${Math.round(p.fouling * 100)} % fouled` : ''}`
  // a bend or tee leaves through the top of its box; everything else runs straight through
  const bent = spec.glyph === 'elbow' || spec.glyph === 'elbow45' || spec.glyph === 'tee'
  return (
    <Shell id={id} kind="fitting" rot={rot} selected={selected} label={data.label} sub={sub}>
      <svg width="96" height="64" viewBox="0 0 96 64">
        <rect x="0" y="22" width="32" height="20" fill="#04070d" />
        <rect x="0" y="25" width="32" height="14" fill={cIn} />
        <rect x="64" y="22" width="32" height="20" fill="#04070d" />
        <rect x="64" y="25" width="32" height="14" fill={cOut} />
        {bent && <path d="M30,32 H66" stroke={cIn} strokeWidth="12" />}
        {glyph(spec.glyph, cIn, p.fouling ?? 0)}
        <rect x="6" y="18" width="5" height="28" rx="1.5" fill="#5a7099" />
        <rect x="85" y="18" width="5" height="28" rx="1.5" fill="#5a7099" />
      </svg>
    </Shell>
  )
})

export const ReliefNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const r = useLab((s) => s.results.nodes[id])
  const paused = useLab((s) => !s.running)
  const c = usePressureColor(r?.pressure)
  const lifting = (r?.outflow ?? 0) > 1e-8
  const rot = rotOf(data)
  return (
    <Shell
      id={id}
      kind="relief"
      rot={rot}
      selected={selected}
      label={data.label}
      sub={lifting ? `venting ${fmtU(r!.outflow, 'flow', units)}` : `set ${fmtU(data.props.setPressure, 'pressure', units)}`}
    >
      <svg width="84" height="64" viewBox="0 0 84 64" style={{ overflow: 'visible' }}>
        <rect x="0" y="22" width="22" height="20" fill="#04070d" />
        <rect x="0" y="25" width="22" height="14" fill={c} />
        <path d="M18,14 V50 L40,32 Z" fill={lifting ? '#fab219' : '#101a2c'} stroke="#5a7099" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M40,32 L58,18 V46 Z" fill="#101a2c" stroke="#5a7099" strokeWidth="2.5" strokeLinejoin="round" />
        {/* spring housing */}
        <path
          d={`M58,32 l4,-7 l4,14 l4,-14 l4,14 l4,-7`}
          fill="none"
          stroke={lifting ? '#fab219' : '#8aa0c6'}
          strokeWidth="2"
          strokeLinejoin="round"
          transform={lifting ? 'translate(58 0) scale(.8 1) translate(-58 0) translate(6 0)' : undefined}
        />
        <path d="M80,20 V44" stroke="#5a7099" strokeWidth="3" strokeLinecap="round" />
        {lifting &&
          [-1, 0, 1].map((k) => (
            <path
              key={k}
              className="spray"
              d={`M40,24 Q${40 + k * 8},8 ${40 + k * 16},-10`}
              style={{ animationDuration: '.5s', animationDelay: `${-k * 0.15}s`, animationPlayState: paused ? 'paused' : 'running' }}
            />
          ))}
      </svg>
    </Shell>
  )
})

// ---- control blocks ---------------------------------------------------------------

/** Which instrument feeds this controller, and how to show its reading. */
function usePV(id: string) {
  const src = useLab((s) => {
    const w = s.edges.find((e) => e.type === 'signal' && e.target === id && e.sourceHandle === 'pv')
    return w ? s.nodes.find((n) => n.id === w.source) : undefined
  })
  const pv = useLab((s) => s.ctrl.pv[id])
  const info = src ? PV_SOURCES[src.data.kind] : undefined
  return { src, pv, info, quantity: info?.quantity ?? ('none' as const) }
}

export const ManualNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const update = useLab((s) => s.updateNode)
  const on = !!data.props.on
  return (
    <Shell id={id} kind="manual" selected={selected} label={data.label} sub={on ? 'ON' : 'OFF'}>
      <svg width="84" height="84" viewBox="0 0 84 84">
        <rect x="4" y="4" width="76" height="76" rx="14" fill="#0c1424" stroke="#5a7099" strokeWidth="2.5" />
        <circle cx="42" cy="42" r="27" fill="#060b15" stroke="#2a3957" strokeWidth="2" />
        <circle
          cx="42"
          cy="42"
          r="21"
          fill={on ? '#2fc97a' : '#3a2230'}
          stroke={on ? '#a5ffd0' : '#ff5d7a'}
          strokeWidth="2"
          style={{ filter: on ? 'drop-shadow(0 0 8px #3ddc84)' : undefined, transition: 'fill .15s' }}
        />
        <path d="M42,31 V42 M34.5,35.500 A10.500,10.500 0 1 0 49.500,35.500" fill="none" stroke={on ? '#04140a' : '#ff8fa6'} strokeWidth="3" strokeLinecap="round" />
      </svg>
      <button className="node-hit nodrag nopan" aria-label={`Switch ${data.label} ${on ? 'off' : 'on'}`} onClick={() => update(id, { on: !on })} />
    </Shell>
  )
})

export const SwitchNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const out = useLab((s) => s.ctrl.out[id] ?? 0)
  const { src, pv, info, quantity } = usePV(id)
  const p = data.props
  const on = out >= 0.5
  const lo = Math.min(p.low, p.high)
  const hi = Math.max(p.low, p.high)
  // bar scale: a little beyond the band on both sides
  const top = hi + (hi - lo || 1) * 0.5
  const y = (v: number) => 70 - Math.min(1, Math.max(0, v / top)) * 52
  const color = !p.enabled ? '#51617f' : on ? SIGNAL_ON : SIGNAL_OFF
  return (
    <Shell id={id} kind="switch" selected={selected} label={data.label} sub={!src ? 'no measurement' : `${fmt(lo, quantity, units)} – ${fmtU(hi, quantity, units)}`}>
      <svg width="92" height="88" viewBox="0 0 92 88">
        <rect x="4" y="4" width="84" height="80" rx="12" fill="#0c1424" stroke="#5a7099" strokeWidth="2.5" />
        <text x="37" y="24" className="svg-tag big">
          {info ? `${info.tag}S` : 'SW'}
        </text>
        <text x="37" y="50" className="svg-readout small timer-state" style={{ fill: color }}>
          {!p.enabled ? '– –' : on ? 'ON' : 'OFF'}
        </text>
        <text x="37" y="68" className="svg-lcd timer-count">
          {pv !== undefined ? fmt(pv, quantity, units) : '—'}
        </text>
        <rect x="68" y="18" width="10" height="52" rx="3" fill="#060b15" stroke="#22314d" />
        <rect x="68" y={y(hi)} width="10" height={y(lo) - y(hi)} fill="#9085e9" opacity=".28" />
        <path d={`M65,${y(hi)} H81 M65,${y(lo)} H81`} stroke="#b7a9ff" strokeWidth="1.5" />
        {pv !== undefined && <rect x="66" y={y(pv) - 2} width="14" height="4" rx="2" fill="#4fe0b0" style={{ transition: 'y .3s', filter: 'drop-shadow(0 0 3px #4fe0b0)' }} />}
      </svg>
    </Shell>
  )
})

export const PidNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const units = useLab((s) => s.units)
  const out = useLab((s) => s.ctrl.out[id] ?? 0)
  const { src, pv, info, quantity } = usePV(id)
  const p = data.props
  const full = Math.max(p.span, 1e-9)
  const bar = (v: number) => Math.min(1, Math.max(0, v / full)) * 56
  return (
    <Shell id={id} kind="pid" selected={selected} label={data.label} sub={!src ? 'no measurement' : `SP ${fmtU(p.setpoint, quantity, units)} · ${p.auto ? 'AUTO' : 'MAN'}`}>
      <svg width="116" height="104" viewBox="0 0 116 104">
        <rect x="4" y="4" width="108" height="96" rx="12" fill="#0c1424" stroke="#5a7099" strokeWidth="2.5" />
        <text x="20" y="21" className="svg-tag big" style={{ textAnchor: 'start' }}>
          {info ? `${info.tag}IC` : 'PID'}
        </text>
        <rect x="70" y="10" width="34" height="14" rx="4" fill={p.auto && p.enabled ? 'rgba(61,220,132,.16)' : 'rgba(250,178,25,.16)'} />
        <text x="87" y="20.500" className="svg-tag" style={{ fill: p.auto && p.enabled ? '#3ddc84' : '#fab219' }}>
          {!p.enabled ? 'OFF' : p.auto ? 'AUTO' : 'MAN'}
        </text>
        {/* PV bar with the setpoint marker */}
        <rect x="16" y="32" width="14" height="56" rx="3" fill="#060b15" stroke="#22314d" />
        {pv !== undefined && <rect x="17" y={88 - bar(pv)} width="12" height={bar(pv)} rx="2" fill="#4fe0b0" style={{ transition: 'all .3s' }} />}
        <path d={`M12,${88 - bar(p.setpoint)} H34`} stroke="#fff" strokeWidth="2" />
        <path d={`M34,${88 - bar(p.setpoint)} l5,-3.500 v7 z`} fill="#fff" />
        <text x="23" y="98" className="svg-tick">
          PV
        </text>
        {/* output bar */}
        <rect x="86" y="32" width="14" height="56" rx="3" fill="#060b15" stroke="#22314d" />
        <rect x="87" y={88 - out * 56} width="12" height={out * 56} rx="2" fill={SIGNAL_ON} style={{ transition: 'all .3s' }} />
        <text x="93" y="98" className="svg-tick">
          OUT
        </text>
        <text x="60" y="56" className="svg-lcd timer-count">
          {pv !== undefined ? fmt(pv, quantity, units) : '—'}
        </text>
        <text x="60" y="66" className="svg-tick">
          {quantity !== 'none' ? unitLabel(quantity, units) : ''}
        </text>
        <text x="60" y="84" className="svg-readout small" style={{ fill: SIGNAL_ON }}>
          {Math.round(out * 100)}%
        </text>
      </svg>
    </Shell>
  )
})

const GATE: Record<string, { name: string; d: string }> = {
  and: { name: 'AND', d: 'M14,10 H40 A22,22 0 0 1 40,54 H14 Z' },
  or: { name: 'OR', d: 'M12,10 Q40,10 64,32 Q40,54 12,54 Q24,32 12,10 Z' },
  not: { name: 'NOT', d: 'M14,10 L56,32 L14,54 Z' },
}

export const LogicNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const on = useLab((s) => (s.ctrl.out[id] ?? 0) >= 0.5)
  const g = GATE[data.props.op] ?? GATE.and
  const color = on ? SIGNAL_ON : SIGNAL_OFF
  return (
    <Shell id={id} kind="logic" selected={selected} label={data.label} sub={on ? 'ON' : 'OFF'}>
      <svg width="76" height="64" viewBox="0 0 76 64">
        <path d="M0,32 H14 M60,32 H76" stroke={color} strokeWidth="2.5" />
        <path d={g.d} fill="#0c1424" stroke={color} strokeWidth="2.5" strokeLinejoin="round" style={{ filter: on ? `drop-shadow(0 0 5px ${color})` : undefined }} />
        {data.props.op === 'not' && <circle cx="60" cy="32" r="4" fill="#0c1424" stroke={color} strokeWidth="2.5" />}
        <text x={data.props.op === 'not' ? 28 : 36} y="35.500" className="svg-tag">
          {g.name}
        </text>
      </svg>
    </Shell>
  )
})

const LAMP: Record<string, string> = { red: '#ff5d7a', amber: '#fab219', green: '#3ddc84', blue: '#4fd4ff' }

export const LampNode = memo(({ id, data, selected }: NodeProps<LabNode>) => {
  const on = useLab((s) => (s.ctrl.out[id] ?? 0) >= 0.5)
  const c = LAMP[data.props.color] ?? LAMP.red
  return (
    <Shell id={id} kind="lamp" selected={selected} label={data.label}>
      <svg width="60" height="68" viewBox="0 0 60 68" style={{ overflow: 'visible' }}>
        {on && <circle cx="30" cy="28" r="30" fill={c} opacity=".22" className="lamp-halo" />}
        <rect x="14" y="52" width="32" height="12" rx="3" fill="#1b2a44" stroke="#5a7099" strokeWidth="2" />
        <path
          d="M12,52 V28 A18,18 0 0 1 48,28 V52 Z"
          fill={on ? c : '#151d2e'}
          stroke={on ? '#fff' : '#5a7099'}
          strokeWidth="2"
          className={on ? 'lamp-on' : undefined}
          style={{ filter: on ? `drop-shadow(0 0 10px ${c})` : undefined }}
        />
        <path d="M20,30 A10,10 0 0 1 30,18" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" opacity={on ? 0.7 : 0.15} />
      </svg>
    </Shell>
  )
})

export const nodeTypes = {
  reservoir: ReservoirNode,
  tank: TankNode,
  vessel: VesselNode,
  leak: LeakNode,
  junction: JunctionNode,
  outlet: OutletNode,
  gauge: GaugeNode,
  pump: PumpNode,
  valve: ValveNode,
  meter: MeterNode,
  element: ElementNode,
  dpgauge: DpGaugeNode,
  fitting: FittingNode,
  relief: ReliefNode,
  timer: TimerNode,
  manual: ManualNode,
  switch: SwitchNode,
  pid: PidNode,
  logic: LogicNode,
  lamp: LampNode,
}
