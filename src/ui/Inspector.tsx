import { useEffect, useMemo, useState } from 'react'
import { gradeLine, pipeCurve, pumpCurve, type XY } from '../engine/analysis'
import { solver } from '../engine/client'
import { DEMAND_PATTERNS, demandFactor, dischargeDevice, LOSS_DEVICES, PUMP_TYPES, PIPE_STANDARDS, TRIMS, VALVE_BODIES, lossDevice } from '../model/catalog'
import { PV_SOURCES, fmtClock, timerState } from '../model/control'
import { SOURCE_TYPES, TANK_SHAPES, pumpHead, beta, elementLossFraction, tankHeight, tankVolume, vesselPressure, vesselWater } from '../model/physics'
import { ELEMENT_TYPES, FLUIDS, KIND_META, MATERIALS, ROTATABLE, VALVE_TYPES, isControl, type Kind, type Props } from '../model/types'
import { fmt, fmtNum, fmtU, toDisplay, toSI, unitLabel, type Quantity } from '../model/units'
import { model, selectedId, useLab } from '../store'
import { Chart, SERIES, type Marker, type Series } from './Chart'
import { KindIcon } from './icons'

interface Field {
  key: string
  label: string
  /** 'pv' = whatever the wired instrument measures (level, pressure, flow…) */
  q: Quantity | 'pv'
  type?: 'number' | 'slider' | 'toggle' | 'select'
  options?: { id: string; name: string }[]
  max?: number
  show?: (p: Props) => boolean
  hint?: string
}

