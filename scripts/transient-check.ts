// Water-hammer engine against theory: an instant closure must give Joukowsky's Δp = ρ·a·v, a closure slower than
// 2L/a must give less, and an untouched network must stay exactly steady.
import { engine } from '../src/engine/epanet'
import { runTransient } from '../src/engine/transient'
import { FLUIDS, defaultPipeProps, defaultProps, type Kind, type Model } from '../src/model/types'

await engine.ready()
const node = (id: string, kind: Kind, props = {}) => ({ id, data: { kind, label: id, props: { ...defaultProps(kind), ...props } } })
const pipe = (id: string, s: string, t: string, sh: string, th: string, props = {}) => ({
  id,
  source: s,
  target: t,
  sourceHandle: sh,
  targetHandle: th,
  data: { label: id, props: { ...defaultPipeProps(), ...props } },
})
const model: Model = {
  fluid: FLUIDS[0],
  nodes: [node('R', 'reservoir', { head: 60 }), node('G', 'gauge'), node('V', 'valve', { diameter: 0.05, kOpen: 0.2, body: 'ball' }), node('O', 'outlet', { nozzleDiameter: 0.015 })],
  edges: [
    pipe('main', 'R', 'G', 'r', 'l', { length: 600, diameter: 0.0525, material: 'steel', roughness: 0.045e-3 }),
    pipe('s1', 'G', 'V', 'r', 'in', { length: 1, diameter: 0.0525, material: 'steel' }),
    pipe('s2', 'V', 'O', 'out', 'l', { length: 1, diameter: 0.0525, material: 'steel' }),
  ],
}
const steady = engine.solve(model)
const p0 = steady.nodes.G.pressure
console.log('steady: Q', (steady.devices.V.flow * 60000).toFixed(1), 'L/min  P_G', (p0 / 1000).toFixed(0), 'kPa')
for (const [label, to, duration] of [
  ['no operation', 1, 0],
  ['instant closure', 0, 0],
  ['closure in 0.5 s', 0, 0.5],
  ['closure in 5 s', 0, 5],
  ['closure in 20 s', 0, 20],
] as const) {
  const r = runTransient(model, steady, { id: 'V', start: 0.2, duration, to, runFor: duration + 6 })
  const rise = (r.envelope.G.max - p0) / 1000
  console.log(
    label.padEnd(18),
    r.ok ? '' : r.error,
    'rise',
    rise.toFixed(0),
    'kPa · Joukowsky',
    (r.joukowsky / 1000).toFixed(0),
    '· 2L/a',
    r.criticalTime.toFixed(2),
    's · min',
    (r.envelope.G.min / 1000).toFixed(0),
    'kPa · cav',
    r.cavitated,
    '· dt',
    (r.dt * 1000).toFixed(2),
    'ms',
    r.reaches,
    'reaches',
    r.solveMs.toFixed(0),
    'ms',
  )
}

// the three surge experiments: as delivered they must fail, and the intended fix must pass
import { EXPERIMENTS } from '../src/experiments'
const tryOut = (id: string, label: string, patch: Record<string, object>, ev: { id: string; duration: number; to: number; inertia?: number; runFor: number }) => {
  const ex = EXPERIMENTS.find((e) => e.id === id)!
  const { nodes, edges } = ex.build()
  for (const [nid, p] of Object.entries(patch)) Object.assign(nodes.find((n) => n.id === nid)!.data.props, p)
  const m = { nodes, edges, fluid: FLUIDS[0] } as never
  const st = engine.solve(m)
  const r = runTransient(m, st, { start: 0.5, ...ev })
  console.log(
    ex.no,
    label.padEnd(34),
    ex.goal!.check(st, nodes, {}, [], r),
    'steady Q',
    ((Object.values(st.devices)[0]?.flow ?? 0) * 60000).toFixed(0),
    'L/min · 2L/a',
    r.criticalTime.toFixed(2),
    's ·',
    r.solveMs.toFixed(0),
    'ms',
  )
}
for (const d of [0.5, 5, 15, 30, 60]) tryOut('water-hammer', `close in ${d} s`, {}, { id: 'v', duration: d, to: 0, runFor: d + 8 })
tryOut('surge-vessel', 'slam, 2 L vessel (as delivered)', {}, { id: 'v', duration: 0.1, to: 0, runFor: 10 })
tryOut('surge-vessel', 'slam, 50 L vessel', { sv: { volume: 0.05 } }, { id: 'v', duration: 0.1, to: 0, runFor: 10 })
tryOut('surge-vessel', 'slam, 200 L vessel', { sv: { volume: 0.2 } }, { id: 'v', duration: 0.1, to: 0, runFor: 10 })
for (const i of [0.5, 2, 5, 10]) tryOut('pump-trip', `trip, speed halves in ${i} s`, {}, { id: 'p', duration: 0, to: 0, inertia: i, runFor: 25 })

// a tee with losses: the wave engine must start in equilibrium with it (no drift), and still see the hammer through it
{
  const m: Model = {
    fluid: FLUIDS[0],
    nodes: [
      node('R', 'reservoir', { head: 40 }),
      node('T', 'tee', { diameter: 0.04 }),
      node('A', 'outlet', { mode: 'demand', demand: 0.001 }),
      node('V', 'valve', { diameter: 0.04 }),
      node('B', 'outlet', { nozzleDiameter: 0.02 }),
    ],
    edges: [
      pipe('p0', 'R', 'T', 'r', 'l', { length: 200, material: 'steel' }),
      pipe('p1', 'T', 'A', 'r', 'l', { length: 30 }),
      pipe('p2', 'T', 'V', 'b', 'in', { length: 100, material: 'steel' }),
      pipe('p3', 'V', 'B', 'out', 'l', { length: 1 }),
    ],
  }
  const st = engine.solve(m)
  const idle = runTransient(m, st, { id: 'V', start: 0.5, duration: 1, to: 1, runFor: 4 })
  const slam = runTransient(m, st, { id: 'V', start: 0.5, duration: 0.05, to: 0, runFor: 4 })
  const riseOf = (r: typeof idle) => r.peak.pressure - r.series[r.peak.key][0]
  const ok = idle.ok && slam.ok && riseOf(idle) < 2000 && riseOf(slam) > 0.5 * slam.joukowsky
  console.log(`tee        ${ok}  idle drift ${(riseOf(idle) / 1000).toFixed(2)} kPa · slam rise ${(riseOf(slam) / 1000).toFixed(0)} kPa (Joukowsky ${(slam.joukowsky / 1000).toFixed(0)})`)
  if (!ok) process.exit(1)
}
