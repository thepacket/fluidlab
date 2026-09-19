// Steam engine against steam tables and hand calculations.
import { engine } from '../src/engine/epanet'
import { area, frictionFactor, P_ATM } from '../src/model/physics'
import { flashFraction, hfg, pipeHeatLoss, rhoSteam, tSat, throttledTemp } from '../src/model/steam'
import { FLUIDS, defaultPipeProps, defaultProps, type Kind, type Model } from '../src/model/types'

await engine.ready()
const steam = FLUIDS.find((f) => f.id === 'steam')!
const node = (id: string, kind: Kind, props = {}) => ({ id, data: { kind, label: id, props: { ...defaultProps(kind), ...props } } })
const pipe = (id: string, s: string, t: string, props = {}, sh = 'r', th = 'l') => ({
  id,
  source: s,
  target: t,
  sourceHandle: sh,
  targetHandle: th,
  data: { label: id, props: { ...defaultPipeProps(), material: 'steel', roughness: 0.045e-3, ...props } },
})
let failed = 0
const check = (name: string, got: number, want: number, tol = 0.01) => {
  const ok = Math.abs(got - want) <= tol * Math.max(Math.abs(want), 1e-9)
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}: ${got.toPrecision(5)} (expected ${want.toPrecision(5)})`)
}

// 1. properties
check('t_sat at 7 bar abs', tSat(7e5), 165.0, 0.003)
check('ρ_g at 7 bar abs', rhoSteam(7e5), 3.666, 0.01)
check('h_fg at 7 bar abs', hfg(7e5) / 1000, 2066, 0.003)
check('flash, 10 bar g → atmosphere', flashFraction(11e5 + 1325, P_ATM), 0.161, 0.03)
check('throttling 10 → 3 bar abs leaves superheat', throttledTemp(10e5, 3e5) - tSat(3e5), 25, 0.2)

// 2. one main, one load: steam rate, pressure drop, condensation, mass balance
{
  const L = 80,
    D = 0.05,
    duty = 300e3
  const m: Model = {
    fluid: steam,
    nodes: [node('B', 'reservoir', { pressure: 700e3 }), node('HX', 'steamload', { duty, processTemp: 120 })],
    edges: [pipe('main', 'B', 'HX', { length: L, diameter: D, insulation: 0.05 })],
  }
  const r = engine.solve(m)
  const p2 = r.nodes.HX.pressure + P_ATM
  const p1 = 700e3 + P_ATM
  check('load condenses duty / h_fg', r.steam!.loads.HX.steam, duty / hfg(p2), 1e-3)
  const cond = (pipeHeatLoss(m.edges[0].data!.props, tSat((p1 + p2) / 2)) * L) / hfg((p1 + p2) / 2)
  check('pipe condensate = heat loss / h_fg', r.steam!.links.main.condensate, cond, 1e-3)
  check('boiler makes load + condensate', r.steam!.boilers.B.steam, r.steam!.loads.HX.steam + cond, 1e-3)
  // Darcy with the mean density
  const mdot = r.links.main.flow
  const rho = rhoSteam((p1 + p2) / 2)
  const v = mdot / (rho * area(D))
  const f = frictionFactor((4 * mdot) / (Math.PI * D * steam.dynamicViscosity), 0.045e-3 / D)
  check('pressure drop ≈ Darcy at mean density', p1 - p2, ((f * L) / D) * 0.5 * rho * v * v, 0.03)
  check('velocity', r.links.main.velocity, v, 0.01)
  check('condensate with no drip trap carries over', r.steam!.loads.HX.carryover, cond, 1e-3)
  console.log(`  main: ${(mdot * 3600).toFixed(0)} kg/h at ${v.toFixed(1)} m/s, Δp ${((p1 - p2) / 1000).toFixed(1)} kPa, loses ${(r.steam!.links.main.heatLoss / 1000).toFixed(2)} kW`)
}

// 3. drip trap takes the main's condensate; a failed-open one blows steam
{
  const build = (state: string): Model => ({
    fluid: steam,
    nodes: [node('B', 'reservoir', { pressure: 700e3 }), node('J', 'junction'), node('T', 'trap', { state }), node('HX', 'steamload', { duty: 100e3, processTemp: 120 })],
    edges: [
      pipe('main', 'B', 'J', { length: 60, diameter: 0.05 }),
      pipe('leg', 'J', 'T', { length: 0.5, diameter: 0.02 }, 'b', 't'),
      pipe('branch', 'J', 'HX', { length: 5, diameter: 0.04, insulation: 0.05 }),
    ],
  })
  const ok = engine.solve(build('ok'))
  check('drip trap drains the bare main', ok.steam!.traps.T.load, ok.steam!.links.main.condensate + ok.steam!.links.leg.condensate, 1e-3)
  const open = engine.solve(build('open'))
  console.log(`  failed open: ${(open.steam!.traps.T.steamLoss * 3600).toFixed(1)} kg/h, ${(open.steam!.traps.T.lossPower / 1000).toFixed(1)} kW, ${Math.round(open.steam!.traps.T.costPerYear)} / yr`)
  // choked orifice: ṁ = CdA·p·√(γ/(p/ρ))·(2/(γ+1))^((γ+1)/(2(γ−1)))
  const pj = open.nodes.T.pressure + P_ATM
  const g = 1.135
  check('failed-open trap is a choked orifice', open.steam!.traps.T.steamLoss, 0.7 * area(0.004) * pj * Math.sqrt(g / (pj / rhoSteam(pj))) * (2 / (g + 1)) ** ((g + 1) / (2 * (g - 1))), 1e-3)
  const shut = engine.solve(build('closed'))
  check('blocked trap strands the condensate', shut.steam!.totals.stranded > 0 || shut.steam!.loads.HX.carryover > ok.steam!.loads.HX.carryover ? 1 : 0, 1)
}

// 4. reducing station: downstream holds the set pressure, steam comes out superheated
{
  const m: Model = {
    fluid: steam,
    nodes: [
      node('B', 'reservoir', { pressure: 1000e3 }),
      node('V', 'valve', { valveType: 'prv', pressureSetting: 300e3, diameter: 0.05, kOpen: 3 }),
      node('HX', 'steamload', { duty: 150e3, processTemp: 130 }),
    ],
    edges: [pipe('a', 'B', 'V', { length: 10, diameter: 0.05, insulation: 0.05 }, 'r', 'in'), pipe('b', 'V', 'HX', { length: 10, diameter: 0.065, insulation: 0.05 }, 'out', 'l')],
  }
  const r = engine.solve(m)
  check('PRV holds its set pressure', r.devices.V.pOut, 300e3, 0.02)
  console.log(`  after the PRV: ${r.steam!.throttled.V?.toFixed(1)} °C vs saturation ${tSat(r.devices.V.pOut + P_ATM).toFixed(1)} °C`)
  if (!(r.steam!.throttled.V > tSat(r.devices.V.pOut + P_ATM) + 10)) (failed++, console.log('✗ expected superheat after the PRV'))
}

// 5. condensate return: the line carries what the load condenses, flashing as it drops to the receiver's pressure
{
  const D = 0.0266
  const m: Model = {
    fluid: steam,
    nodes: [node('B', 'reservoir', { pressure: 700e3 }), node('HX', 'steamload', { duty: 300e3, processTemp: 120 }), node('RX', 'tank', {})],
    edges: [pipe('main', 'B', 'HX', { length: 30, diameter: 0.05, insulation: 0.05 }), pipe('ret', 'HX', 'RX', { length: 40, diameter: D, conduit: 'condensate' })],
  }
  const r = engine.solve(m)
  const st = r.steam!
  const kg = st.loads.HX.steam + st.loads.HX.carryover
  check('return line carries the load’s condensate', st.returns.links.ret.flow, kg, 1e-6)
  const pHx = r.nodes.HX.pressure + P_ATM
  const x = flashFraction(pHx, P_ATM + st.returns.links.ret.dp / 2) // flash belongs to the pressure half-way along the line
  check('flash fraction in the line', st.returns.links.ret.flash, x, 0.02)
  const rho = 1 / (x / rhoSteam(P_ATM + st.returns.links.ret.dp / 2) + (1 - x) / 950)
  check('two-phase velocity = ṁ / (ρ_mix · A)', st.returns.links.ret.velocity, kg / (rho * area(D)), 0.03)
  check('receiver keeps the liquid, vents the flash', st.returns.receivers.RX.condensate + st.returns.receivers.RX.flashVent, kg, 1e-6)
  check('back-pressure at the load = line loss', st.returns.backPressure.HX, st.returns.links.ret.dp, 1e-6)
  const open = engine.solve({ ...m, edges: [m.edges[0]] })
  check('returned condensate cuts the boiler’s heat input', st.boilers.B.heat < open.steam!.boilers.B.heat ? 1 : 0, 1)
  console.log(
    `  return: ${(kg * 3600).toFixed(0)} kg/h, ${(x * 100).toFixed(1)} % flash, ${st.returns.links.ret.velocity.toFixed(0)} m/s, back-pressure ${(st.returns.backPressure.HX / 1000).toFixed(0)} kPa, feed ${st.boilers.B.feedTemp?.toFixed(0)} °C`,
  )
}

// 6. part load and stall: throttled back, the steam space cools towards the process, and below the back-pressure it floods
{
  const build = (load: number): Model => ({
    fluid: steam,
    nodes: [node('B', 'reservoir', { pressure: 500e3 }), node('HX', 'steamload', { duty: 200e3, processTemp: 60, load, backPressure: 50e3 })],
    edges: [pipe('main', 'B', 'HX', { length: 10, diameter: 0.065, insulation: 0.05 })],
  })
  const full = engine.solve(build(1)).steam!.loads.HX
  const half = engine.solve(build(0.5)).steam!.loads.HX
  check('full load: the steam space is at supply pressure', full.space, engine.solve(build(1)).nodes.HX.pressure, 1e-6)
  const tHalf = 60 + 0.5 * (tSat(engine.solve(build(0.5)).nodes.HX.pressure + P_ATM) - 60)
  check('half load: space temperature half-way down to the process', half.tSat, tHalf, 0.005)
  check('half load: steam = ½ duty / h_fg at the space pressure', half.steam, 100e3 / hfg(half.space + P_ATM), 1e-3)
  // stall where the space is no hotter than saturation at the back-pressure
  const tBack = tSat(P_ATM + 50e3)
  check('stall point', full.stallAt, (tBack - 60) / (tSat(engine.solve(build(1)).nodes.HX.pressure + P_ATM) - 60), 0.01)
  const low = engine.solve(build(0.3))
  check('below it, the load is reported as stalled', low.steam!.loads.HX.stalled ? 1 : 0, 1)
}

if (failed) {
  console.error(`${failed} steam check(s) failed`)
  process.exit(1)
}
console.log('steam checks passed')
