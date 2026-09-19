// Gas engine against hand calculations.
import { engine } from '../src/engine/epanet'
import { orificeFlow, rhoStd, zrt } from '../src/engine/gas'
import { area, frictionFactor } from '../src/model/physics'
import { FLUIDS, defaultPipeProps, defaultProps, type Kind, type Model } from '../src/model/types'

await engine.ready()
const air = FLUIDS.find((f) => f.id === 'air')!
const node = (id: string, kind: Kind, props = {}) => ({ id, data: { kind, label: id, props: { ...defaultProps(kind), ...props } } })
const pipe = (id: string, s: string, t: string, sh: string, th: string, props = {}) => ({
  id,
  source: s,
  target: t,
  sourceHandle: sh,
  targetHandle: th,
  data: { label: id, props: { ...defaultPipeProps(), ...props } },
})

// 1. one pipe, fixed demand: compare p2 with the isothermal formula
{
  const L = 200,
    D = 0.025,
    q = 60 / 3600 // 60 Sm³/h
  const m: Model = {
    fluid: air,
    nodes: [node('S', 'reservoir', { pressure: 700e3 }), node('J', 'junction', { demand: q })],
    edges: [pipe('p', 'S', 'J', 'r', 'l', { length: L, diameter: D, material: 'steel', roughness: 0.045e-3 })],
  }
  const r = engine.solve(m)
  const mdot = q * rhoStd(air)
  const re = (4 * mdot) / (Math.PI * D * air.dynamicViscosity)
  const f = frictionFactor(re, 0.045e-3 / D)
  const p1 = 700e3 + 101325
  const p2 = Math.sqrt(p1 * p1 - ((f * L) / D) * (mdot / area(D)) ** 2 * zrt(air))
  console.log(
    'pipe      ',
    r.ok,
    r.error ?? '',
    'solver',
    ((r.nodes.J.pressure + 101325) / 1000).toFixed(2),
    'kPa abs · formula',
    (p2 / 1000).toFixed(2),
    '· incompressible would say',
    ((p1 - (((f * L) / D) * (mdot / area(D)) ** 2 * zrt(air)) / (2 * p1)) / 1000).toFixed(2),
    '·',
    r.solveMs.toFixed(1),
    'ms',
  )
}
// 2. choked nozzle on a 600 kPa main: flow must match the sonic formula and ignore the back-pressure
{
  const m: Model = {
    fluid: air,
    nodes: [node('S', 'reservoir', { pressure: 600e3 }), node('O', 'outlet', { nozzleDiameter: 0.004, cd: 0.9 })],
    edges: [pipe('p', 'S', 'O', 'r', 'l', { length: 1, diameter: 0.05 })],
  }
  const r = engine.solve(m)
  const pUp = r.nodes.O.pressure + 101325
  console.log(
    'nozzle    ',
    r.ok,
    'solver',
    (r.nodes.O.outflow * 3600).toFixed(2),
    'Sm³/h · formula',
    ((orificeFlow(0.9 * area(0.004), pUp, 101325, air).mdot / rhoStd(air)) * 3600).toFixed(2),
    r.warnings.map((w) => w.text.slice(0, 22)),
  )
}
// 3. compressor → receiver-less ring with a regulator: mass balance and regulator droop
{
  const m: Model = {
    fluid: air,
    nodes: [
      node('A', 'reservoir', { pressure: 0 }),
      node('C', 'pump', { designFlow: 120 / 3600, pressureRatio: 8 }),
      node('R', 'valve', { valveType: 'prv', pressureSetting: 600e3, diameter: 0.025, kOpen: 2 }),
      node('G', 'gauge'),
      node('T1', 'outlet', { nozzleDiameter: 0.003 }),
      node('T2', 'junction', { demand: 30 / 3600 }),
    ],
    edges: [
      pipe('a', 'A', 'C', 'r', 'in', { length: 1, diameter: 0.05 }),
      pipe('b', 'C', 'R', 'out', 'in', { length: 5, diameter: 0.025 }),
      pipe('c', 'R', 'G', 'out', 'l', { length: 30, diameter: 0.025 }),
      pipe('d', 'G', 'T1', 'r', 'l', { length: 10, diameter: 0.015 }),
      pipe('e', 'G', 'T2', 'b', 'l', { length: 10, diameter: 0.015 }),
    ],
  }
  const r = engine.solve(m)
  console.log(
    'compressor',
    r.ok,
    r.error ?? '',
    'delivers',
    (r.devices.C.flow * 3600).toFixed(1),
    'Sm³/h at ratio',
    r.devices.C.ratio?.toFixed(2),
    '· users take',
    ((r.nodes.T1.outflow + r.nodes.T2.outflow) * 3600).toFixed(1),
    '· after regulator',
    (r.devices.R.pOut / 1000).toFixed(0),
    'kPa (set 600) · shaft',
    (r.devices.C.shaftPower! / 1000).toFixed(1),
    'kW ·',
    r.solveMs.toFixed(1),
    'ms',
  )
}

// 4. a tee's branch loss: across the branch port, p_hub² − p_port² = K·ṁ²·ZRT / A²
{
  const m: Model = {
    fluid: air,
    nodes: [
      node('S', 'reservoir', { pressure: 600e3 }),
      node('T', 'tee', { diameter: 0.04, kRun: 0.4, kBranch: 1 }),
      node('A', 'outlet', { mode: 'demand', demand: 40 / 3600 }),
      node('B', 'outlet', { mode: 'demand', demand: 60 / 3600 }),
    ],
    edges: [pipe('p0', 'S', 'T', 'r', 'l', { length: 20 }), pipe('p1', 'T', 'A', 'r', 'l', { length: 20 }), pipe('p2', 'T', 'B', 'b', 'l', { length: 20 })],
  }
  const r = engine.solve(m)
  const got = (r.nodes.T.pressure + 101325) ** 2 - (r.links.p2.pStart + 101325) ** 2
  const want = (((60 / 3600) * rhoStd(air)) ** 2 * zrt(air)) / area(0.04) ** 2
  const ok = r.ok && Math.abs(got - want) / want < 0.02
  console.log(`tee        ${ok}  branch loss ${got.toExponential(3)} Pa² · formula ${want.toExponential(3)}`)
  if (!ok) process.exit(1)
}

