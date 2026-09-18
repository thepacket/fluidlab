// Quasi-steady run of the "Timed pumping" rig, to sanity-check that its goal is reachable.
import { engine } from '../src/engine/epanet'
import { EXPERIMENTS } from '../src/experiments'
import { computeControls } from '../src/model/control'
import { FLUIDS } from '../src/model/types'

await engine.ready()
const ex = EXPERIMENTS.find((e) => e.id === 'timer')!
for (const [on, off] of [
  [600, 600],
  [180, 180],
  [150, 210],
  [120, 240],
]) {
  const { nodes, edges } = ex.build()
  Object.assign(nodes.find((n) => n.id === 'tm')!.data.props, { onTime: on, offTime: off })
  let level = 1.2,
    lo = 9,
    hi = 0,
    qin = 0,
    qout = 0
  for (let t = 0; t < 3600; t += 6) {
    const r = engine.solve({ nodes, edges, fluid: FLUIDS[0], levels: { t: level }, controls: computeControls(nodes, edges, t) } as never)
    level = Math.min(2.4, Math.max(0, level + (r.nodes.t.outflow * 6) / (Math.PI / 4)))
    if (t > 1200) {
      lo = Math.min(lo, level)
      hi = Math.max(hi, level)
    }
    qin = Math.max(qin, r.devices.p.flow * 60000)
    qout = r.devices.v.flow * 60000
  }
  console.log(`on ${on}s off ${off}s → level ${((lo / 2.4) * 100).toFixed(0)}–${((hi / 2.4) * 100).toFixed(0)} %  (pump ${qin.toFixed(0)} L/min, demand ${qout.toFixed(0)} L/min)`)
}
