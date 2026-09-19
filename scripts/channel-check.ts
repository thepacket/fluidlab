// Open-channel engine against hand calculations.
import { solveChannel } from '../src/engine/channel'
import { engine } from '../src/engine/epanet'
import { G } from '../src/model/physics'
import { conjugateDepth, criticalDepth, defaultChannelProps, drownedFlow, normalDepth, specificForce, weirFlow, weirHead } from '../src/model/openchannel'
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

// 9b. three branches: continuity, and one water level at the fork
{
  const nodes = [
    node('I', 'inflow', { elevation: 1, flow: 1.2 }),
    node('J', 'junction', { elevation: 0.9 }),
    node('O1', 'outfall', { elevation: 0.8 }),
    node('O2', 'outfall', { elevation: 0.8 }),
    node('O3', 'outfall', { elevation: 0.8 }),
  ]
  const res = solveChannel(
    rig(nodes, [
      reach('a', 'I', 'J', { width: 3 }),
      reach('b', 'J', 'O1', { length: 200, width: 1.5 }),
      reach('c', 'J', 'O2', { length: 200, width: 0.7 }),
      reach('d', 'J', 'O3', { length: 120, width: 1 }),
    ]),
  )!
  const [b, c, d] = ['b', 'c', 'd'].map((k) => res.channel!.reaches[k])
  check('three-way fork: continuity', b.flow + c.flow + d.flow, 1.2, 1e-6)
  check('three-way fork: b and c agree on the level', b.depth[0], c.depth[0], 0.005)
  check('three-way fork: c and d agree on the level', c.depth[0], d.depth[0], 0.005)
}

