import { engine } from '../src/engine/epanet'
import { FLUIDS } from '../src/model/types'
import { EXPERIMENTS } from '../src/experiments'
await engine.ready()
for (const ex of EXPERIMENTS) {
  const { nodes, edges } = ex.build()
  const r = engine.solve({ nodes, edges, fluid: FLUIDS[0] } as any)
  const flows = Object.entries(r.devices).map(([k, d]) => `${k}:${(d.flow*60000).toFixed(1)}`).join(' ')
  const outs = Object.entries(r.nodes).filter(([,n])=>Math.abs(n.outflow)>1e-9).map(([k, n]) => `${k}:${(n.outflow*60000).toFixed(1)}`).join(' ')
  console.log(ex.no, ex.id, r.ok ? 'ok' : r.error, '| dev', flows, '| out', outs, '| goal', ex.goal?.check(r, nodes, {}).readout, ex.goal?.check(r, nodes, {}).done, '|', r.warnings.map(w => w.text).join('; '))
  if (ex.id==='reynolds') console.log('  Re', r.links.e1.re)
  if (ex.id==='cavitation') console.log('  npsha', r.devices.p.npsha)
  if (ex.id==='prv') console.log('  p2', r.nodes.g2.pressure, r.devices.v.status)
}