const elevation: Field = { key: 'elevation', label: 'Elevation', q: 'length' }
const FIELDS: Record<Kind | 'pipe', Field[]> = {
  reservoir: [
    { key: 'sourceType', label: 'Source', q: 'none', type: 'select', options: SOURCE_TYPES },
    { key: 'head', label: 'Water surface head', q: 'head', show: (p) => (p.sourceType ?? 'surface') === 'surface' },
    { key: 'pressure', label: 'Mains pressure', q: 'pressure', show: (p) => p.sourceType === 'mains' },
    { key: 'elevation', label: 'Elevation of the connection', q: 'length', show: (p) => p.sourceType === 'mains' },
    { key: 'staticLevel', label: 'Static water level', q: 'head', show: (p) => p.sourceType === 'well' },
    { key: 'ratedDrawdown', label: 'Drawdown', q: 'head', show: (p) => p.sourceType === 'well' },
    { key: 'ratedYield', label: '… when yielding', q: 'flow', show: (p) => p.sourceType === 'well' },
  ],
  tank: [
    { key: 'shape', label: 'Shape', q: 'none', type: 'select', options: TANK_SHAPES },
    { key: 'overflow', label: 'Overflow at the rim', q: 'none', type: 'toggle' },
    { key: 'diameter', label: 'Diameter', q: 'length' },
    { key: 'length', label: 'Drum length', q: 'length', show: (p) => p.shape === 'drum' },
    { key: 'initLevel', label: 'Initial level', q: 'length' },
    { key: 'maxLevel', label: 'Maximum level', q: 'length' },
    { key: 'minLevel', label: 'Minimum level', q: 'length' },
    { ...elevation, label: 'Base elevation' },
  ],
  junction: [elevation, { key: 'demand', label: 'Base demand (draw-off)', q: 'flow' }, { key: 'pattern', label: 'Daily pattern', q: 'none', type: 'select', options: DEMAND_PATTERNS }],
  vessel: [
    { key: 'volume', label: 'Total volume', q: 'volume' },
    { key: 'precharge', label: 'Gas pre-charge', q: 'pressure' },
    { key: 'initPressure', label: 'Starting pressure', q: 'pressure' },
    { key: 'polytropic', label: 'Polytropic index n', q: 'none' },
    elevation,
  ],
  leak: [
    { key: 'active', label: 'Leaking now', q: 'none', type: 'toggle' },
    { key: 'holeDiameter', label: 'Equivalent hole', q: 'diameter' },
    { key: 'cd', label: 'Discharge coeff. Cd', q: 'none' },
    elevation,
  ],
  gauge: [elevation],
  outlet: [
    {
      key: 'mode',
      label: 'Behaviour',
      q: 'none',
      type: 'select',
      options: [
        { id: 'nozzle', name: 'Open nozzle (pressure-driven)' },
        { id: 'kfactor', name: 'K-factor device (Q = K·√p)' },
        { id: 'demand', name: 'Fixed demand' },
      ],
    },
    { key: 'fused', label: 'Bulb broken (head open)', q: 'none', type: 'toggle', show: (p) => dischargeDevice(p.variant)?.glyph === 'sprinkler' },
    { key: 'kFactor', label: 'K-factor', q: 'kfactor', show: (p) => p.mode === 'kfactor' },
    { key: 'nozzleDiameter', label: 'Nozzle bore', q: 'diameter', show: (p) => p.mode === 'nozzle' },
    { key: 'cd', label: 'Discharge coeff. Cd', q: 'none', show: (p) => p.mode === 'nozzle' },
    { key: 'demand', label: 'Base demand', q: 'flow', show: (p) => p.mode === 'demand' },
    { key: 'pattern', label: 'Daily pattern', q: 'none', type: 'select', options: DEMAND_PATTERNS, show: (p) => p.mode === 'demand' },
    elevation,
  ],
  pump: [
    { key: 'on', label: 'Power', q: 'none', type: 'toggle' },
    { key: 'speed', label: 'Speed (VFD)', q: 'percent', type: 'slider', max: 1.5 },
    { key: 'pumpType', label: 'Curve shape', q: 'none', type: 'select', options: PUMP_TYPES },
    { key: 'designFlow', label: 'Design flow', q: 'flow' },
    { key: 'designHead', label: 'Design head', q: 'head' },
    { key: 'bepEfficiency', label: 'Best efficiency', q: 'percent' },
    { key: 'npshr', label: 'NPSH required', q: 'head' },
    elevation,
  ],
  valve: [
    { key: 'valveType', label: 'Type', q: 'none', type: 'select', options: VALVE_TYPES },
    { key: 'body', label: 'Body', q: 'none', type: 'select', options: VALVE_BODIES, show: (p) => p.valveType === 'throttle' },
    { key: 'trim', label: 'Characteristic', q: 'none', type: 'select', options: TRIMS, show: (p) => p.valveType === 'throttle' },
    { key: 'opening', label: 'Opening', q: 'percent', type: 'slider', max: 1, show: (p) => p.valveType === 'throttle' || p.valveType === 'float' },
    {
      key: 'floatMode',
      label: 'Action',
      q: 'none',
      type: 'select',
      show: (p) => p.valveType === 'float',
      options: [
        { id: 'modulating', name: 'Float valve — closes gradually' },
        { id: 'altitude', name: 'Altitude valve — shut / open' },
      ],
    },
    { key: 'closeLevel', label: 'Shuts at tank level', q: 'length', show: (p) => p.valveType === 'float' },
    { key: 'band', label: 'Fully open this far below', q: 'length', show: (p) => p.valveType === 'float' },
    { key: 'pressureSetting', label: 'Pressure setpoint', q: 'pressure', show: (p) => p.valveType === 'prv' || p.valveType === 'psv' },
    { key: 'flowSetting', label: 'Flow setpoint', q: 'flow', show: (p) => p.valveType === 'fcv' },
    { key: 'diameter', label: 'Bore', q: 'diameter' },
    { key: 'kOpen', label: 'K when fully open', q: 'none' },
    { key: 'strokeTime', label: 'Actuator stroke time (s)', q: 'none', show: (p) => p.valveType === 'throttle' },
    elevation,
  ],
  meter: [{ key: 'diameter', label: 'Bore', q: 'diameter' }, elevation],
  element: [
    { key: 'elementType', label: 'Type', q: 'none', type: 'select', options: ELEMENT_TYPES },
    { key: 'diameter', label: 'Pipe bore D', q: 'diameter' },
    { key: 'throat', label: 'Throat / orifice d', q: 'diameter' },
    { key: 'cd', label: 'Discharge coeff. Cd', q: 'none' },
    elevation,
  ],
  dpgauge: [elevation],
  fitting: [
    { key: 'variant', label: 'Catalogue part', q: 'none', type: 'select', options: LOSS_DEVICES },
    { key: 'diameter', label: 'Bore', q: 'diameter' },
    { key: 'd2', label: 'Second bore', q: 'diameter', show: (p) => !!lossDevice(p.variant).byDiameters },
    { key: 'k', label: 'Loss coefficient K', q: 'none', show: (p) => lossDevice(p.variant).model === 'k' && !lossDevice(p.variant).byDiameters },
    { key: 'ratedDp', label: 'Rated pressure drop', q: 'pressure', show: (p) => lossDevice(p.variant).model === 'rated' },
    { key: 'ratedFlow', label: '… at a flow of', q: 'flow', show: (p) => lossDevice(p.variant).model === 'rated' },
    { key: 'exponent', label: 'Exponent n (2 = turbulent)', q: 'none', show: (p) => lossDevice(p.variant).model === 'rated' },
    { key: 'fouling', label: 'Fouling', q: 'percent', type: 'slider', max: 0.95, show: (p) => !!lossDevice(p.variant).fouls },
    elevation,
  ],
  relief: [{ key: 'setPressure', label: 'Set pressure', q: 'pressure' }, { key: 'diameter', label: 'Orifice bore', q: 'diameter' }, elevation],
  timer: [
    { key: 'enabled', label: 'Enabled', q: 'none', type: 'toggle' },
    {
      key: 'mode',
      label: 'Mode',
      q: 'none',
      type: 'select',
      options: [
        { id: 'cycle', name: 'Repeating cycle' },
        { id: 'once', name: 'One-shot after a delay' },
      ],
    },
    { key: 'onTime', label: 'On for', q: 'time', show: (p) => p.mode === 'cycle' },
    { key: 'offTime', label: 'Off for', q: 'time', show: (p) => p.mode === 'cycle' },
    { key: 'startOn', label: 'Cycle starts', q: 'none', type: 'toggle', show: (p) => p.mode === 'cycle' },
    { key: 'delay', label: 'Delay', q: 'time', show: (p) => p.mode === 'once' },
    {
      key: 'action',
      label: 'Then switch',
      q: 'none',
      type: 'select',
      show: (p) => p.mode === 'once',
      options: [
        { id: 'on', name: 'ON  (off until then)' },
        { id: 'off', name: 'OFF  (on until then)' },
      ],
    },
  ],
  manual: [{ key: 'on', label: 'Switch', q: 'none', type: 'toggle' }],
  switch: [
    { key: 'enabled', label: 'Enabled', q: 'none', type: 'toggle' },
    {
      key: 'action',
      label: 'Contact closes',
      q: 'none',
      type: 'select',
      options: [
        { id: 'fill', name: 'when low — opens when high' },
        { id: 'drain', name: 'when high — opens when low' },
      ],
    },
    { key: 'low', label: 'Low threshold', q: 'pv' },
    { key: 'high', label: 'High threshold', q: 'pv' },
  ],
  pid: [
    { key: 'enabled', label: 'Enabled', q: 'none', type: 'toggle' },
    { key: 'auto', label: 'Automatic', q: 'none', type: 'toggle' },
    { key: 'manualOut', label: 'Manual output', q: 'percent', type: 'slider', max: 1, show: (p) => !p.auto },
    { key: 'setpoint', label: 'Setpoint', q: 'pv' },
    { key: 'kp', label: 'Gain Kp', q: 'none' },
    { key: 'ti', label: 'Integral time Ti (s)', q: 'none' },
    { key: 'td', label: 'Derivative time Td (s)', q: 'none' },
    {
      key: 'reverse',
      label: 'Output rises when PV is',
      q: 'none',
      type: 'select',
      options: [
        { id: 'false', name: 'below setpoint (fill, pressurise)' },
        { id: 'true', name: 'above setpoint (drain, relieve)' },
      ],
    },
    { key: 'span', label: 'Measurement span (100 %)', q: 'pv' },
  ],
  logic: [
    {
      key: 'op',
      label: 'Function',
      q: 'none',
      type: 'select',
      options: [
        { id: 'and', name: 'AND — all inputs on' },
        { id: 'or', name: 'OR — any input on' },
        { id: 'not', name: 'NOT — no input on' },
      ],
    },
  ],
  lamp: [
    {
      key: 'color',
      label: 'Colour',
      q: 'none',
      type: 'select',
      options: [
        { id: 'red', name: 'Red' },
        { id: 'amber', name: 'Amber' },
        { id: 'green', name: 'Green' },
        { id: 'blue', name: 'Blue' },
      ],
    },
  ],
  pipe: [
    { key: 'length', label: 'Length', q: 'length' },
    { key: 'diameter', label: 'Inside diameter', q: 'diameter' },
    { key: 'material', label: 'Material', q: 'none', type: 'select', options: MATERIALS },
    { key: 'roughness', label: 'Absolute roughness', q: 'roughness' },
    { key: 'minorK', label: 'Minor-loss K (fittings)', q: 'none' },
  ],
}

function NumberField({ value, q, onCommit }: { value: number; q: Quantity; onCommit: (si: number) => void }) {
  const units = useLab((s) => s.units)
  const shown = String(Number(toDisplay(value, q, units).toPrecision(5)))
  const [text, setText] = useState(shown)
  const [focus, setFocus] = useState(false)
  useEffect(() => {
    if (!focus) setText(shown)
  }, [shown, focus])
  return (
    <label className="num">
      <input
        value={text}
        inputMode="decimal"
        onFocus={(e) => {
          setFocus(true)
          e.target.select()
        }}
        onBlur={() => setFocus(false)}
        onChange={(e) => {
          setText(e.target.value)
          const v = parseFloat(e.target.value)
          if (isFinite(v)) onCommit(toSI(v, q, units))
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          e.preventDefault()
          const v = parseFloat(text)
          if (!isFinite(v)) return
          const step = Math.pow(10, Math.floor(Math.log10(Math.abs(v) || 1)) - 1) * (e.shiftKey ? 10 : 1)
          const next = Number((v + (e.key === 'ArrowUp' ? step : -step)).toPrecision(6))
          setText(String(next))
          onCommit(toSI(next, q, units))
        }}
      />
      <span>{unitLabel(q, units)}</span>
    </label>
  )
}

