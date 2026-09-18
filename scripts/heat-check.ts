// Transient heat engine against hand calculations, and against the steady thermal layer it must settle to.
import { engine } from '../src/engine/epanet'
import { stepHeat, type HeatState } from '../src/engine/heat'
import { EXPERIMENTS } from '../src/experiments'
import { area, tankVolume } from '../src/model/physics'
import { FLUIDS, defaultPipeProps, defaultProps, type Kind, type Model } from '../src/model/types'

await engine.ready()
const water = FLUIDS[0]
const RHO_CP = water.density * 4186
const node = (id: string, kind: Kind, props = {}) => ({ id, data: { kind, label: id, props: { ...defaultProps(kind), ...props } } })
const pipe = (id: string, s: string, t: string, props = {}) => ({ id, source: s, target: t, sourceHandle: 'r', targetHandle: 'l', data: { label: id, props: { ...defaultPipeProps(), ...props } } })
let failed = 0
const check = (name: string, got: number, want: number, tol = 0.01) => {
  const ok = Math.abs(got - want) <= tol * Math.max(Math.abs(want), 1e-9)
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}: ${got.toPrecision(5)} (expected ${want.toPrecision(5)})`)
}
const march = (m: Model, seconds: number, dt: number, each?: (t: number, s: HeatState) => void) => {
  const r = engine.solve(m)
  let s: HeatState | null = null
  for (let t = 0; t < seconds; t += dt) {
    s = stepHeat(m, r, s, dt)
    each?.(t + dt, s!)
  }
  return { r, s: s! }
}

// 1. dead leg: hot water from a cylinder reaches the tap after the pipe's water — and its wall — have been swept out
{
  const L = 18,
    D = 0.013,
    q = 0.1e-3
  const m: Model = {
    fluid: water,
    nodes: [node('T', 'tank', { elevation: 5, initTemp: 60, diameter: 1 }), node('tap', 'outlet', { mode: 'demand', demand: q })],
    edges: [pipe('leg', 'T', 'tap', { length: L, diameter: D, material: 'copper' })],
  }
  let arrival = 0
  march(m, 120, 0.25, (t, s) => {
    if (!arrival && s.points.tap >= 40) arrival = t
  })
  const tWall = Math.max(0.0015, 0.06 * D)
  const wall = Math.PI * (D + tWall) * tWall * 3.4e6
  check('hot water arrives after V·(1 + wall/water) / Q', arrival, (L * (area(D) * RHO_CP + wall)) / (q * RHO_CP), 0.08)
}

// 2. immersion heater: dT/dt = P / (ρ·c·V), then the thermostat holds the setpoint
{
  const m: Model = {
    fluid: water,
    nodes: [node('T', 'tank', { elevation: 5, initTemp: 15, diameter: 0.5, initLevel: 1, heaterPower: 3000, heaterSetpoint: 60 }), node('tap', 'outlet', { mode: 'demand', demand: 0 })],
    edges: [pipe('leg', 'T', 'tap')],
  }
  const V = tankVolume(m.nodes[0].data.props, 1)
  const { s } = march(m, 1800, 10)
  check('cylinder warms at P / ρcV', s.tanks.T, 15 + (3000 * 1800) / (RHO_CP * V), 0.005)
  const later = march(m, 6 * 3600, 30)
  check('thermostat holds the setpoint', later.s.tanks.T, 60, 0.002)
}

// 3. a heating loop, run for long enough, must land on the steady layer's answer — and its heat balance must close
{
  const ex = EXPERIMENTS.find((e) => e.id === 'hydronic')!
  const { nodes, edges } = ex.build()
  const m = { nodes, edges, fluid: water } as unknown as Model
  const { r, s } = march(m, 4 * 3600, 5)
  let worst = 0
  for (const [id, t] of Object.entries(r.thermal!.nodes)) worst = Math.max(worst, Math.abs(t - s.points[id]))
  for (const [id, d] of Object.entries(r.thermal!.devices)) worst = Math.max(worst, Math.abs(d.tOut - (s.devices[id] ?? d.tOut)))
  check('warm-up settles on the steady thermal solution (worst difference, K)', worst < 0.2 ? 0 : worst, 0, 0)
  console.log(
    `  worst difference ${worst.toFixed(3)} K · input ${(s.balance.input / 1000).toFixed(2)} kW = emitted ${(s.balance.emitted / 1000).toFixed(2)} kW + pipes ${(s.balance.pipeLoss / 1000).toFixed(2)} kW`,
  )
  check('heat balance closes at steady state', s.balance.input, s.balance.emitted + s.balance.pipeLoss, 0.01)
}

if (failed) {
  console.error(`${failed} heat check(s) failed`)
  process.exit(1)
}
console.log('heat checks passed')
