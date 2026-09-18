// Open-channel engine against hand calculations.
import { solveChannel } from '../src/engine/channel'
import { engine } from '../src/engine/epanet'
import { G } from '../src/model/physics'
import { conjugateDepth, criticalDepth, defaultChannelProps, normalDepth, specificForce, weirFlow } from '../src/model/openchannel'
import { FLUIDS, defaultPipeProps, defaultProps, type Kind, type Model } from '../src/model/types'

const node = (id: string, kind: Kind, props = {}) => ({ id, data: { kind, label: id, props: { ...defaultProps(kind), ...props } } })
const reach = (id: string, s: string, t: string, props = {}) => ({ id, source: s, target: t, type: 'pipe', data: { label: id, props: { ...defaultChannelProps(), ...props } } })
const rig = (nodes: Model['nodes'], edges: Model['edges']): Model => ({ fluid: FLUIDS[0], nodes, edges })
let failed = 0
const check = (name: string, got: number, want: number, tol = 0.01) => {
  const ok = Math.abs(got - want) <= tol * Math.max(Math.abs(want), 1e-9)
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}: ${got.toPrecision(5)} (expected ${want.toPrecision(5)})`)
}
const truthy = (name: string, ok: boolean, note = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name} ${note}`)
}

// 1. section hydraulics
{
  const rect = { ...defaultChannelProps(), width: 2, manningN: 0.013 }
  check('critical depth, rectangular', criticalDepth(3, rect), ((3 / 2) ** 2 / G) ** (1 / 3), 1e-4)
  const yn = normalDepth(3, rect, 0.001)!
  const a = 2 * yn
  check('normal depth satisfies Manning', (a * (a / (2 + 2 * yn)) ** (2 / 3) * Math.sqrt(0.001)) / 0.013, 3, 1e-4)
  // Bélanger: y2/y1 = ½(√(1+8Fr²) − 1)
  const y1 = 0.2
  const fr = 3 / (2 * y1) / Math.sqrt(G * y1)
  check('conjugate depth (Bélanger)', conjugateDepth(3, rect, y1), (y1 / 2) * (Math.sqrt(1 + 8 * fr * fr) - 1), 1e-4)
  const trap = { ...defaultChannelProps(), shape: 'trap', width: 3, sideSlope: 2, manningN: 0.025 }
  const yt = normalDepth(10, trap, 0.0005)!
  const at = (3 + 2 * yt) * yt
  check('normal depth, trapezoid', (at * (at / (3 + 2 * yt * Math.sqrt(5))) ** (2 / 3) * Math.sqrt(0.0005)) / 0.025, 10, 1e-4)
  check('90° V-notch, H = 0.2 m', weirFlow({ variant: 'vnotch', notchAngle: 90 }, 0.2), 1.37 * 0.2 ** 2.5, 0.01)
}

// 2. long mild channel to a free overfall: M2, critical at the brink, normal far upstream
{
  const m = rig([node('I', 'inflow', { elevation: 1, flow: 0.4 }), node('O', 'outfall', { elevation: 0 })], [reach('r', 'I', 'O', { length: 1000, width: 1, bankHeight: 2 })])
  const r = solveChannel(m)!.channel!.reaches.r
  check('M2: brink depth = yc', r.depth[80], r.yc, 0.002)
  check('M2: far upstream → yn', r.depth[0], r.yn!, 0.01)
  truthy('M2 named', r.profile.includes('M2'), r.profile)
}