// 5. a riser with nothing flowing: natural gas is lighter than the air outside, so its gauge pressure climbs with height
{
  const gas = FLUIDS.find((f) => f.id === 'natgas')!
  const m: Model = {
    fluid: gas,
    nodes: [node('S', 'reservoir', { pressure: 2000, elevation: 0 }), node('Top', 'junction', { elevation: 30, demand: 0 })],
    edges: [pipe('riser', 'S', 'Top', 'r', 'l', { length: 30, diameter: 0.05 })],
  }
  const r = engine.solve(m)
  const want = 2000 + (1.204 - (101325 + 2000) / zrt(gas)) * 9.80665 * 30
  const ok = r.ok && Math.abs(r.nodes.Top.pressure - want) < 2
  console.log(`riser      ${ok}  top of a 30 m riser ${r.nodes.Top.pressure.toFixed(1)} Pa · hand calculation ${want.toFixed(1)} Pa (2000 at the bottom)`)
  if (!ok) process.exit(1)
}

// 6. an air ejector: compressed air entrains air from the room and delivers it against a small back-pressure; the
//    operating point must sit on Cunningham's characteristic, with the motive nozzle choked
{
  const m: Model = {
    fluid: air,
    nodes: [
      node('M', 'reservoir', { pressure: 500e3 }),
      node('Room', 'reservoir', { pressure: 0 }),
      node('E', 'jetpump', { nozzleDiameter: 0.004, throatDiameter: 0.012 }),
      node('Out', 'outlet', { nozzleDiameter: 0.014, cd: 0.9 }),
    ],
    edges: [
      pipe('pm', 'M', 'E', 'r', 'm', { length: 2, diameter: 0.015 }),
      pipe('ps', 'Room', 'E', 'r', 's', { length: 1, diameter: 0.04 }),
      pipe('pd', 'E', 'Out', 'd', 'l', { length: 2, diameter: 0.04 }),
    ],
  }
  const r = engine.solve(m)
  const x = r.nodes.E.extra!
  const ok = r.ok && x.q2 > 0 && x.M > 0.2 && x.N > 0.005 && Math.abs(x.N - x.Nmodel) < 0.02 * x.Nmodel && Math.abs(r.nodes.Out.outflow - (x.q1 + x.q2)) < 1e-6
  console.log(
    `ejector    ${ok}  motive ${(x.q1 * 3600).toFixed(1)} Sm³/h entrains ${(x.q2 * 3600).toFixed(1)} (M ${x.M.toFixed(2)}) · N ${x.N.toFixed(4)} vs model ${x.Nmodel.toFixed(4)}`,
    r.warnings.map((w) => w.text.slice(0, 40)),
  )
  if (!ok) process.exit(1)
}

// 7. linepack: a charged main cut off from its supply, still feeding a user, loses pressure at ṁ·ZRT/V — and the
//    implicit step must conserve gas exactly whatever its size
{
  const L = 2000
  const D = 0.1
  const q = 100 / 3600
  const m: Model = {
    fluid: air,
    nodes: [node('A', 'junction'), node('B', 'junction', { demand: q })],
    edges: [pipe('main', 'A', 'B', 'r', 'l', { length: L, diameter: D })],
  }
  const V = area(D) * L
  let levels: Record<string, number> = { 'A:line': 601325, 'B:line': 601325 }
  const mass = (lv: Record<string, number>) => ((lv['A:line'] + lv['B:line']) * (V / 2)) / zrt(air)
  const m0 = mass(levels)
  let ok = true
  for (let step = 0; step < 10; step++) {
    const r = engine.solve({ ...m, levels, lineDt: 30 })
    ok &&= r.ok
    levels = { 'A:line': r.nodes.A.pressure + 101325, 'B:line': r.nodes.B.pressure + 101325 }
  }
  const drawn = q * rhoStd(air) * 300
  const good = ok && Math.abs(m0 - mass(levels) - drawn) / drawn < 1e-3
  console.log(
    `linepack   ${good}  300 s of draw-off took ${(m0 - mass(levels)).toFixed(3)} kg out of the main · the user drew ${drawn.toFixed(3)} kg · now ${((levels['B:line'] - 101325) / 1000).toFixed(1)} kPa`,
  )
  if (!good) process.exit(1)
  // with its supply back, the same marching must end on the steady answer
  const fed: Model = { ...m, nodes: [node('S', 'reservoir', { pressure: 500e3 }), ...m.nodes], edges: [pipe('feed', 'S', 'A', 'r', 'l', { length: 500, diameter: D }), ...m.edges] }
  const steady = engine.solve(fed)
  for (let step = 0; step < 40; step++) {
    const r = engine.solve({ ...fed, levels, lineDt: 60 })
    levels = { 'A:line': r.nodes.A.pressure + 101325, 'B:line': r.nodes.B.pressure + 101325 }
  }
  const settled = Math.abs(levels['B:line'] - 101325 - steady.nodes.B.pressure) < 50
  console.log(`linepack   ${settled}  re-fed, it settles on the steady pressure: ${((levels['B:line'] - 101325) / 1000).toFixed(2)} vs ${(steady.nodes.B.pressure / 1000).toFixed(2)} kPa`)
  if (!settled) process.exit(1)
}
