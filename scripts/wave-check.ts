// Unsteady channel engine: it must hold the steady solution, conserve water, settle on the new steady state after a
// change, and move a disturbance at about the dynamic wave speed.
import { solveChannel } from '../src/engine/channel'
import { stepWave, waveView, type WaveState } from '../src/engine/wave'
import { G } from '../src/model/physics'
import { defaultChannelProps } from '../src/model/openchannel'
import { FLUIDS, defaultProps, type Kind, type Model } from '../src/model/types'

const node = (id: string, kind: Kind, props = {}) => ({ id, data: { kind, label: id, props: { ...defaultProps(kind), ...props } } })
const reach = (id: string, s: string, t: string, props = {}) => ({ id, source: s, target: t, type: 'pipe', data: { label: id, props: { ...defaultChannelProps(), ...props } } })
let failed = 0
const check = (name: string, got: number, want: number, tol = 0.01) => {
  const ok = Math.abs(got - want) <= tol * Math.max(Math.abs(want), 1e-9)
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}: ${got.toPrecision(5)} (expected ${want.toPrecision(5)})`)
}
const weirRig = (flow: number): Model => ({
  fluid: FLUIDS[0],
  nodes: [
    node('I', 'inflow', { elevation: 0.3, flow }),
    node('J', 'gauge', { elevation: 0.15 }),
    node('W', 'weir', { elevation: 0, crestHeight: 0.4, crestWidth: 1 }),
    node('O', 'outfall', { elevation: -0.02 }),
  ],
  edges: [
    reach('a', 'I', 'J', { length: 150, width: 1, bankHeight: 2 }),
    reach('b', 'J', 'W', { length: 150, width: 1, bankHeight: 2 }),
    reach('c', 'W', 'O', { length: 20, width: 1, bankHeight: 2 }),
  ],
})
const march = (m: Model, base: ReturnType<typeof solveChannel>, from: WaveState | null, seconds: number, each?: (t: number, s: WaveState) => void) => {
  let s = from
  for (let t = 0; t < seconds; t += 2) {
    s = stepWave(m, base!, s, 2, {}, 4000)
    each?.(t + 2, s!)
  }
  return s!
}

// 1. start on the steady solution and stay there
const low = weirRig(0.2)
const steadyLow = solveChannel(low)!
let st = march(low, steadyLow, null, 900)
let view = waveView(low, steadyLow, st)
check('holds the steady depth behind the weir', view.channel.reaches.b.depth.at(-1)!, steadyLow.channel!.reaches.b.depth[80], 0.03)
check('holds the steady flow', view.channel.reaches.c.flow, 0.2, 0.02)
check('junction pond sits at the steady level', view.nodes.J.extra!.depth, steadyLow.nodes.J.extra!.depth, 0.05)

// 2. double the inflow: it must end up on the steady solution for the new flow, having stored the difference on the way
const high = weirRig(0.4)
const steadyHigh = solveChannel(high)!
// everything upstream of the weir: the two reaches (the junction pond between them holds next to nothing)
const volume = (s: WaveState) => ['a', 'b'].reduce((sum, id) => sum + s.reaches[id].a.reduce((x, a) => x + a, 0) * (150 / s.reaches[id].a.length), 0)
const v0 = volume(st)
let outflow = 0
let arrival = 0
st = march(high, steadyLow, st, 1800, (t, s) => {
  outflow += s.through.W * 2
  if (!arrival && s.reaches.b.q.at(-1)! > 0.21) arrival = t
})
view = waveView(high, steadyLow, st)
check('settles on the new steady depth', view.channel.reaches.b.depth.at(-1)!, steadyHigh.channel!.reaches.b.depth[80], 0.03)
check('settles on the new steady flow', view.channel.reaches.c.flow, 0.4, 0.02)
check('water is conserved: in − over the weir = stored upstream', 0.4 * 1800 - outflow, volume(st) - v0, 0.03)
const y = steadyLow.channel!.reaches.a.depth[40]
const celerity = 0.2 / y + Math.sqrt(G * y)
check('the rise arrives at about L / (u + c)', arrival, 300 / celerity, 0.35)

// 2b. friction on its own: a long uniform channel must sit at normal depth, which only the right Manning term gives
{
  const m: Model = {
    fluid: FLUIDS[0],
    nodes: [node('I', 'inflow', { elevation: 1, flow: 0.3 }), node('O', 'outfall', { elevation: 0, mode: 'normal' })],
    edges: [reach('r', 'I', 'O', { length: 500, width: 0.6, bankHeight: 2 })],
  }
  const steady = solveChannel(m)!
  const s = march(m, steady, null, 1200)
  const v = waveView(m, steady, s)
  check('uniform flow settles at the Manning normal depth', v.channel.reaches.r.depth[15], steady.channel!.reaches.r.yn!, 0.02)
}

// 3. a pressurised culvert (Preissmann slot): the unsteady engine must hold the steady surcharged state too
{
  const m: Model = {
    fluid: FLUIDS[0],
    nodes: [node('I', 'inflow', { elevation: 0.2, flow: 0.6 }), node('O', 'outfall', { elevation: 0, mode: 'level', level: 1.5 })],
    edges: [reach('c', 'I', 'O', { length: 40, shape: 'circ', diameter: 0.6, lining: 'concrete' })],
  }
  const steady = solveChannel(m)!
  const s = march(m, steady, null, 120)
  const v = waveView(m, steady, s)
  check('surcharged culvert: holds the steady pressure head', v.channel.reaches.c.depth[0], steady.channel!.reaches.c.depth[0], 0.04)
  check('surcharged culvert: holds the flow', v.channel.reaches.c.flow, 0.6, 0.02)
}

if (failed) {
  console.error(`${failed} wave check(s) failed`)
  process.exit(1)
}
console.log('wave checks passed')
