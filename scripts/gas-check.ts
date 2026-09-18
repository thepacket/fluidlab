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
