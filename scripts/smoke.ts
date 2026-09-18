import { engine } from '../src/engine/epanet'
import { FLUIDS, defaultProps, defaultPipeProps, type Model, type Kind } from '../src/model/types'
import { compile } from '../src/engine/inp'

const node = (id: string, kind: Kind, props = {}) => ({ id, data: { kind, label: id, props: { ...defaultProps(kind), ...props } } })
const pipe = (id: string, s: string, t: string, sh?: string, th?: string, props = {}) => ({
  id,
  source: s,
  target: t,
  sourceHandle: sh,
  targetHandle: th,
  data: { label: id, props: { ...defaultPipeProps(), ...props } },
})

await engine.ready()
for (const opening of [1, 0.5, 0.2, 0]) {
  const m: Model = {
    fluid: FLUIDS[0],
    nodes: [
      node('R', 'reservoir', { head: 2 }),
      node('PU', 'pump'),
      node('V', 'valve', { opening }),
      node('O', 'outlet'),
      node('T', 'tank', { initLevel: 2.5 }),
      node('J', 'junction'),
      node('lonely', 'junction'),
    ],
    edges: [pipe('p1', 'R', 'PU', 'r', 'in'), pipe('p2', 'PU', 'V', 'out', 'in'), pipe('p3', 'V', 'J', 'out', 'l'), pipe('p4', 'J', 'O'), pipe('p5', 'J', 'T')],
  }
  if (opening === 1) console.log(compile(m).inp)
  const r = engine.solve(m)
  console.log(
    opening,
    r.ok,
    r.error,
    'Q L/min',
    (r.devices.PU?.flow * 60000).toFixed(2),
    'dH',
    r.devices.PU?.dH.toFixed(2),
    'valve dH',
    r.devices.V?.dH.toFixed(2),
    'out',
    (r.nodes.O?.outflow * 60000).toFixed(2),
    'tank in',
    (r.nodes.T?.outflow * 60000).toFixed(2),
    'res',
    (r.nodes.R?.outflow * 60000).toFixed(2),
    r.solveMs.toFixed(1) + 'ms',
    r.warnings.map((w) => w.text),
  )
}

// differential gauge + venturi: taps either side of a valve, one DP gauge left half-wired
{
  const m: Model = {
    fluid: FLUIDS[0],
    nodes: [
      node('R', 'reservoir', { head: 10 }),
      node('A', 'junction'),
      node('FE', 'element'),
      node('V', 'valve', { opening: 0.4 }),
      node('B', 'junction'),
      node('O', 'outlet'),
      node('DP', 'dpgauge'),
      node('DP2', 'dpgauge'),
    ],
    edges: [
      pipe('p1', 'R', 'A'),
      pipe('p2', 'A', 'FE', 'r', 'in'),
      pipe('p3', 'FE', 'V', 'out', 'in'),
      pipe('p4', 'V', 'B', 'out', 'l'),
      pipe('p5', 'B', 'O'),
      pipe('s1', 'A', 'DP', 't', 'in'),
      pipe('s2', 'B', 'DP', 't', 'out'),
      pipe('s3', 'A', 'DP2', 't', 'in'),
    ],
  }
  const r = engine.solve(m)
  const dp = r.devices.DP
  console.log(
    'dp gauge',
    r.ok,
    r.error,
    'ΔP kPa',
    ((dp.pIn - dp.pOut) / 1000).toFixed(2),
    'A-B kPa',
    ((r.nodes.A.pressure - r.nodes.B.pressure) / 1000).toFixed(2),
    'venturi tap kPa',
    (r.devices.FE.tapDp! / 1000).toFixed(2),
    'loss kPa',
    (r.devices.FE.permanentLoss! / 1000).toFixed(2),
    'Q',
    (r.devices.FE.flow * 60000).toFixed(1),
    'inferred',
    (r.devices.FE.inferredFlow! * 60000).toFixed(1),
    'excluded',
    r.excluded,
  )
}

// timer → pump over a signal wire: the command must override the pump's own switch
{
  const { computeControls, timerState } = await import('../src/model/control')
  const nodes = [node('R', 'reservoir', { head: 2 }), node('PU', 'pump'), node('O', 'outlet'), node('TM', 'timer', { onTime: 60, offTime: 120, startOn: false })]
  const edges = [pipe('p1', 'R', 'PU', 'r', 'in'), pipe('p2', 'PU', 'O', 'out', 'l'), { id: 's1', type: 'signal', source: 'TM', target: 'PU', sourceHandle: 'sig', targetHandle: 'ctl' }]
  for (const t of [0, 119, 120, 179, 180, 300]) {
    const controls = computeControls(nodes, edges, t)
    const r = engine.solve({ fluid: FLUIDS[0], nodes, edges, controls })
    console.log('timer t=' + t, timerState(nodes[3].data.props, t), 'pump L/min', (r.devices.PU.flow * 60000).toFixed(1), r.ok, r.excluded)
  }
}

