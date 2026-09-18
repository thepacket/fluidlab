import { engine } from '../src/engine/epanet'
import { FLUIDS } from '../src/model/types'
import { EXPERIMENTS } from '../src/experiments'
await engine.ready()
for (const ex of EXPERIMENTS) {
  const { nodes, edges } = ex.build()
  const r = engine.solve({ nodes, edges, fluid: FLUIDS[0] } as any)
  const flows = Object.entries(r.devices)
    .map(([k, d]) => `${k}:${(d.flow * 60000).toFixed(1)}`)
    .join(' ')
  const outs = Object.entries(r.nodes)
    .filter(([, n]) => Math.abs(n.outflow) > 1e-9)
    .map(([k, n]) => `${k}:${(n.outflow * 60000).toFixed(1)}`)
    .join(' ')
  console.log(
    ex.no,
    ex.id,
    r.ok ? 'ok' : r.error,
    '| dev',
    flows,
    '| out',
    outs,
    '| goal',
    ex.goal?.check(r, nodes, {}, []).readout,
    ex.goal?.check(r, nodes, {}, []).done,
    '|',
    r.warnings.map((w) => w.text).join('; '),
  )
  if (ex.id === 'reynolds') console.log('  Re', r.links.e1.re)
  if (ex.id === 'cavitation') console.log('  npsha', r.devices.p.npsha)
  if (ex.id === 'venturi')
    for (const o of [1, 0.7, 0.6, 0.55, 0.5]) {
      nodes.find((n) => n.id === 'v')!.data.props.opening = o
      const rr = engine.solve({ nodes, edges, fluid: FLUIDS[0] } as any)
      console.log('  open', o, 'tap kPa', (rr.devices.fe.tapDp! / 1000).toFixed(2), 'Q', (rr.devices.fe.flow * 60000).toFixed(1))
    }
  if (ex.id === 'orifice') {
    console.log('  tap', r.devices.fe.tapDp, 'Q', r.devices.fe.flow * 60000)
    nodes.find((n) => n.id === 'fe')!.data.props.elementType = 'venturi'
    nodes.find((n) => n.id === 'fe')!.data.props.cd = 0.98
    const rr = engine.solve({ nodes, edges, fluid: FLUIDS[0] } as any)
    console.log('  as venturi', ex.goal!.check(rr, nodes, {}, []))
  }
  if (ex.id === 'siphon')
    for (const z of [8, 10, 11, 12, 13]) {
      nodes.find((n) => n.id === 'crest')!.data.props.elevation = z
      const rr = engine.solve({ nodes, edges, fluid: FLUIDS[0] } as any)
      console.log(
        '  z',
        z,
        ex.goal!.check(rr, nodes, {}, []),
        rr.warnings.map((w) => w.text),
      )
    }
  const again = (label: string) => {
    const rr = engine.solve({ nodes, edges, fluid: FLUIDS[0] } as any)
    console.log('  ' + label, ex.goal!.check(rr, nodes, {}, []), 'Q', ((rr.devices.p ?? rr.devices.m)?.flow * 60000).toFixed(0), 'vent', ((rr.nodes.rv?.outflow ?? 0) * 60000).toFixed(0))
  }
  const prop = (id: string) => nodes.find((n) => n.id === id)!.data.props
  if (ex.id === 'fittings') {
    for (const n of nodes) if (n.data.kind === 'fitting') Object.assign(n.data.props, { variant: 'elbow90lr', k: 0.45 })
    again('long-radius')
  }
  if (ex.id === 'strainer')
    for (const f of [0.3, 0.5, 0.55, 0.6, 0.65, 0.7]) {
      prop('st').fouling = f
      again('fouling ' + f)
    }
  if (ex.id === 'relief')
    for (const [o, set] of [
      [0, 900e3],
      [0, 300e3],
    ]) {
      prop('v').opening = o
      prop('rv').setPressure = set
      again(`open ${o} set ${set / 1000}`)
    }
  if (ex.id === 'sprinklers')
    for (const d of [0.0351, 0.0409]) {
      for (const e of edges) if (e.data?.label.startsWith('Branch')) e.data.props.diameter = d
      again('branch ' + d * 1000 + ' mm')
    }
  if (ex.id === 'fire-pump')
    for (const [type, o] of [['standard', 0.2], ['standard', 0.24], ['standard', 0.27], ['fire', 0.2], ['fire', 0.22], ['fire', 0.24]] as const) {
      Object.assign(prop('p'), type === 'fire' ? { pumpType: 'fire', shutoffRatio: 1.2, runoutRatio: 2.2 } : {})
      prop('v').opening = o
      again(`${type} valve ${o}`)
    }
  if (ex.id === 'lateral')
    for (const d of [0.0171, 0.0219]) {
      for (const e of edges) if (e.data?.label.startsWith('Lateral')) e.data.props.diameter = d
      again('lateral ' + d * 1000 + ' mm')
    }
  if (ex.id === 'hydronic')
    for (const o of [0.2, 0.15, 0.12, 0.1, 0.08]) {
      prop('bv1').opening = o
      again('BV1 ' + o)
    }
  if (ex.id === 'prv') console.log('  p2', r.nodes.g2.pressure, r.devices.v.status)
}