// 9c. a step down in the bed: critical at the brink above it, and the fall's height handed on as energy
{
  const m = rig(
    [node('I', 'inflow', { elevation: 1.05, flow: 0.4 }), node('J', 'junction', { elevation: 1, drop: 0.6 }), node('O', 'outfall', { elevation: 0.38 })],
    [reach('a', 'I', 'J', { length: 100, width: 1, bankHeight: 2 }), reach('b', 'J', 'O', { length: 40, width: 1, bankHeight: 2 })],
  )
  const res = solveChannel(m)!
  const [a, b] = [res.channel!.reaches.a, res.channel!.reaches.b]
  check('brink above the step is critical', a.depth[80], a.yc, 0.005)
  check('bed of the lower reach starts a step lower', b.bed[0], 0.4, 1e-9)
  truthy('water leaves the foot of the step supercritical', b.froude[0] > 1.5, `Fr ${b.froude[0].toFixed(2)}`)
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

// 11. a pump drawing from a canal: the pipe side sees the canal's level as its suction head; the canal loses what it takes
{
  const m: Model = {
    fluid: FLUIDS[0],
    nodes: [
      node('I', 'inflow', { elevation: 1, flow: 0.2 }),
      node('J', 'junction', { elevation: 0.9 }),
      node('O', 'outfall', { elevation: 0.8 }),
      node('P', 'pump', { designFlow: 0.03, designHead: 15 }),
      node('Use', 'outlet', { elevation: 8, mode: 'nozzle', nozzleDiameter: 0.06 }),
    ],
    edges: [
      reach('a', 'I', 'J', { length: 100, width: 1 }),
      reach('b', 'J', 'O', { length: 100, width: 1 }),
      { id: 's', source: 'J', target: 'P', sourceHandle: 'b', targetHandle: 'in', data: { label: 's', props: { ...defaultPipeProps(), diameter: 0.15, length: 5 } } },
      { id: 'd', source: 'P', target: 'Use', sourceHandle: 'out', targetHandle: 'l', data: { label: 'd', props: { ...defaultPipeProps(), diameter: 0.1, length: 60 } } },
    ],
  }
  const res = engine.solve(m)
  const q = res.devices.P.flow
  truthy('a pump can draw from a canal', res.ok && q > 0.005, `${(q * 1000).toFixed(1)} L/s`)
  check('the canal downstream carries what is left', res.channel!.reaches.b.flow, 0.2 - q, 2e-3)
  const lost = res.nodes.J.head - res.devices.P.headIn // friction in 5 m of suction pipe: a few centimetres
  truthy('pump suction head = canal water level, less the suction pipe’s friction', lost > 0 && lost < 0.1, `${(lost * 100).toFixed(1)} cm`)
}

// 12. a culvert running full: drowned at its outlet and asked for more than it can carry with a free surface, it is a
//     pressurised pipe — upstream head = tailwater + (S_f − S₀)·L with the full-bore Manning friction slope
{
  const D = 0.6
  const L = 40
  const Q = 0.6
  const m = rig(
    [node('I', 'inflow', { elevation: 0.2, flow: Q }), node('O', 'outfall', { elevation: 0, mode: 'level', level: 1.5 })],
    [reach('c', 'I', 'O', { length: L, shape: 'circ', diameter: D, lining: 'concrete' })],
  )
  const res = solveChannel(m)!
  const r = res.channel!.reaches.c
  const A = (Math.PI * D * D) / 4
  const sf = (0.013 * Q) ** 2 / (A * A * (D / 4) ** (4 / 3))
  check('surcharged culvert: upstream pressure head', r.depth[0], 1.5 + (sf - 0.2 / L) * L, 0.01)
  truthy('reported as running full', r.profile.includes('full') && res.warnings.some((w) => w.text.includes('running full')), r.profile)
}

// 13. a Parshall flume keeps its free-flow rating until the tailwater is 60 % of the upstream head (6 in throat),
//     and needs more head for the same flow beyond that
{
  const flume = { variant: 'parshall', throat: '6in' }
  check('Parshall, 50 % submerged: free-flow rating holds', drownedFlow(flume, 0.3, 0.15), weirFlow(flume, 0.3), 1e-9)
  truthy(
    'Parshall, 85 % submerged: passes less',
    drownedFlow(flume, 0.3, 0.255) < 0.9 * weirFlow(flume, 0.3),
    `${((drownedFlow(flume, 0.3, 0.255) / weirFlow(flume, 0.3)) * 100).toFixed(0)} % of free flow`,
  )
  check('continuous at the limit', drownedFlow(flume, 0.3, 0.1801), weirFlow(flume, 0.3), 1e-3)
  check('head for a flow under submergence inverts the rating', drownedFlow(flume, weirHead(flume, 0.05, 0.25), 0.25), 0.05, 1e-6)
}

// 14. a full tank with an overflow spills its surplus into the channel that leaves it, and stays full
{
  await engine.ready()
  const m: Model = {
    fluid: FLUIDS[0],
    nodes: [
      node('R', 'reservoir', { head: 30 }),
      node('V', 'valve', { valveType: 'fcv', flowSetting: 0.02, diameter: 0.1 }),
      node('T', 'tank', { elevation: 2, diameter: 2, initLevel: 2.5, maxLevel: 2.5, overflow: true }),
      node('O', 'outfall', { elevation: 3.5 }),
    ],
    edges: [
      { id: 'p1', source: 'R', target: 'V', sourceHandle: 'r', targetHandle: 'in', data: { label: 'p1', props: { ...defaultPipeProps(), diameter: 0.1, length: 10 } } },
      { id: 'p2', source: 'V', target: 'T', sourceHandle: 'out', targetHandle: 'l', data: { label: 'p2', props: { ...defaultPipeProps(), diameter: 0.1, length: 10 } } },
      reach('spill', 'T', 'O', { length: 50, width: 0.4 }),
    ],
  }
  const res = engine.solve(m)
  check('the spillway carries what the pipes bring', res.channel!.reaches.spill.flow, 0.02, 1e-3)
  check('its bed starts at the rim', res.channel!.reaches.spill.bed[0], 2 + 2.5, 1e-9)
}

if (failed) {
  console.error(`${failed} open-channel check(s) failed`)
  process.exit(1)
}
console.log('open-channel checks passed')