// catalogue devices: a K fitting, a fouled rated strainer (GPV curve), and a relief valve on a dead-headed pump
{
  const mk = (fouling: number, open: number, set: number): Model => ({
    fluid: FLUIDS[0],
    nodes: [
      node('R', 'reservoir', { head: 2 }),
      node('ST', 'fitting', { variant: 'strainer', ratedDp: 8e3, ratedFlow: 0.001, exponent: 2, fouling }),
      node('PU', 'pump'),
      node('EL', 'fitting', { variant: 'elbow90', k: 0.75 }),
      node('J', 'junction'),
      node('RV', 'relief', { setPressure: set }),
      node('V', 'valve', { opening: open }),
      node('O', 'outlet'),
    ],
    edges: [
      pipe('p1', 'R', 'ST', 'r', 'in'),
      pipe('p2', 'ST', 'PU', 'out', 'in'),
      pipe('p3', 'PU', 'EL', 'out', 'in'),
      pipe('p4', 'EL', 'J', 'out', 'l'),
      pipe('p5', 'J', 'RV', 't', 'l'),
      pipe('p6', 'J', 'V', 'r', 'in'),
      pipe('p7', 'V', 'O', 'out', 'l'),
    ],
  })
  for (const [f, o, set] of [
    [0, 1, 400e3],
    [0.7, 1, 400e3],
    [0, 0, 400e3],
    [0, 0, 150e3],
  ] as const) {
    const r = engine.solve(mk(f, o, set))
    const st = r.devices.ST
    console.log(
      `loss fouling ${f} valve ${o} set ${set / 1000}kPa →`,
      r.ok,
      r.error ?? '',
      'Q',
      (r.devices.PU.flow * 60000).toFixed(1),
      'strainer dP kPa',
      ((st.pIn - st.pOut) / 1000).toFixed(2),
      'elbow dP',
      ((r.devices.EL.pIn - r.devices.EL.pOut) / 1000).toFixed(2),
      'P_J',
      (r.nodes.J.pressure / 1000).toFixed(0),
      'relief L/min',
      (r.nodes.RV.outflow * 60000).toFixed(1),
    )
  }
}

// sources: a mains connection quoted in pressure, and a well whose level is drawn down by what is pumped
{
  const mains: Model = {
    fluid: FLUIDS[0],
    nodes: [node('M', 'reservoir', { sourceType: 'mains', pressure: 350e3, elevation: 2 }), node('G', 'gauge', { elevation: 2 }), node('O', 'outlet')],
    edges: [pipe('p1', 'M', 'G', 'r', 'l', { length: 0.5 }), pipe('p2', 'G', 'O', 'r', 'l')],
  }
  const rm = engine.solve(mains)
  console.log(
    'mains',
    rm.ok,
    rm.error ?? '',
    'P at source',
    (rm.nodes.M.pressure / 1000).toFixed(0),
    'kPa · gauge',
    (rm.nodes.G.pressure / 1000).toFixed(0),
    'kPa · pipe pStart',
    (rm.links.p1.pStart / 1000).toFixed(0),
  )
  const well: Model = {
    fluid: FLUIDS[0],
    nodes: [node('W', 'reservoir', { sourceType: 'well', staticLevel: -8, ratedDrawdown: 6, ratedYield: 0.001 }), node('PU', 'pump', { elevation: -20, designHead: 40 }), node('O', 'outlet')],
    edges: [pipe('p1', 'W', 'PU', 'r', 'in', { length: 2 }), pipe('p2', 'PU', 'O', 'out', 'l', { length: 30 })],
  }
  const rw = engine.solve(well)
  console.log(
    'well ',
    rw.ok,
    rw.error ?? '',
    'Q',
    (rw.devices.PU.flow * 60000).toFixed(1),
    'L/min · pumping level',
    rw.nodes.W.head.toFixed(2),
    'm (static −8) · supplied',
    (rw.nodes.W.outflow * 60000).toFixed(1),
  )
  const spill: Model = {
    fluid: FLUIDS[0],
    levels: { T: 2.5 },
    nodes: [node('R', 'reservoir', { head: 20 }), node('T', 'tank', { overflow: true, initLevel: 2.5 }), node('T2', 'tank', { initLevel: 2.5 })],
    edges: [pipe('p1', 'R', 'T', 'r', 'l'), pipe('p2', 'R', 'T2', 'r', 'l')],
  }
  const rs = engine.solve(spill)
  console.log(
    'tanks',
    rs.ok,
    'with overflow takes',
    (rs.nodes.T.outflow * 60000).toFixed(0),
    'L/min · without takes',
    (rs.nodes.T2.outflow * 60000).toFixed(0),
    rs.warnings.map((w) => w.text),
  )
}