function FieldRow({ f, props, pvq, onChange }: { f: Field; props: Props; pvq: Quantity; onChange: (patch: Props) => void }) {
  const v = props[f.key]
  if (f.type === 'toggle')
    return (
      <div className="field">
        <span>{f.label}</span>
        <button className={`toggle ${v ? 'on' : ''}`} onClick={() => onChange({ [f.key]: !v })}>
          <i />
          {v ? 'ON' : 'OFF'}
        </button>
      </div>
    )
  if (f.type === 'select')
    return (
      <div className="field">
        <span>{f.label}</span>
        <select
          value={String(v)}
          onChange={(e) => {
            const raw = e.target.value
            const patch: Props = { [f.key]: raw === 'true' ? true : raw === 'false' ? false : raw }
            if (f.key === 'pumpType') Object.assign(patch, (({ shutoffRatio, runoutRatio }) => ({ shutoffRatio, runoutRatio }))(PUMP_TYPES.find((t) => t.id === raw)!))
            if (f.key === 'body') Object.assign(patch, (({ kOpen, trim }) => ({ kOpen, trim }))(VALVE_BODIES.find((b) => b.id === raw)!))
            if (f.key === 'variant') Object.assign(patch, lossDevice(raw).defaults) // a different part brings its own datasheet numbers
            if (f.key === 'elementType') patch.cd = e.target.value === 'orifice' ? 0.61 : 0.98
            if (f.key === 'material' && e.target.value !== 'custom') patch.roughness = MATERIALS.find((m) => m.id === e.target.value)!.roughness
            onChange(patch)
          }}
        >
          {f.options!.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
    )
  if (f.type === 'slider')
    return (
      <div className="field field-slider">
        <span>{f.label}</span>
        <b>{Math.round(v * 100)} %</b>
        <input
          type="range"
          min={0}
          max={(f.max ?? 1) * 100}
          value={Math.round(v * 100)}
          style={{ '--fill': `${(v / (f.max ?? 1)) * 100}%` } as React.CSSProperties}
          onChange={(e) => onChange({ [f.key]: Number(e.target.value) / 100 })}
        />
      </div>
    )
  return (
    <div className="field">
      <span>{f.label}</span>
      <NumberField
        value={v}
        q={f.q === 'pv' ? pvq : f.q}
        onCommit={(si) => {
          const patch: Props = { [f.key]: si }
          if (f.key === 'roughness') patch.material = 'custom'
          if (f.key === 'diameter' && props.std) patch.std = '' // a typed bore is no longer a catalogue size
          onChange(patch)
        }}
      />
    </div>
  )
}

/** Pick a real pipe: standard + nominal size set the bore, material and roughness together. */
function PipeSizePicker({ props, onChange }: { props: Props; onChange: (patch: Props) => void }) {
  const std = PIPE_STANDARDS.find((x) => x.id === props.std)
  const apply = (stdId: string, label?: string) => {
    const next = PIPE_STANDARDS.find((x) => x.id === stdId)
    if (!next) return onChange({ std: '', size: '' })
    // keep the nearest bore when only the standard changes
    const size = next.sizes.find((z) => z.label === label) ?? next.sizes.reduce((best, z) => (Math.abs(z.id / 1000 - props.diameter) < Math.abs(best.id / 1000 - props.diameter) ? z : best))
    onChange({ std: next.id, size: size.label, diameter: size.id / 1000, material: next.material, roughness: MATERIALS.find((m) => m.id === next.material)!.roughness })
  }
  return (
    <>
      <div className="field">
        <span>Pipe standard</span>
        <select value={std?.id ?? ''} onChange={(e) => apply(e.target.value)}>
          <option value="">Custom bore</option>
          {PIPE_STANDARDS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </div>
      {std && (
        <div className="field">
          <span>Nominal size</span>
          <select value={props.size ?? ''} onChange={(e) => apply(std.id, e.target.value)}>
            {std.sizes.map((z) => (
              <option key={z.label} value={z.label}>
                {z.label} · {z.id} mm
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`row ${tone ?? ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

// ---- charts -------------------------------------------------------------------

function PumpChart({ id }: { id: string }) {
  const s = useLab()
  const node = s.nodes.find((n) => n.id === id)!
  const d = s.results.devices[id]
  const [system, setSystem] = useState<XY[]>([])
  useEffect(() => {
    let stale = false
    // traced in the solver worker; null means a newer request superseded this one
    if (s.engineReady) solver.systemCurve(model(s), id).then((pts) => !stale && pts && setSystem(pts))
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.results, id])
  const p = node.data.props
  const speed = p.speed * (s.controls[id] ?? 1) // what the drive is actually doing, controller included
  const cv = (pts: { x: number; y: number }[]) => pts.map((pt) => ({ x: toDisplay(pt.x, 'flow', s.units), y: toDisplay(pt.y, 'head', s.units) }))
  const series: Series[] = [{ name: `Pump @ ${Math.round(speed * 100)} %`, color: SERIES.blue, points: cv(pumpCurve(p, Math.max(0.05, speed))), area: true }]
  if (Math.abs(speed - 1) > 0.01) series.push({ name: 'Pump @ 100 %', color: SERIES.blue, points: cv(pumpCurve(p, 1)), dashed: true })
  if (system.length > 1) series.push({ name: 'System', color: SERIES.orange, points: cv(system) })
  const markers: Marker[] =
    d && p.on && d.flow > 1e-8
      ? cv([{ x: d.flow, y: d.dH }]).map((pt) => ({ ...pt, label: `${fmtNum(pt.x)} ${unitLabel('flow', s.units)} @ ${fmtNum(pt.y)} ${unitLabel('head', s.units)}`, color: '#ffffff' }))
      : []
  return <Chart series={series} markers={markers} xLabel={`Flow (${unitLabel('flow', s.units)})`} yLabel={`Head (${unitLabel('head', s.units)})`} />
}

function PipeChart({ id }: { id: string }) {
  const s = useLab()
  const e = s.edges.find((x) => x.id === id)!
  const r = s.results.links[id]
  const fluid = FLUIDS.find((f) => f.id === s.fluidId) ?? FLUIDS[0]
  const q = Math.abs(r?.flow ?? 0)
  const pts = useMemo(() => pipeCurve(e.data!.props, fluid, q), [e.data, fluid, q])
  const cv = (pt: { x: number; y: number }) => ({ x: toDisplay(pt.x, 'flow', s.units), y: toDisplay(pt.y, 'pressure', s.units) })
  const now = pts.length && r ? cv({ x: q, y: pts.reduce((best, pt) => (Math.abs(pt.x - q) < Math.abs(best.x - q) ? pt : best)).y }) : null
  return (
    <Chart
      series={[{ name: 'Friction loss', color: SERIES.blue, points: pts.map(cv), area: true }]}
      markers={now && q > 1e-8 ? [{ ...now, label: `${fmtNum(now.y)} ${unitLabel('pressure', s.units)}`, color: '#ffffff' }] : []}
      xLabel={`Flow (${unitLabel('flow', s.units)})`}
      yLabel={`ΔP (${unitLabel('pressure', s.units)})`}
    />
  )
}

function trendQuantity(kind: Kind | 'pipe'): [Quantity, string] {
  if (kind !== 'pipe' && isControl(kind)) return ['none', 'Output']
  if (kind === 'tank') return ['length', 'Level']
  if (kind === 'junction' || kind === 'gauge' || kind === 'vessel') return ['pressure', 'Pressure']
  if (kind === 'dpgauge' || kind === 'element') return ['pressure', 'Differential']
  return ['flow', 'Flow']
}

function TrendChart({ id, kind }: { id: string; kind: Kind | 'pipe' }) {
  const history = useLab((s) => s.history)
  const units = useLab((s) => s.units)
  const [q, name] = trendQuantity(kind)
  const pts = history.filter((h) => h.v[id] !== undefined).map((h) => ({ x: h.t / 60, y: toDisplay(Math.abs(h.v[id]), q, units) }))
  return <Chart series={[{ name, color: SERIES.aqua, points: pts, area: true }]} xLabel="Lab time (min)" yLabel={`${name} (${unitLabel(q, units)})`} empty="Press play to record a trend" />
}

/** The timer's output drawn ahead of the lab clock, with a marker at "now". */
function ScheduleChart({ id }: { id: string }) {
  const t = useLab((s) => s.simTime)
  const node = useLab((s) => s.nodes.find((n) => n.id === id))
  const units = useLab((s) => s.units)
  const p = node?.data.props
  // quantise the window so the curve isn't rebuilt on every clock tick
  const span = p ? (p.mode === 'once' ? Math.max(60, p.delay * 2) : Math.max(60, (p.onTime + p.offTime) * 2.5)) : 60
  const from = Math.floor(t / span) * span
  const points = useMemo(() => {
    if (!p) return []
    const pts: { x: number; y: number }[] = []
    let cur = from
    // walk from switch to switch rather than sampling, so edges land exactly
    for (let i = 0; i < 400 && cur <= from + span; i++) {
      const st = timerState(p, cur)
      pts.push({ x: toDisplay(cur, 'time', units), y: st.on ? 1 : 0 })
      if (st.next === null) break
      cur += Math.max(st.next, 1e-6)
    }
    pts.push({ x: toDisplay(from + span, 'time', units), y: timerState(p, from + span - 1e-6).on ? 1 : 0 })
    return pts
  }, [p, from, span, units])
  if (!p) return null
  return (
    <Chart
      series={[{ name: 'Output', color: '#9085e9', points, step: true, area: true }]}
      markers={[{ x: toDisplay(t, 'time', units), y: timerState(p, t).on ? 1 : 0, label: 'now', color: '#ffffff' }]}
      xLabel={`Lab time (${unitLabel('time', units)})`}
      yLabel="Output (0 = off · 1 = on)"
      height={150}
    />
  )
}

function TimerResults({ id }: { id: string }) {
  const s = useLab()
  const node = s.nodes.find((n) => n.id === id)!
  const st = timerState(node.data.props, s.simTime)
  const targets = s.edges.filter((e) => e.type === 'signal' && e.source === id).map((e) => s.nodes.find((n) => n.id === e.target)?.data.label ?? '?')
  const live = node.data.props.enabled
  return (
    <>
      <div className="hero">
        <div>
          <b>{!live ? '—' : st.on ? 'ON' : 'OFF'}</b>
          <span>output</span>
        </div>
        <div>
          <b>{live && st.next !== null ? fmtClock(st.next) : '∞'}</b>
          <span>until it switches</span>
        </div>
        <div>
          <b>{fmtClock(s.simTime)}</b>
          <span>lab clock</span>
        </div>
      </div>
      <Row label="Switching" value={targets.length ? targets.join(', ') : 'nothing yet'} tone={targets.length ? undefined : 'warn'} />
      {!targets.length && <p className="muted">Pull a wire from the timer’s violet port to the violet port on a pump, valve or outlet.</p>}
      {!s.running && <p className="muted">The lab clock is paused — press play for the timer to advance.</p>}
    </>
  )
}

/** Shared by every control block: what it reads, what it says, what it drives. */
function useWiring(id: string) {
  const s = useLab()
  const label = (nid: string) => s.nodes.find((n) => n.id === nid)?.data.label ?? '?'
  const wires = s.edges.filter((e) => e.type === 'signal')
  const pvWire = wires.find((e) => e.target === id && e.sourceHandle === 'pv')
  const src = pvWire ? s.nodes.find((n) => n.id === pvWire.source) : undefined
  return {
    s,
    src,
    info: src ? PV_SOURCES[src.data.kind] : undefined,
    inputs: wires.filter((e) => e.target === id && e.sourceHandle === 'sig').map((e) => label(e.source)),
    targets: wires.filter((e) => e.source === id).map((e) => label(e.target)),
  }
}

function ControlResults({ id, kind }: { id: string; kind: Kind }) {
  const { s, src, info, inputs, targets } = useWiring(id)
  const u = s.units
  const out = s.ctrl.out[id] ?? 0
  const pv = s.ctrl.pv[id]
  const node = s.nodes.find((n) => n.id === id)!
  const q = info?.quantity ?? 'none'
  const reads = kind === 'switch' || kind === 'pid'
  return (
    <>
      <div className="hero">
        {reads && (
          <div>
            <b>{pv !== undefined ? fmt(pv, q, u) : '—'}</b>
            <span>{info ? `${info.name} ${unitLabel(q, u)}` : 'measurement'}</span>
          </div>
        )}
        {kind === 'pid' && (
          <div>
            <b>{fmt(node.data.props.setpoint, q, u)}</b>
            <span>setpoint {unitLabel(q, u)}</span>
          </div>
        )}
        <div>
          <b>{kind === 'pid' ? `${Math.round(out * 100)} %` : out >= 0.5 ? 'ON' : 'OFF'}</b>
          <span>output</span>
        </div>
      </div>
      {reads && <Row label="Measuring" value={src ? `${src.data.label} · ${info!.name.toLowerCase()}` : 'nothing yet'} tone={src ? undefined : 'warn'} />}
      {(kind === 'logic' || kind === 'lamp') && <Row label="Inputs" value={inputs.length ? inputs.join(', ') : 'nothing yet'} tone={inputs.length ? undefined : 'warn'} />}
      {kind !== 'lamp' && <Row label="Driving" value={targets.length ? targets.join(', ') : 'nothing yet'} tone={targets.length ? undefined : 'warn'} />}
      {reads && !src && <p className="muted">Pull a wire from the green port on a tank, pressure gauge, flow meter or ΔP gauge to this block’s green input.</p>}
      {kind !== 'lamp' && !targets.length && <p className="muted">Pull a wire from the violet output to the violet port on a pump, valve or outlet — or into a logic gate or lamp.</p>}
      {kind === 'pid' && <p className="muted">The output scales the device’s own setting: a valve opens to output × its opening, a pump runs at output × its speed.</p>}
      {reads && !s.running && <p className="muted">The lab clock is paused — controllers only act while it runs.</p>}
    </>
  )
}

/** PV against setpoint (or switch thresholds), and the output below it — two charts, never a dual axis. */
function LoopCharts({ id, kind }: { id: string; kind: Kind }) {
  const { s, info } = useWiring(id)
  const node = s.nodes.find((n) => n.id === id)!
  const q = info?.quantity ?? 'none'
  const pts = (key: string, f: (v: number) => number) => s.history.filter((h) => h.v[key] !== undefined).map((h) => ({ x: h.t / 60, y: f(h.v[key]) }))
  const pv = pts(`${id}:pv`, (v) => toDisplay(v, q, s.units))
  const flat = (v: number) => (pv.length ? [pv[0], pv[pv.length - 1]].map((p) => ({ x: p.x, y: toDisplay(v, q, s.units) })) : [])
  const p = node.data.props
  const refs: Series[] =
    kind === 'pid'
      ? [{ name: 'Setpoint', color: SERIES.orange, points: flat(p.setpoint), dashed: true }]
      : [
          { name: 'High', color: SERIES.orange, points: flat(Math.max(p.low, p.high)), dashed: true },
          { name: 'Low', color: SERIES.aqua, points: flat(Math.min(p.low, p.high)), dashed: true },
        ]
  return (
    <>
      <Chart
        series={[{ name: info?.name ?? 'Measurement', color: SERIES.blue, points: pv }, ...refs]}
        xLabel="Lab time (min)"
        yLabel={`${info?.name ?? 'PV'} (${unitLabel(q, s.units)})`}
        height={170}
        yMinZero={false}
        empty="Wire a measurement and press play"
      />
      <Chart series={[{ name: 'Output', color: '#9085e9', points: pts(id, (v) => v * 100), area: true, step: kind !== 'pid' }]} xLabel="Lab time (min)" yLabel="Output (%)" height={120} empty=" " />
    </>
  )
}

/** A node's demand over the day, with the lab clock marked on it. */
function PatternChart({ pattern, base }: { pattern: string; base: number }) {
  const t = useLab((s) => s.simTime)
  const units = useLab((s) => s.units)
  const points = useMemo(() => Array.from({ length: 97 }, (_, i) => ({ x: i / 4, y: toDisplay(base * demandFactor(pattern, i * 900), 'flow', units) })), [pattern, base, units])
  const hour = (((t / 3600) % 24) + 24) % 24
  return (
    <Chart
      series={[{ name: 'Demand', color: SERIES.blue, points, area: true }]}
      markers={[
        {
          x: hour,
          y: toDisplay(base * demandFactor(pattern, t), 'flow', units),
          label: `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`,
          color: '#ffffff',
        },
      ]}
      xLabel="Time of day (h)"
      yLabel={`Demand (${unitLabel('flow', units)})`}
      height={160}
    />
  )
}

/** Water-hammer test on the selected valve, pump or outlet: operate it, watch the pressure wave. */
function SurgePanel({ id, kind }: { id: string; kind: Kind }) {
  const s = useLab()
  const [stroke, setStroke] = useState(0.5)
  const [to, setTo] = useState(0)
  const [inertia, setInertia] = useState(1)
  const [runFor, setRunFor] = useState(10)
  const [where, setWhere] = useState('')
  const r = s.surge?.event.id === id ? s.surge : null
  const u = s.units

  const bursts = kind === 'outlet' || kind === 'leak'
  const open = bursts ? (s.results.nodes[id]?.outflow ?? 0) > 1e-8 : true
  const run = () => s.runSurge({ id, start: 0.5, duration: kind === 'pump' ? 0 : stroke, to: bursts ? (open ? 0 : 1) : to, inertia, runFor })

  // where to look: the operated part first, then every instrumented point
  const places = useMemo(() => {
    const label = (nid: string) => s.nodes.find((n) => n.id === nid)?.data.label ?? nid
    const keys = Object.keys(r?.series ?? {})
    const named = keys.map((k) => ({ key: k, name: k.includes(':') ? `${label(k.split(':')[0])} · ${k.endsWith(':in') ? 'inlet' : 'outlet'}` : label(k) }))
    const mine = bursts ? id : `${id}:${kind === 'pump' ? 'out' : 'in'}`
    return named.sort((a, b) => Number(b.key === mine) - Number(a.key === mine))
  }, [r, s.nodes, id, kind])
  const at = places.find((p) => p.key === where)?.key ?? places[0]?.key
  const replaying = s.surgeFrame >= 0

  return (
    <>
      {kind === 'valve' && (
        <>
          <div className="field field-slider">
            <span>Stroke to</span>
            <b>{Math.round(to * 100)} %</b>
            <input type="range" min={0} max={100} value={Math.round(to * 100)} style={{ '--fill': `${to * 100}%` } as React.CSSProperties} onChange={(e) => setTo(Number(e.target.value) / 100)} />
          </div>
          <div className="field">
            <span>Stroke time (s)</span>
            <NumberField value={stroke} q="none" onCommit={(v) => setStroke(Math.max(0, v))} />
          </div>
        </>
      )}
      {kind === 'pump' && (
        <div className="field">
          <span>Rotor coast-down: speed halves in (s)</span>
          <NumberField value={inertia} q="none" onCommit={(v) => setInertia(Math.max(0.05, v))} />
        </div>
      )}
      {bursts && (
        <div className="field">
          <span>{kind === 'leak' ? (open ? 'Seal it' : 'Rupture') : open ? 'Shut it' : 'Open it'} in (s)</span>
          <NumberField value={stroke} q="none" onCommit={(v) => setStroke(Math.max(0, v))} />
        </div>
      )}
      <div className="field">
        <span>Simulate for (s)</span>
        <NumberField value={runFor} q="none" onCommit={(v) => setRunFor(Math.min(120, Math.max(1, v)))} />
      </div>
      <div className="surge-actions">
        <button className="btn primary" disabled={s.surgeBusy || !s.results.ok} onClick={run}>
          {s.surgeBusy
            ? 'Solving…'
            : kind === 'pump'
              ? '⚡ Trip the pump'
              : kind === 'leak'
                ? `⚡ ${open ? 'Seal' : 'Rupture'} it`
                : kind === 'outlet'
                  ? `⚡ ${open ? 'Shut' : 'Open'} it`
                  : '⚡ Stroke the valve'}
        </button>
        {r?.ok && (
          <button className="btn" onClick={replaying ? s.stopSurge : s.replaySurge}>
            {replaying ? `■ Stop · ${r.frames[Math.min(s.surgeFrame, r.frames.length - 1)]?.t.toFixed(2)} s` : '▶ Replay on the bench'}
          </button>
        )}
      </div>
      {r && !r.ok && <p className="muted">{r.error}</p>}
      {r?.ok && at && (
        <>
          <div className="hero">
            <div>
              <b>{fmt(r.peak.pressure, 'pressure', u)}</b>
              <span>peak {unitLabel('pressure', u)}</span>
            </div>
            <div>
              <b>{fmt(r.trough.pressure, 'pressure', u)}</b>
              <span>lowest {unitLabel('pressure', u)}</span>
            </div>
            <div>
              <b>{fmt(r.joukowsky, 'pressure', u)}</b>
              <span>Joukowsky Δp</span>
            </div>
          </div>
          <Row label="Peak occurs at" value={places.find((p) => p.key === r.peak.key)?.name ?? '—'} />
          <Row label="Wave speed a" value={`${r.waveSpeed.toFixed(0)} m/s`} />
          <Row label="Critical time 2L/a" value={`${r.criticalTime.toFixed(2)} s`} tone={kind === 'valve' && stroke < r.criticalTime ? 'warn' : 'good'} />
          {r.cavitated && <Row label="Column separation" value="pressure hit vapour pressure" tone="bad" />}
          <div className="field">
            <span>Pressure at</span>
            <select value={at} onChange={(e) => setWhere(e.target.value)}>
              {places.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <Chart
            series={[{ name: 'Pressure', color: SERIES.blue, points: r.times.map((t, i) => ({ x: t, y: toDisplay(r.series[at][i], 'pressure', u) })), area: true }]}
            xLabel="Time (s)"
            yLabel={`Pressure (${unitLabel('pressure', u)})`}
            height={180}
            yMinZero={false}
          />
          <Chart
            series={[{ name: 'Flow', color: SERIES.aqua, points: r.times.map((t, i) => ({ x: t, y: toDisplay(r.eventFlow[i], 'flow', u) })), area: true }]}
            xLabel="Time (s)"
            yLabel={`Flow (${unitLabel('flow', u)})`}
            height={110}
          />
          <p className="muted">
            Method of characteristics · {r.reaches} reaches · Δt {(r.dt * 1000).toFixed(2)} ms · solved in {r.solveMs.toFixed(0)} ms
          </p>
        </>
      )}
      {!r && (
        <p className="muted">
          Operates this component on the network as it stands and follows the pressure wave it sends out. {kind === 'valve' ? 'Close faster than 2L/a and you get the full Joukowsky surge.' : ''}
        </p>
      )}
    </>
  )
}

function GradeChart({ id }: { id?: string }) {
  const s = useLab()
  const pts = useMemo(() => gradeLine(model(s), s.results, id), [s.results, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const cv = (key: 'head' | 'elevation') => pts.map((p) => ({ x: toDisplay(p.dist, 'length', s.units), y: toDisplay(p[key], 'head', s.units) }))
  return (
    <Chart
      series={[
        { name: 'Hydraulic grade', color: SERIES.blue, points: cv('head') },
        { name: 'Pipe elevation', color: SERIES.orange, points: cv('elevation'), area: true },
      ]}
      yMinZero={false}
      xLabel={`Distance along main path (${unitLabel('length', s.units)})`}
      yLabel={`Head (${unitLabel('head', s.units)})`}
      empty="No flowing path from a source yet"
    />
  )
}

// ---- panels -------------------------------------------------------------------

function Results({ id, kind }: { id: string; kind: Kind | 'pipe' }) {
  const s = useLab()
  const u = s.units
  const n = s.results.nodes[id]
  const d = s.results.devices[id]
  const l = s.results.links[id]
  const node = s.nodes.find((x) => x.id === id)
  if (!s.results.ok || (!n && !d && !l)) return <p className="muted">No results — this part is not connected to a solved network.</p>
  if (l)
    return (
      <>
        <div className="hero">
          <div>
            <b>{fmt(Math.abs(l.flow), 'flow', u)}</b>
            <span>{unitLabel('flow', u)}</span>
          </div>
          <div>
            <b>{fmt(l.velocity, 'velocity', u)}</b>
            <span>{unitLabel('velocity', u)}</span>
          </div>
          <div>
            <b>{fmt(l.dp, 'pressure', u)}</b>
            <span>ΔP {unitLabel('pressure', u)}</span>
          </div>
        </div>
        <Row label="Reynolds number" value={Math.round(l.re).toLocaleString('en-US')} />
        <Row label="Flow regime" value={l.regime} tone={l.regime === 'laminar' ? 'good' : l.regime === 'transitional' ? 'warn' : undefined} />
        <Row label="Friction factor f" value={l.f.toFixed(4)} />
        <Row label="Head loss" value={fmtU(l.headloss, 'head', u)} />
        <Row label="Pressure in → out" value={`${fmt(l.flow >= 0 ? l.pStart : l.pEnd, 'pressure', u)} → ${fmtU(l.flow >= 0 ? l.pEnd : l.pStart, 'pressure', u)}`} />
      </>
    )
  if (d && kind === 'pump') {
    const npshr = node!.data.props.npshr
    return (
      <>
        <div className="hero">
          <div>
            <b>{fmt(d.flow, 'flow', u)}</b>
            <span>{unitLabel('flow', u)}</span>
          </div>
          <div>
            <b>{fmt(d.dH, 'head', u)}</b>
            <span>head {unitLabel('head', u)}</span>
          </div>
          <div>
            <b>{fmt(d.shaftPower, 'power', u)}</b>
            <span>shaft {unitLabel('power', u)}</span>
          </div>
        </div>
        <Row label="Pressure rise" value={`${fmt(d.pIn, 'pressure', u)} → ${fmtU(d.pOut, 'pressure', u)}`} />
        <Row
          label="Efficiency"
          value={d.efficiency !== undefined ? `${(d.efficiency * 100).toFixed(0)} %` : '—'}
          tone={d.efficiency && d.efficiency > 0.85 * node!.data.props.bepEfficiency ? 'good' : 'warn'}
        />
        <Row label="Hydraulic power" value={fmtU(d.hydraulicPower, 'power', u)} />
        {node!.data.props.pumpType === 'fire' &&
          (() => {
            // NFPA 20 acceptance shape: shut-off ≤ 140 % of rated head, and ≥ 65 % of it still there at 150 % flow
            const pp = node!.data.props
            const churn = pumpHead(0, pp, 1) / pp.designHead
            const overload = pumpHead(1.5 * pp.designFlow, pp, 1) / pp.designHead
            return (
              <>
                <Row label="Churn (shut-off) head" value={`${(churn * 100).toFixed(0)} % of rated — limit 140 %`} tone={churn <= 1.4 ? 'good' : 'bad'} />
                <Row label="Head at 150 % flow" value={`${(overload * 100).toFixed(0)} % of rated — needs ≥ 65 %`} tone={overload >= 0.65 ? 'good' : 'bad'} />
                <Row label="Load now" value={`${((d.flow / pp.designFlow) * 100).toFixed(0)} % of rated flow`} />
              </>
            )
          })()}
        <Row label="NPSH available" value={fmtU(d.npsha, 'head', u)} tone={d.npsha !== undefined && d.npsha < npshr ? 'bad' : 'good'} />
      </>
    )
  }
  if (d && kind === 'dpgauge')
    return (
      <>
        <div className="hero">
          <div>
            <b>{fmt(d.pIn - d.pOut, 'pressure', u)}</b>
            <span>ΔP {unitLabel('pressure', u)}</span>
          </div>
          <div>
            <b>{fmt(d.headIn - d.headOut, 'head', u)}</b>
            <span>Δ head {unitLabel('head', u)}</span>
          </div>
        </div>
        <Row label="HI port" value={fmtU(d.pIn, 'pressure', u)} />
        <Row label="LO port" value={fmtU(d.pOut, 'pressure', u)} />
        <p className="muted">Sensing lines carry no flow, so each port reads the pressure at its tapping point.</p>
      </>
    )
  if (d && kind === 'element') {
    const p = node!.data.props
    return (
      <>
        <div className="hero">
          <div>
            <b>{fmt(d.tapDp, 'pressure', u)}</b>
            <span>tap Δp {unitLabel('pressure', u)}</span>
          </div>
          <div>
            <b>{fmt(d.inferredFlow, 'flow', u)}</b>
            <span>inferred {unitLabel('flow', u)}</span>
          </div>
          <div>
            <b>{fmt(d.permanentLoss, 'pressure', u)}</b>
            <span>lost {unitLabel('pressure', u)}</span>
          </div>
        </div>
        <Row label="Actual flow" value={fmtU(Math.abs(d.flow), 'flow', u)} />
        <Row label="Beta ratio β = d/D" value={beta(p).toFixed(3)} />
        <Row label="Throat velocity" value={fmtU(d.throatVelocity, 'velocity', u)} />
        <Row label="Pressure recovered" value={`${((1 - elementLossFraction(p)) * 100).toFixed(0)} %`} tone={elementLossFraction(p) < 0.3 ? 'good' : 'warn'} />
        <Row label="Pressure in → out" value={`${fmt(d.pIn, 'pressure', u)} → ${fmtU(d.pOut, 'pressure', u)}`} />
      </>
    )
  }
  if (d)
    return (
      <>
        <div className="hero">
          <div>
            <b>{fmt(Math.abs(d.flow), 'flow', u)}</b>
            <span>{unitLabel('flow', u)}</span>
          </div>
          <div>
            <b>{fmt(Math.abs(d.pIn - d.pOut), 'pressure', u)}</b>
            <span>ΔP {unitLabel('pressure', u)}</span>
          </div>
          <div>
            <b>{fmt(d.velocity, 'velocity', u)}</b>
            <span>{unitLabel('velocity', u)}</span>
          </div>
        </div>
        <Row label="Pressure in → out" value={`${fmt(d.pIn, 'pressure', u)} → ${fmtU(d.pOut, 'pressure', u)}`} />
        {kind === 'valve' && <Row label="Status" value={d.status} tone={d.status === 'closed' ? 'bad' : d.status === 'active' ? 'warn' : 'good'} />}
        {d.K !== undefined && <Row label="Loss coefficient K" value={isFinite(d.K) ? fmtNum(d.K) : '∞'} />}
        {d.kv !== undefined && <Row label="Flow coefficient" value={`Kv ${fmtNum(d.kv)} · Cv ${fmtNum(d.kv / 0.865)}`} />}
        {d.ratedShare !== undefined && <Row label="Load" value={`${(d.ratedShare * 100).toFixed(0)} % of rated flow`} tone={d.ratedShare > 1.5 ? 'warn' : undefined} />}
        <Row label="Head loss" value={fmtU(-d.dH, 'head', u)} />
      </>
    )
  const level = node?.data.kind === 'tank' ? (s.levels[id] ?? node.data.props.initLevel) : undefined
  return (
    <>
      <div className="hero">
        <div>
          <b>{fmt(n!.pressure, 'pressure', u)}</b>
          <span>{unitLabel('pressure', u)}</span>
        </div>
        <div>
          <b>{fmt(n!.head, 'head', u)}</b>
          <span>head {unitLabel('head', u)}</span>
        </div>
        <div>
          <b>{fmt(Math.abs(n!.outflow), 'flow', u)}</b>
          <span>
            {kind === 'tank' || kind === 'vessel'
              ? n!.outflow >= 0
                ? 'filling'
                : 'draining'
              : kind === 'leak'
                ? 'leaking'
                : kind === 'reservoir'
                  ? n!.outflow <= 0
                    ? 'supplying'
                    : 'receiving'
                  : 'out'}{' '}
            {unitLabel('flow', u)}
          </span>
        </div>
      </div>
      {level !== undefined && <Row label="Level" value={`${fmtU(level, 'length', u)} of ${fmtU(tankHeight(node!.data.props), 'length', u)}`} />}
      {level !== undefined && <Row label="Stored" value={`${fmtU(tankVolume(node!.data.props, level), 'volume', u)} of ${fmtU(tankVolume(node!.data.props, 1e9), 'volume', u)}`} />}
      {kind === 'vessel' &&
        (() => {
          const vp = node!.data.props
          const water = s.levels[id] ?? vesselWater(vp, vp.initPressure)
          return (
            <>
              <Row label="Water held" value={fmtU(water, 'volume', u)} />
              <Row label="Gas cushion" value={`${fmtU(vp.volume - water, 'volume', u)} at ${fmtU(vesselPressure(vp, water), 'pressure', u)}`} />
            </>
          )
        })()}
      {kind === 'leak' && <Row label="Lost per day" value={`${(n!.outflow * 86400).toFixed(1)} m³`} tone={n!.outflow > 1e-7 ? 'warn' : 'good'} />}
      {kind === 'reservoir' && node!.data.props.sourceType === 'well' && (
        <Row label="Drawdown" value={`${fmtU(node!.data.props.staticLevel - n!.head, 'head', u)} below the static level`} tone="warn" />
      )}
      <Row label="Elevation" value={fmtU(n!.elevation, 'length', u)} />
    </>
  )
}

export function Inspector() {
  const id = useLab(selectedId)
  const node = useLab((s) => s.nodes.find((n) => n.id === id))
  const edge = useLab((s) => s.edges.find((e) => e.id === id))
  const updateNode = useLab((s) => s.updateNode)
  const updateEdge = useLab((s) => s.updateEdge)
  const rename = useLab((s) => s.rename)
  const remove = useLab((s) => s.remove)
  const rotate = useLab((s) => s.rotate)
  const [tab, setTab] = useState('main')

  if (!id || (!node && !edge)) return <Overview />
  if (edge?.type === 'signal') {
    const name = (nid: string) => useLab.getState().nodes.find((n) => n.id === nid)?.data.label ?? '?'
    return (
      <aside className="inspector">
        <header className="insp-head">
          <div className="insp-icon">
            <KindIcon kind="timer" />
          </div>
          <div>
            <b className="insp-name">Signal wire</b>
            <span>
              {name(edge.source)} → {name(edge.target)}
            </span>
          </div>
          <button className="icon-btn danger" title="Delete (⌫)" onClick={() => remove(id)}>
            ✕
          </button>
        </header>
        <p className="muted tip">
          {edge.sourceHandle === 'pv'
            ? 'Carries an instrument’s reading to a controller. Wiring it is what turns a gauge, meter or tank into a transmitter.'
            : 'Carries a controller’s command, 0–100 %. The command scales the device’s own setting: at 0 % it is held off or shut, at 100 % it runs exactly as configured.'}
        </p>
      </aside>
    )
  }
  const kind: Kind | 'pipe' = node ? node.data.kind : 'pipe'
  const props = node ? node.data.props : edge!.data!.props
  const label = node ? node.data.label : edge!.data!.label
  const pvWire = useLab.getState().edges.find((e) => e.type === 'signal' && e.target === id && e.sourceHandle === 'pv')
  const pvSrc = pvWire && useLab.getState().nodes.find((n) => n.id === pvWire.source)
  const pvq: Quantity = (pvSrc && PV_SOURCES[pvSrc.data.kind]?.quantity) || 'none'
  const tabs =
    kind === 'timer'
      ? [
          ['main', 'Schedule'],
          ['trend', 'Trend'],
        ]
      : kind === 'switch' || kind === 'pid'
        ? [['main', 'Loop']]
        : kind !== 'pipe' && isControl(kind)
          ? [['trend', 'Trend']]
          : [
              ...(kind === 'pump' ? [['main', 'Pump curve']] : kind === 'pipe' ? [['main', 'ΔP (Q)']] : props.pattern && props.pattern !== 'constant' ? [['main', 'Daily pattern']] : []),
              ['trend', 'Trend'],
              ['grade', 'Grade line'],
            ]
  const active = tabs.find((t) => t[0] === tab) ? tab : tabs[0][0]

  return (
    <aside className="inspector">
      <header className="insp-head">
        <div className="insp-icon">
          <KindIcon kind={kind} />
        </div>
        <div>
          <input className="insp-name" value={label} onChange={(e) => rename(id, e.target.value)} />
          <span>{kind === 'pipe' ? 'Pipe' : kind === 'fitting' ? lossDevice(props.variant).name : (kind === 'outlet' && dischargeDevice(props.variant)?.name) || KIND_META[kind].name}</span>
        </div>
        {node && ROTATABLE.includes(node.data.kind) && (
          <button className="icon-btn" title="Rotate 90° (R)" onClick={() => rotate(id)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" />
            </svg>
          </button>
        )}
        <button className="icon-btn danger" title="Delete (⌫)" onClick={() => remove(id)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
          </svg>
        </button>
      </header>

      <section>
        <h4>Live readings</h4>
        {kind === 'timer' ? <TimerResults id={id} /> : kind !== 'pipe' && isControl(kind) ? <ControlResults id={id} kind={kind} /> : <Results id={id} kind={kind} />}
      </section>

      <section>
        <div className="tabs">
          {tabs.map(([k, name]) => (
            <button key={k} className={active === k ? 'on' : ''} onClick={() => setTab(k)}>
              {name}
            </button>
          ))}
        </div>
        {active === 'main' && kind === 'pump' && <PumpChart id={id} />}
        {active === 'main' && kind === 'pipe' && <PipeChart id={id} />}
        {active === 'trend' && <TrendChart id={id} kind={kind} />}
        {active === 'main' && kind === 'timer' && <ScheduleChart id={id} />}
        {active === 'main' && (kind === 'junction' || kind === 'outlet') && <PatternChart pattern={props.pattern} base={props.demand} />}
        {active === 'main' && (kind === 'switch' || kind === 'pid') && <LoopCharts id={id} kind={kind} />}
        {active === 'grade' && <GradeChart id={id} />}
      </section>

      {node && (kind === 'pump' || kind === 'outlet' || kind === 'leak' || (kind === 'valve' && (props.valveType === 'throttle' || props.valveType === 'float'))) && (
        <section>
          <h4>Water hammer</h4>
          <SurgePanel key={id} id={id} kind={kind as Kind} />
        </section>
      )}
      <section>
        <h4>Properties</h4>
        {kind === 'pipe' && <PipeSizePicker props={props} onChange={(patch) => updateEdge(id, patch)} />}
        {FIELDS[kind]
          .filter((f) => !f.show || f.show(props))
          .map((f) => (
            <FieldRow key={f.key} f={f} props={props} pvq={pvq} onChange={(patch) => (node ? updateNode(id, patch) : updateEdge(id, patch))} />
          ))}
      </section>
    </aside>
  )
}

function Overview() {
  const s = useLab()
  const fluid = FLUIDS.find((f) => f.id === s.fluidId) ?? FLUIDS[0]
  const supply = Object.entries(s.results.nodes).reduce((sum, [id, r]) => {
    const k = s.nodes.find((n) => n.id === id)?.data.kind
    return (k === 'reservoir' || k === 'tank') && r.outflow < 0 ? sum - r.outflow : sum
  }, 0)
  const power = Object.values(s.results.devices).reduce((sum, d) => sum + (d.shaftPower ?? 0), 0)
  return (
    <aside className="inspector">
      <header className="insp-head">
        <div className="insp-icon">
          <KindIcon kind="network" />
        </div>
        <div>
          <input className="insp-name" value={s.projectName} onChange={(e) => s.set({ projectName: e.target.value })} />
          <span>
            {s.nodes.length} components · {s.edges.length} pipes
          </span>
        </div>
      </header>
      <section>
        <h4>Network</h4>
        <div className="hero">
          <div>
            <b>{fmt(supply, 'flow', s.units)}</b>
            <span>supplied {unitLabel('flow', s.units)}</span>
          </div>
          <div>
            <b>{fmt(s.results.pMax > 1000 ? s.results.pMax : 0, 'pressure', s.units)}</b>
            <span>peak {unitLabel('pressure', s.units)}</span>
          </div>
          <div>
            <b>{fmt(power, 'power', s.units)}</b>
            <span>pumping {unitLabel('power', s.units)}</span>
          </div>
        </div>
      </section>
      <section>
        <h4>Hydraulic grade line</h4>
        <GradeChart />
      </section>
      <section>
        <h4>Fluid</h4>
        <div className="field">
          <span>Working fluid</span>
          <select value={s.fluidId} onChange={(e) => (s.checkpoint(), s.set({ fluidId: e.target.value }))}>
            {FLUIDS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <Row label="Density ρ" value={`${fluid.density} kg/m³`} />
        <Row label="Viscosity μ" value={`${(fluid.dynamicViscosity * 1000).toPrecision(3)} mPa·s`} />
        <Row label="Vapour pressure" value={`${(fluid.vaporPressure / 1000).toPrecision(3)} kPa abs`} />
      </section>
      <p className="muted tip">Click any pipe or component to see its live readings, curves and properties.</p>
    </aside>
  )
}
