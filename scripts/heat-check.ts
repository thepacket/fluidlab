// Transient heat engine against hand calculations, and against the steady thermal layer it must settle to.
import { engine } from '../src/engine/epanet'
import { stepHeat, type HeatState } from '../src/engine/heat'
import { EXPERIMENTS } from '../src/experiments'
import { area, frictionFactor, tankVolume, waterDensity, waterViscosity } from '../src/model/physics'
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

// 4. drawing off a cylinder while cold water refills it: stirred, the tap cools exponentially; stratified, it stays hot
//    until the cold front has climbed the whole tank
{
  const q = 0.1e-3
  const build = (stratified: boolean): Model => ({
    fluid: water,
    nodes: [
      node('R', 'reservoir', { head: 40 }),
      node('F', 'valve', { valveType: 'fcv', flowSetting: q, diameter: 0.02 }),
      node('T', 'tank', { elevation: 5, initTemp: 60, diameter: 0.5, initLevel: 1.02, maxLevel: 1.5, stratified }),
      node('tap', 'outlet', { mode: 'demand', demand: q }),
    ],
    edges: [
      { ...pipe('in1', 'R', 'F'), targetHandle: 'in' },
      { ...pipe('in2', 'F', 'T', { length: 1 }), sourceHandle: 'out', targetHandle: 'b' },
      { ...pipe('out', 'T', 'tap', { length: 1, diameter: 0.02 }), sourceHandle: 't' },
    ],
  })
  const V = tankVolume(build(false).nodes[2].data.props, 1.02)
  const half = V / 2 / q // seconds to draw half the cylinder
  const stirred = march(build(false), half, 5).s
  check('stirred tank after half a volume: 15 + 45·e^(−½)', stirred.tanks.T, 15 + 45 * Math.exp(-0.5), 0.01)
  const layered = march(build(true), half, 5).s
  check('stratified tank still delivers hot water from the top', layered.layers.T.at(-1)!, 60, 0.03)
  check('…while its bottom is already cold', layered.layers.T[0], 15, 0.05)
  // half its volume left at ~60 °C and was replaced at 15 °C, so the mean must have fallen by half of 45 K
  check('energy: the mean fell by what was drawn off', layered.tanks.T, 60 - 45 / 2, 0.02)
}

// 5. a radiator with a room round it: the room settles where what it is given equals what it loses; boiler off, it goes cold
{
  const ex = EXPERIMENTS.find((e) => e.id === 'warm-up')!
  const { nodes, edges } = ex.build()
  Object.assign(nodes.find((n) => n.id === 'r')!.data.props, { roomModel: true, outsideTemp: -5, roomLoss: 320 })
  Object.assign(nodes.find((n) => n.id === 'b')!.data.props, { ratedHeat: 12000 })
  const m = { nodes, edges, fluid: water } as unknown as Model
  const r = engine.solve(m)
  const room = r.thermal!.rooms!.r
  check('steady room: emitter output = loss to outside', -r.thermal!.devices.r.heat, 320 * (room + 5), 0.005)
  const live = march(m, 24 * 3600, 10).s
  check('live room warms up to the same temperature', live.rooms.r, room, 0.01)
  const off = engine.solve({ ...m, controls: { b: 0 } } as Model)
  check('boiler switched off by a controller: the room falls to outside', off.thermal!.rooms!.r, -5, 0.02)
}

// 6. hot water is thinner: the same flow down the same pipe loses less head at 80 °C than at 20 °C, by the ratio of the
//    friction factors at the two Reynolds numbers
{
  const build = (temp: number): Model => ({
    fluid: water,
    nodes: [node('R', 'reservoir', { head: 30, temp }), node('use', 'outlet', { mode: 'demand', demand: 0.2e-3 })],
    edges: [pipe('run', 'R', 'use', { length: 100, diameter: 0.02, material: 'copper', roughness: 0.0015e-3 })],
  })
  const cold = engine.solve(build(15)).links.run // 15 °C is the default: no thermal layer, nominal (20 °C) properties
  const hot = engine.solve(build(80)).links.run
  const nu20 = water.dynamicViscosity / water.density
  const nu80 = waterViscosity(80) / waterDensity(80)
  const rr = 0.0015e-3 / 0.02
  check('viscosity of water at 80 °C (mPa·s)', waterViscosity(80) * 1000, 0.355, 0.02)
  check('head loss, hot ÷ cold', hot.headloss / cold.headloss, frictionFactor(cold.re * (nu20 / nu80), rr) / frictionFactor(cold.re, rr), 0.01)
  check('reported Reynolds number follows the temperature', hot.re / cold.re, nu20 / nu80, 0.01)
}

if (failed) {
  console.error(`${failed} heat check(s) failed`)
  process.exit(1)
}
console.log('heat checks passed')
