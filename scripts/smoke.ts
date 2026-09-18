import { engine } from '../src/engine/epanet'
import { FLUIDS, defaultProps, defaultPipeProps, type Model, type Kind } from '../src/model/types'
import { compile } from '../src/engine/inp'

const node = (id: string, kind: Kind, props = {}) => ({ id, data: { kind, label: id, props: { ...defaultProps(kind), ...props } } })
const pipe = (id: string, s: string, t: string, sh?: string, th?: string, props = {}) => ({ id, source: s, target: t, sourceHandle: sh, targetHandle: th, data: { label: id, props: { ...defaultPipeProps(), ...props } } })

await engine.ready()
for (const opening of [1, 0.5, 0.2, 0]) {
  const m: Model = {
    fluid: FLUIDS[0],
    nodes: [node('R', 'reservoir', { head: 2 }), node('PU', 'pump'), node('V', 'valve', { opening }), node('O', 'outlet'), node('T', 'tank', { initLevel: 2.5 }), node('J','junction'), node('lonely', 'junction')],
    edges: [pipe('p1', 'R', 'PU', 'r', 'in'), pipe('p2', 'PU', 'V', 'out', 'in'), pipe('p3', 'V', 'J', 'out', 'l'), pipe('p4','J','O'), pipe('p5','J','T')],
  }
  if (opening === 1) console.log(compile(m).inp)
  const r = engine.solve(m)
  console.log(opening, r.ok, r.error, 'Q L/min', (r.devices.PU?.flow * 60000).toFixed(2), 'dH', r.devices.PU?.dH.toFixed(2), 'valve dH', r.devices.V?.dH.toFixed(2), 'out', (r.nodes.O?.outflow*60000).toFixed(2), 'tank in', (r.nodes.T?.outflow*60000).toFixed(2), 'res', (r.nodes.R?.outflow*60000).toFixed(2), r.solveMs.toFixed(1)+'ms', r.warnings.map(w=>w.text))
}
