import { useEffect, useMemo, useState } from 'react'
import { gradeLine, pipeCurve, pumpCurve, type XY } from '../engine/analysis'
import { solver } from '../engine/client'
import { fmtClock, timerState } from '../model/control'
import { beta, elementLossFraction } from '../model/physics'
import { ELEMENT_TYPES, FLUIDS, KIND_META, MATERIALS, ROTATABLE, VALVE_TYPES, type Kind, type Props } from '../model/types'
import { fmt, fmtNum, fmtU, toDisplay, toSI, unitLabel, type Quantity } from '../model/units'
import { model, selectedId, useLab } from '../store'
import { Chart, SERIES, type Marker, type Series } from './Chart'
import { KindIcon } from './icons'

interface Field {
  key: string
  label: string
  q: Quantity
  type?: 'number' | 'slider' | 'toggle' | 'select'
  options?: { id: string; name: string }[]
  max?: number
  show?: (p: Props) => boolean
  hint?: string
}

const elevation: Field = { key: 'elevation', label: 'Elevation', q: 'length' }
const FIELDS: Record<Kind | 'pipe', Field[]> = {
  reservoir: [{ key: 'head', label: 'Water surface head', q: 'head' }],
  tank: [
    { key: 'diameter', label: 'Tank diameter', q: 'length' },
    { key: 'initLevel', label: 'Initial level', q: 'length' },
    { key: 'maxLevel', label: 'Maximum level', q: 'length' },
    { key: 'minLevel', label: 'Minimum level', q: 'length' },
    { ...elevation, label: 'Base elevation' },
  ],
  junction: [elevation, { key: 'demand', label: 'Demand (draw-off)', q: 'flow' }],
  gauge: [elevation],
  outlet: [
    {
      key: 'mode',
      label: 'Behaviour',
      q: 'none',
      type: 'select',
      options: [
        { id: 'nozzle', name: 'Open nozzle (pressure-driven)' },
        { id: 'demand', name: 'Fixed demand' },
      ],
    },
    { key: 'nozzleDiameter', label: 'Nozzle bore', q: 'diameter', show: (p) => p.mode === 'nozzle' },
    { key: 'cd', label: 'Discharge coeff. Cd', q: 'none', show: (p) => p.mode === 'nozzle' },
    { key: 'demand', label: 'Demand', q: 'flow', show: (p) => p.mode === 'demand' },
    elevation,
  ],
  pump: [
    { key: 'on', label: 'Power', q: 'none', type: 'toggle' },
    { key: 'speed', label: 'Speed (VFD)', q: 'percent', type: 'slider', max: 1.5 },
    { key: 'designFlow', label: 'Design flow', q: 'flow' },
    { key: 'designHead', label: 'Design head', q: 'head' },
    { key: 'bepEfficiency', label: 'Best efficiency', q: 'percent' },
    { key: 'npshr', label: 'NPSH required', q: 'head' },
    elevation,
  ],
  valve: [
    { key: 'valveType', label: 'Type', q: 'none', type: 'select', options: VALVE_TYPES },
    { key: 'opening', label: 'Opening', q: 'percent', type: 'slider', max: 1, show: (p) => p.valveType === 'throttle' },
    { key: 'pressureSetting', label: 'Pressure setpoint', q: 'pressure', show: (p) => p.valveType === 'prv' || p.valveType === 'psv' },
    { key: 'flowSetting', label: 'Flow setpoint', q: 'flow', show: (p) => p.valveType === 'fcv' },
    { key: 'diameter', label: 'Bore', q: 'diameter' },
    { key: 'kOpen', label: 'K when fully open', q: 'none' },
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

function FieldRow({ f, props, onChange }: { f: Field; props: Props; onChange: (patch: Props) => void }) {
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
          value={v}
          onChange={(e) => {
            const patch: Props = { [f.key]: e.target.value }
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
        q={f.q}
        onCommit={(si) => {
          const patch: Props = { [f.key]: si }
          if (f.key === 'roughness') patch.material = 'custom'
          onChange(patch)
        }}
      />
    </div>
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
  const cv = (pts: { x: number; y: number }[]) => pts.map((pt) => ({ x: toDisplay(pt.x, 'flow', s.units), y: toDisplay(pt.y, 'head', s.units) }))
  const series: Series[] = [{ name: `Pump @ ${Math.round(p.speed * 100)} %`, color: SERIES.blue, points: cv(pumpCurve(p, Math.max(0.05, p.speed))), area: true }]
  if (Math.abs(p.speed - 1) > 0.01) series.push({ name: 'Pump @ 100 %', color: SERIES.blue, points: cv(pumpCurve(p, 1)), dashed: true })
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
  if (kind === 'timer') return ['none', 'Output']
  if (kind === 'tank') return ['length', 'Level']
  if (kind === 'junction' || kind === 'gauge') return ['pressure', 'Pressure']
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
            {kind === 'tank' ? (n!.outflow >= 0 ? 'filling' : 'draining') : kind === 'reservoir' ? (n!.outflow <= 0 ? 'supplying' : 'receiving') : 'out'} {unitLabel('flow', u)}
          </span>
        </div>
      </div>
      {level !== undefined && <Row label="Level" value={`${fmtU(level, 'length', u)} · ${(((level * Math.PI * node!.data.props.diameter ** 2) / 4) * 1000).toFixed(0)} L`} />}
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
          Carries the controller’s on/off command. While the command is OFF the device is held off or shut, whatever its own settings say; while ON it runs on its own settings.
        </p>
      </aside>
    )
  }
  const kind: Kind | 'pipe' = node ? node.data.kind : 'pipe'
  const props = node ? node.data.props : edge!.data!.props
  const label = node ? node.data.label : edge!.data!.label
  const tabs =
    kind === 'timer'
      ? [
          ['main', 'Schedule'],
          ['trend', 'Trend'],
        ]
      : [...(kind === 'pump' ? [['main', 'Pump curve']] : kind === 'pipe' ? [['main', 'ΔP (Q)']] : []), ['trend', 'Trend'], ['grade', 'Grade line']]
  const active = tabs.find((t) => t[0] === tab) ? tab : tabs[0][0]

  return (
    <aside className="inspector">
      <header className="insp-head">
        <div className="insp-icon">
          <KindIcon kind={kind} />
        </div>
        <div>
          <input className="insp-name" value={label} onChange={(e) => rename(id, e.target.value)} />
          <span>{kind === 'pipe' ? 'Pipe' : KIND_META[kind].name}</span>
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
        {kind === 'timer' ? <TimerResults id={id} /> : <Results id={id} kind={kind} />}
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
        {active === 'grade' && <GradeChart id={id} />}
      </section>

      <section>
        <h4>Properties</h4>
        {FIELDS[kind]
          .filter((f) => !f.show || f.show(props))
          .map((f) => (
            <FieldRow key={f.key} f={f} props={props} onChange={(patch) => (node ? updateNode(id, patch) : updateEdge(id, patch))} />
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