// 3. weir at the end of a mild channel: M1, depth at the weir = crest + head
{
  const m = rig(
    [node('I', 'inflow', { elevation: 0.5, flow: 0.2 }), node('W', 'weir', { elevation: 0, crestHeight: 0.6, crestWidth: 1 }), node('O', 'outfall', { elevation: -0.01 })],
    [reach('a', 'I', 'W', { length: 500, width: 1, bankHeight: 2 }), reach('b', 'W', 'O', { length: 10, width: 1, bankHeight: 2 })],
  )
  const res = solveChannel(m)!
  const a = res.channel!.reaches.a
  const h = res.nodes.W.extra!.headOver
  check('weir passes the flow at its head', weirFlow(m.nodes[1].data.props, h), 0.2, 1e-3)
  check('depth at the weir', a.depth[80], 0.6 + h, 1e-3)
  truthy('M1 named', a.profile.includes('M1'), a.profile)
}

// 4. sluice gate on a mild channel: M3 jet, then a jump whose depths are conjugate
{
  const m = rig(
    [node('I', 'inflow', { elevation: 0.2, flow: 0.5 }), node('Gt', 'gate', { elevation: 0.1, opening: 0.12, width: 1 }), node('O', 'outfall', { elevation: 0, mode: 'normal' })],
    [reach('a', 'I', 'Gt', { length: 100, width: 1, bankHeight: 3 }), reach('b', 'Gt', 'O', { length: 200, width: 1, bankHeight: 3 })],
  )
  const res = solveChannel(m)!
  const b = res.channel!.reaches.b
  truthy('jump forms downstream of the gate', !!b.jump, b.profile)
  if (b.jump) {
    const p = m.edges[1].data!.props
    check('jump conserves specific force', specificForce(0.5, p, b.jump.y2), specificForce(0.5, p, b.jump.y1), 0.06)
    truthy('jump dissipates energy', b.jump.loss > 0, `${b.jump.loss.toFixed(3)} m`)
  }
  check('jet leaves at Cc·a', b.depth[0], 0.61 * 0.12, 1e-3)
}

// 5. steep channel: critical at the inlet, S2 down to normal depth
{
  const m = rig([node('I', 'inflow', { elevation: 5, flow: 0.5 }), node('O', 'outfall', { elevation: 0 })], [reach('r', 'I', 'O', { length: 100, width: 1, bankHeight: 2 })])
  const r = solveChannel(m)!.channel!.reaches.r
  check('S2: inlet at yc', r.depth[0], r.yc, 0.002)
  check('S2: reaches yn', r.depth[80], r.yn!, 0.01)
  truthy('steep', r.slopeClass === 'steep' && r.profile.includes('S2'), r.profile)
}

// 6. a fork: two identical branches share equally, unequal ones agree on the fork level
{
  const nodes = [node('I', 'inflow', { elevation: 1, flow: 1 }), node('J', 'junction', { elevation: 0.9 }), node('O1', 'outfall', { elevation: 0.8 }), node('O2', 'outfall', { elevation: 0.8 })]
  const same = solveChannel(rig(nodes, [reach('a', 'I', 'J', { width: 2 }), reach('b', 'J', 'O1', { length: 200, width: 1 }), reach('c', 'J', 'O2', { length: 200, width: 1 })]))!
  check('equal branches split 50/50', same.channel!.reaches.b.flow, 0.5, 1e-3)
  const diff = solveChannel(rig(nodes, [reach('a', 'I', 'J', { width: 2 }), reach('b', 'J', 'O1', { length: 200, width: 1.5 }), reach('c', 'J', 'O2', { length: 200, width: 0.7 })]))!
  const [b, c] = [diff.channel!.reaches.b, diff.channel!.reaches.c]
  check('fork: continuity', b.flow + c.flow, 1, 1e-6)
  check('fork: both branches see one level', b.depth[0], c.depth[0], 0.002)
  truthy('wider branch takes more', b.flow > c.flow, `${b.flow.toFixed(3)} / ${c.flow.toFixed(3)}`)
}

