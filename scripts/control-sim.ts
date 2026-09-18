// Closed-loop runs of the control experiments, stepping exactly as the app's tick does:
// solve → controller scan → integrate tanks. Used to check each goal is reachable (and not trivially met).
import { engine } from '../src/engine/epanet'
import { EXPERIMENTS, type LabNode } from '../src/experiments'
import { receiverRate } from '../src/engine/gas'
import { EMPTY_CONTROL, stepControl } from '../src/model/control'
import { VESSEL_FILL_LIMIT, tankLevel, tankVolume, vesselWater } from '../src/model/physics'
import { EMPTY_RESULTS, FLUIDS, type Props, type Results } from '../src/model/types'

await engine.ready()

function run(id: string, patch: Record<string, Props>, seconds: number, dt: number) {
  const ex = EXPERIMENTS.find((e) => e.id === id)!
  const { nodes, edges } = ex.build()
  for (const [nid, p] of Object.entries(patch)) Object.assign(nodes.find((n) => n.id === nid)!.data.props, p)
  const levels: Record<string, number> = {}
  const fluid = FLUIDS.find((f) => f.id === ex.fluidId) ?? FLUIDS[0]
  const history: { t: number; v: Record<string, number> }[] = []
  let ctrl = EMPTY_CONTROL
  let results: Results = EMPTY_RESULTS
  let starts = 0
  for (let t = 0; t < seconds; t += dt) {
    results = engine.solve({ nodes, edges, fluid, levels, controls: ctrl.commands, time: Math.floor(t / 60) * 60 } as never)
    const before = ctrl
    ctrl = stepControl({ nodes, edges, t: t + dt, dt, results, levels, prev: ctrl })
    for (const n of nodes as LabNode[]) {
      const p = n.data.props
      const q = results.nodes[n.id]?.outflow ?? 0
      if (n.data.kind === 'vessel' && fluid.gas) levels[`${n.id}:gas`] = Math.max(101325, (levels[`${n.id}:gas`] ?? 101325 + p.initPressure) + receiverRate(fluid, p.volume, q) * dt)
      else if (n.data.kind === 'vessel') levels[n.id] = Math.min(p.volume * VESSEL_FILL_LIMIT, Math.max(0, (levels[n.id] ?? vesselWater(p, p.initPressure)) + q * dt))
      if (n.data.kind === 'tank') levels[n.id] = Math.max(p.minLevel, tankLevel(p, tankVolume(p, levels[n.id] ?? p.initLevel) + q * dt))
    }
    if ((ctrl.commands.p ?? 0) >= 0.5 && (before.commands.p ?? 0) < 0.5) starts++
    const v: Record<string, number> = { ...levels }
    for (const n of nodes) {
      if (results.nodes[n.id] && n.data.kind !== 'tank') v[n.id] = results.nodes[n.id].pressure
      if (results.devices[n.id]) v[n.id] = results.devices[n.id].flow
    }
    history.push({ t: t + dt, v })
  }
  const g = ex.goal!.check(results, nodes, levels, history.slice(-600))
  return { done: g.done, readout: g.readout, starts }
}

if (process.argv[2] === 'grid') {
  for (const kp of [0.05, 0.1, 0.2, 0.3, 0.45]) for (const ti of [1, 2, 4, 8, 20, 60]) console.log('kp', kp, 'ti', ti, run('pressure-pid', { pic: { kp, ti } }, 900, 1).readout)
  process.exit(0)
}
console.log('17 level switch, as delivered      ', run('level-switch', {}, 3600, 6))
console.log('17 level switch, 45–65 %           ', run('level-switch', { ls: { low: 1.08, high: 1.56 } }, 3600, 6))
console.log('18 pressure PID, as delivered      ', run('pressure-pid', {}, 900, 1))
console.log('18 pressure PID, Kp 0.3 Ti 1       ', run('pressure-pid', { pic: { kp: 0.3, ti: 1 } }, 900, 1))
console.log('18 pressure PID, Kp 4 Ti 1 (hunts?)', run('pressure-pid', { pic: { kp: 4, ti: 1 } }, 900, 1))
console.log('19 flow PID, left in manual        ', run('flow-pid', {}, 600, 1))
console.log('19 flow PID, auto as delivered     ', run('flow-pid', { fic: { auto: true } }, 600, 1))
console.log('19 flow PID, auto Kp 3 Ti 2        ', run('flow-pid', { fic: { auto: true, kp: 3, ti: 2 } }, 600, 1))
console.log('23 vessel, as delivered (24 L)     ', run('vessel', {}, 1500, 2))
console.log('23 vessel, 300 L, pre-charge 180   ', run('vessel', { pv: { volume: 0.3, precharge: 180e3 } }, 1500, 2))
console.log('26 float valve, as delivered       ', run('float-valve', {}, 7200, 6))
console.log('26 float valve, shuts at 1.8 m     ', run('float-valve', { fv: { closeLevel: 1.8 } }, 7200, 6))
console.log('35 booster, one pump wired         ', run('booster', {}, 900, 1))
{
  const ex = EXPERIMENTS.find((e) => e.id === 'booster')!
  const original = ex.build
  ex.build = () => {
    const rig = original()
    for (const id of ['p2', 'p3']) rig.edges.push({ id: `sx${id}`, type: 'signal', source: 'sq', sourceHandle: 'sig', target: id, targetHandle: 'ctl' })
    return rig
  }
  console.log('35 booster, all three wired        ', run('booster', {}, 900, 1))
  if (process.argv[2] === 'booster') for (const kp of [0.3, 0.5]) for (const ti of [0.5, 1]) console.log('   kp', kp, 'ti', ti, run('booster', { pic: { kp, ti } }, 900, 1).readout)
}
{
  // 37: the receiver must cycle between the switch's thresholds with the compressor loading and unloading
  const ex = EXPERIMENTS.find((e) => e.id === 'air-main')!
  const original = ex.goal!.check
  let lo = Infinity
  let hi = 0
  ex.goal!.check = (r, n, l, h) => {
    for (const s of h) {
      lo = Math.min(lo, s.v['rx'] ?? Infinity)
      hi = Math.max(hi, s.v['rx'] ?? 0)
    }
    return original(r, n, l, h)
  }
  const out = run('air-main', {}, 600, 1)
  console.log('37 air main, closed loop           ', out, 'receiver swings', (lo / 1000).toFixed(0), '–', (hi / 1000).toFixed(0), 'kPa')
}