// 7. a lake feeding a steep channel: critical at the lip, so E = H gives y_c = ⅔H and Q = b·√(g·y_c³)
{
  const H = 0.6
  const m = rig([node('L', 'reservoir', { head: 10, channelInvert: 10 - H }), node('O', 'outfall', { elevation: 5 })], [reach('r', 'L', 'O', { length: 100, width: 2, bankHeight: 2 })])
  const res = solveChannel(m)!
  check('lake → steep channel: critical flow under the available energy', res.channel!.reaches.r.flow, 2 * Math.sqrt(G * ((2 / 3) * H) ** 3), 0.01)
  check('the lake supplies it', res.nodes.L.outflow, -res.channel!.reaches.r.flow, 1e-9)
}

// 8. a lake feeding a long mild channel: uniform flow whose depth + velocity head equals the lake's height over the sill
{
  const H = 0.8
  const props = { length: 3000, width: 2, bankHeight: 2 }
  const m = rig([node('L', 'reservoir', { head: 10, channelInvert: 10 - H }), node('O', 'outfall', { elevation: 10 - H - 1.5, mode: 'normal' })], [reach('r', 'L', 'O', props)])
  const r = solveChannel(m)!.channel!.reaches.r
  const yn = r.yn!
  check('lake → mild channel: y_n + v²/2g = H', yn + (r.flow / (2 * yn)) ** 2 / (2 * G), H, 0.01)
  truthy('mild', r.slopeClass === 'mild', `${(r.flow * 1000).toFixed(0)} L/s`)
}

// 9. a channel ending in a tank: the tank's level is the tailwater, and the tank gains the flow
{
  const m = rig(
    [node('I', 'inflow', { elevation: 1, flow: 0.2 }), node('T', 'tank', { elevation: 0, initLevel: 1.4, maxLevel: 3, diameter: 5 })],
    [reach('r', 'I', 'T', { length: 300, width: 1, bankHeight: 2 })],
  )
  const res = solveChannel(m)!
  check('channel → tank: depth at the end = tank level', res.channel!.reaches.r.depth[80], 1.4, 1e-3)
  check('the tank fills at the channel flow', res.nodes.T.outflow, 0.2, 1e-9)
}

// 10. pipework feeding a channel: what the outlet discharges is what the channel carries; a tank sums both sides
{
  await engine.ready()
  const m: Model = {
    fluid: FLUIDS[0],
    nodes: [
      node('R', 'reservoir', { head: 20 }),
      node('Out', 'outlet', { mode: 'demand', demand: 0.05, elevation: 1 }),
      node('W', 'weir', { elevation: 0.9, variant: 'vnotch', crestHeight: 0.2 }),
      node('T', 'tank', { elevation: -1, initLevel: 0.5, maxLevel: 3, diameter: 4 }),
      node('Use', 'outlet', { mode: 'demand', demand: 0.01, elevation: -1 }),
    ],
    edges: [
      { id: 'p', source: 'R', target: 'Out', sourceHandle: 'r', targetHandle: 'l', data: { label: 'p', props: { ...defaultPipeProps(), diameter: 0.2, length: 50 } } },
      reach('a', 'Out', 'W', { length: 40, width: 0.6 }),
      reach('b', 'W', 'T', { length: 20, width: 0.6 }),
      { id: 'q', source: 'T', target: 'Use', sourceHandle: 'r', targetHandle: 'l', data: { label: 'q', props: { ...defaultPipeProps(), diameter: 0.1, length: 10 } } },
    ],
  }
  const res = engine.solve(m)
  truthy('pipes and channels solve together', res.ok, res.error ?? '')
  check('the channel carries what the outlet discharges', res.channel!.reaches.a.flow, 0.05, 1e-6)
  check('the outlet keeps its own reading', res.nodes.Out.outflow, 0.05, 1e-6)
  check('the V-notch reads that flow', res.nodes.W.extra!.flow, 0.05, 1e-6)
  check('the tank gains channel inflow minus pipe draw-off', res.nodes.T.outflow, 0.05 - 0.01, 1e-4)
}

if (failed) {
  console.error(`${failed} open-channel check(s) failed`)
  process.exit(1)
}
console.log('open-channel checks passed')
