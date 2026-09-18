// Water-hammer engine: Method of Characteristics on the same model the steady solver uses.
//
// The steady EPANET solution is the initial condition. Every pipe is cut into reaches of one time step
// (Δx = a·Δt); along the characteristics  dx/dt = ±a  the PDEs collapse to two algebraic relations,
//     C+ :  H_P = CP − B·Q_P        CP = H_A + B·Q_A − R·Q_A|Q_A|
//     C− :  H_P = CM + B·Q_P        CM = H_B − B·Q_B + R·Q_B|Q_B|
// with B = a/gA and R the friction of one reach. Whatever sits at a pipe end — a reservoir, a junction, a valve
// that is closing, a pump that has just lost power, an air vessel — is a boundary condition solved with them.
//
// Every pipe needs a whole number of reaches, so wave speeds are nudged (a′ = L / N·Δt); pipes shorter than one
// reach are stretched to one. That is the classic compromise, and it is why very short stubs barely matter.
import { stripChannels } from '../model/openchannel'
import { dischargeDevice, lossDevice } from '../model/catalog'
import { G, P_ATM, area, sourceElevation, elementK, fittingK, frictionFactor, pumpHead, ratedDp, reynolds, valveK, vesselPressure, vesselWater } from '../model/physics'
import { MATERIALS, isControl, isInline, type Model, type ModelNode, type Props, type Results } from '../model/types'
import { command, commandedOff, valvePosition } from './inp'

export interface TransientEvent {
  /** the component being operated */
  id: string
  /** seconds into the run at which the operation begins */
  start: number
  /** how long the operation takes (valve stroke; ignored for a pump trip) */
  duration: number
  /** where it ends: valve opening 0‥1, outlet 0 (shut) or 1 (open). A pump always trips. */
  to: number
  /** pump only: rotor inertia as the time for speed to halve, s */
  inertia?: number
  /** total simulated time, s */
  runFor: number
}

export interface TransientFrame {
  t: number
  /** gauge pressure (Pa) at plain nodes */
  nodes: Record<string, number>
  /** inline devices: flow and the pressures either side */
  devices: Record<string, { flow: number; pIn: number; pOut: number }>
  /** pipes: flow and end pressures */
  links: Record<string, { flow: number; pStart: number; pEnd: number }>
}

export interface TransientResult {
  ok: boolean
  error?: string
  event: TransientEvent
  dt: number
  reaches: number
  times: number[]
  /** pressure histories (Pa): plain node id, or `${deviceId}:in` / `${deviceId}:out` */
  series: Record<string, number[]>
  /** flow history (m³/s) through the operated component */
  eventFlow: number[]
  envelope: Record<string, { max: number; min: number }>
  /** Joukowsky's estimate for an instantaneous stop at the operated component, Pa */
  joukowsky: number
  waveSpeed: number
  /** 2L/a to the nearest free surface: operate slower than this and the surge shrinks */
  criticalTime: number
  peak: { key: string; pressure: number }
  trough: { key: string; pressure: number }
  cavitated: boolean
  frames: TransientFrame[]
  solveMs: number
}

interface Pipe {
  id: string
  up: number
  down: number
  n: number
  B: number
  R: number
  H: Float64Array
  Q: Float64Array
  Hn: Float64Array
  Qn: Float64Array
  zUp: number
  zDown: number
}
interface HNode {
  key: string
  z: number
  H: number
  kind: 'fixed' | 'vessel' | 'free'
  demand: number
  /** Q = ce·√(H − z): nozzles, sprinklers, leaks */
  ce: number
  ce0: number
  relief?: { setHead: number; c: number }
  /** an air valve lets air in rather than let the line go below atmospheric */
  breaksVacuum?: boolean
  vessel?: { props: Props; water: number }
  ends: { pipe: number; up: boolean }[]
  SC: number
  SB: number
}
interface Device {
  id: string
  a: number
  b: number
  type: 'loss' | 'pump' | 'closed'
  kv: number
  noReverse: boolean
  props: Props
  speed: number
  Q: number
}

/** A loss coefficient K on a bore, as head per (m³/s)². */
const kvOnBore = (K: number, d: number) => K / (2 * G * area(d) ** 2)

/** A tee, three-way valve or jet pump: a hub node whose ports each reach it through their own loss. */
interface Hub {
  id: string
  node: number
  /** gain: head a jet pump's entrainment adds on its suction port, frozen at its steady value */
  ports: { node: number; kv: number; gain: number; closed: boolean; noReverse: boolean; Q: number }[]
}

const waveSpeedOf = (material: string) => MATERIALS.find((m) => m.id === material)?.waveSpeed ?? 1000

/** Emitter coefficient in m³/s per √m of pressure head — the same law the steady compile hands to EPANET. */
function emitterCoeff(nd: ModelNode, model: Model, rhoG: number): number {
  const p = nd.data.props
  if (nd.data.kind === 'leak') return p.active === false ? 0 : p.cd * area(p.holeDiameter) * Math.sqrt(2 * G)
  if (nd.data.kind !== 'outlet' || p.mode === 'demand') return 0
  if (commandedOff(model, nd.id) || (dischargeDevice(p.variant)?.glyph === 'sprinkler' && !p.fused)) return 0
  return p.mode === 'kfactor' ? p.kFactor * Math.sqrt(rhoG) : p.cd * area(p.nozzleDiameter) * Math.sqrt(2 * G)
}

/** Loss of an inline part as Δh = kv·Q|Q|. Self-regulating valves are frozen at their steady-state resistance. */
function deviceKv(nd: ModelNode, model: Model, results: Results, rhoG: number): { kv: number; closed: boolean; noReverse: boolean } {
  const p = nd.data.props
  const onBore = (K: number, d: number) => K / (2 * G * area(d) ** 2)
  const steady = results.devices[nd.id]
  const frozen = () => (steady && Math.abs(steady.flow) > 1e-9 ? Math.max(0, steady.headIn - steady.headOut) / steady.flow ** 2 : 0)
  switch (nd.data.kind) {
    case 'dpgauge':
      return { kv: 0, closed: true, noReverse: false }
    case 'meter':
      return { kv: 0, closed: false, noReverse: false }
    case 'element':
      return { kv: onBore(elementK(p), p.diameter), closed: false, noReverse: false }
    case 'fitting': {
      const spec = lossDevice(p.variant)
      if (spec.model === 'k') {
        const { bore, K } = fittingK(p, spec.byDiameters)
        return { kv: onBore(K, bore), closed: false, noReverse: false }
      }
      // a rated device is quadratic enough over a surge: pin it at its steady point (or its datasheet point)
      const q = steady && Math.abs(steady.flow) > 1e-9 ? Math.abs(steady.flow) : p.ratedFlow
      return { kv: ratedDp(q, p) / rhoG / (q * q), closed: false, noReverse: false }
    }
    case 'valve': {
      if (p.valveType === 'throttle' || p.valveType === 'float') {
        const K = valveK(valvePosition(model, nd.id), p.kOpen, p.trim)
        return { kv: isFinite(K) ? onBore(K, p.diameter) : 0, closed: !isFinite(K), noReverse: false }
      }
      if (commandedOff(model, nd.id) || steady?.status === 'closed') return { kv: 0, closed: true, noReverse: p.valveType === 'check' }
      if (p.valveType === 'check') return { kv: onBore(p.kOpen, p.diameter), closed: false, noReverse: true }
      return { kv: frozen(), closed: false, noReverse: false }
    }
    default:
      return { kv: 0, closed: false, noReverse: false }
  }
}

export function runTransient(full: Model, results: Results, event: TransientEvent): TransientResult {
  const model = stripChannels(full) // open channels take no part in a pressure surge
  const t0 = performance.now()
  const fail = (error: string): TransientResult => ({
    ok: false,
    error,
    event,
    dt: 0,
    reaches: 0,
    times: [],
    series: {},
    eventFlow: [],
    envelope: {},
    joukowsky: 0,
    waveSpeed: 0,
    criticalTime: 0,
    peak: { key: '', pressure: 0 },
    trough: { key: '', pressure: 0 },
    cavitated: false,
    frames: [],
    solveMs: 0,
  })
  if (model.fluid.gas) return fail('The water-hammer engine is for liquids — a gas is too compressible to hammer')
  if (!results.ok) return fail('The network has to solve at steady state before it can be disturbed')
  const target = model.nodes.find((n) => n.id === event.id)
  if (!target || results.excluded.includes(event.id)) return fail('Pick a valve, pump or outlet that is part of the solved network')

  const { fluid } = model
  const rhoG = fluid.density * G
  const hVapour = (fluid.vaporPressure - P_ATM) / rhoG // gauge head at which the liquid flashes
  const excluded = new Set(results.excluded)

  // ---- hydraulic nodes ----
  const nodes: HNode[] = []
  const index = new Map<string, number>()
  const addNode = (key: string, z: number, H: number): HNode => {
    const n: HNode = { key, z, H, kind: 'free', demand: 0, ce: 0, ce0: 0, ends: [], SC: 0, SB: 0 }
    index.set(key, nodes.length)
    nodes.push(n)
    return n
  }
  const devices: Device[] = []
  const hubs: Hub[] = []
  for (const nd of model.nodes) {
    if (excluded.has(nd.id) || isControl(nd.data.kind)) continue
    const p = nd.data.props
    const kind = nd.data.kind
    if (isInline(kind)) {
      const d = results.devices[nd.id]
      if (!d) continue
      addNode(`${nd.id}:in`, p.elevation, d.headIn)
      addNode(`${nd.id}:out`, p.elevation, d.headOut)
      const a = index.get(`${nd.id}:in`)!
      const b = index.get(`${nd.id}:out`)!
      if (kind === 'pump') {
        const speed = p.on ? p.speed * command(model, nd.id) : 0
        devices.push({ id: nd.id, a, b, type: speed >= 0.01 ? 'pump' : 'closed', kv: 0, noReverse: true, props: p, speed, Q: d.flow })
      } else {
        const { kv, closed, noReverse } = deviceKv(nd, model, results, rhoG)
        devices.push({ id: nd.id, a, b, type: closed ? 'closed' : 'loss', kv, noReverse, props: p, speed: 0, Q: closed ? 0 : d.flow })
      }
      continue
    }
    const r = results.nodes[nd.id]
    if (!r) continue
    if (kind === 'tee' || kind === 'threeway' || kind === 'jetpump') {
      // same anatomy the steady compile gives them: every port but the common one joins the hub through a loss
      addNode(nd.id, p.elevation, r.head)
      const hub: Hub = { id: nd.id, node: index.get(nd.id)!, ports: [] }
      const into = new Map<string, number>() // steady flow arriving at the hub through each port
      for (const e of model.edges) {
        const l = results.links[e.id]
        if (e.type === 'signal' || !l) continue
        if (e.source === nd.id && e.sourceHandle) into.set(e.sourceHandle, (into.get(e.sourceHandle) ?? 0) - l.flow)
        if (e.target === nd.id && e.targetHandle) into.set(e.targetHandle, (into.get(e.targetHandle) ?? 0) + l.flow)
      }
      for (const [h, q] of into) {
        if ((kind === 'threeway' && h === 'ab') || (kind === 'jetpump' && h === 'd')) continue
        let kv = 0
        let gain = 0
        let closed = false
        if (kind === 'tee') kv = kvOnBore(h === 'l' || h === 'r' ? p.kRun / 2 : p.kBranch, p.diameter)
        else if (kind === 'threeway') {
          const x = Math.min(1, Math.max(0, p.position * command(model, nd.id)))
          const K = valveK(h === 'a' ? x : 1 - x, p.kOpen, p.trim)
          closed = !isFinite(K)
          kv = closed ? 0 : kvOnBore(K, p.diameter)
        } else if (h === 'm') kv = (r.extra?.q1 ?? 0) > 1e-9 ? Math.max(0, (r.extra!.pMotive / rhoG + p.elevation - r.head) / r.extra!.q1 ** 2) : kvOnBore(1 + p.kn, p.nozzleDiameter)
        else gain = Math.max(0, r.head - (r.extra?.pSuction ?? 0) / rhoG - p.elevation) // the jet keeps pulling as hard as it was
        const port = addNode(`${nd.id}:${h}`, p.elevation, r.head + kv * q * Math.abs(q) - gain)
        hub.ports.push({ node: index.get(port.key)!, kv, gain, closed, noReverse: kind === 'jetpump' && h === 's', Q: closed ? 0 : q })
      }
      hubs.push(hub)
      continue
    }
    const n = addNode(nd.id, kind === 'reservoir' ? sourceElevation(p, r.head) : p.elevation, r.head)
    if (kind === 'reservoir' || kind === 'tank') n.kind = 'fixed'
    else if (kind === 'vessel') {
      n.kind = 'vessel'
      n.vessel = { props: p, water: model.levels?.[nd.id] ?? vesselWater(p, p.initPressure) }
    } else if (kind === 'airvalve') n.breaksVacuum = p.mode !== 'release'
    else if (kind === 'relief') n.relief = { setHead: p.setPressure / rhoG, c: 0.7 * area(p.diameter) * Math.sqrt(2 * G) }
    else if (kind === 'junction' || (kind === 'outlet' && p.mode === 'demand')) n.demand = commandedOff(model, nd.id) ? 0 : r.outflow
    n.ce = n.ce0 = emitterCoeff(nd, model, rhoG)
  }

  // ---- pipes ----
  const port = (id: string, handle?: string | null) => index.get(`${id}:${handle}`) ?? (index.has(id) ? index.get(id) : index.get(`${id}:${handle === 'out' ? 'out' : 'in'}`))
  const raw = model.edges
    .filter((e) => e.type !== 'signal' && e.data && results.links[e.id])
    .map((e) => ({ e, up: port(e.source, e.sourceHandle), down: port(e.target, e.targetHandle), a: waveSpeedOf(e.data!.props.material) }))
    .filter((x) => x.up !== undefined && x.down !== undefined && x.up !== x.down)
  if (!raw.length) return fail('There are no flowing pipes to carry a pressure wave')

  // time step: ~80 reaches in the longest pipe, within sane bounds, and a cap on the total work
  const longest = Math.max(...raw.map((x) => x.e.data!.props.length / x.a))
  let dt = Math.min(5e-3, Math.max(2e-4, longest / 80))
  const count = (step: number) => raw.reduce((s, x) => s + Math.max(1, Math.round(x.e.data!.props.length / (x.a * step))), 0)
  if (count(dt) > 6000) dt *= count(dt) / 6000
  const steps = Math.min(400000, Math.ceil(event.runFor / dt))

  const pipes: Pipe[] = raw.map(({ e, up, down, a }) => {
    const p = e.data!.props
    const n = Math.max(1, Math.round(p.length / (a * dt)))
    const A = area(p.diameter)
    const aAdj = p.length / (n * dt)
    const Hup = nodes[up!].H
    const Hdn = nodes[down!].H
    const Q0 = results.links[e.id].flow
    // friction per reach: taken from the steady solution itself, so the initial state is exactly steady
    let R = Math.abs(Q0) > 1e-9 ? (Hup - Hdn) / (n * Q0 * Math.abs(Q0)) : NaN
    if (!(R > 0)) {
      const v = Math.abs(Q0) / A
      const f = frictionFactor(Math.max(reynolds(v, p.diameter, fluid), 4000), p.roughness / p.diameter)
      R = ((f * p.length) / p.diameter + (p.minorK || 0)) / (2 * G * A * A) / n
    }
    const H = new Float64Array(n + 1)
    const Q = new Float64Array(n + 1).fill(Q0)
    for (let i = 0; i <= n; i++) H[i] = Hup + ((Hdn - Hup) * i) / n
    return { id: e.id, up: up!, down: down!, n, B: aAdj / (G * A), R, H, Q, Hn: new Float64Array(n + 1), Qn: new Float64Array(n + 1), zUp: nodes[up!].z, zDown: nodes[down!].z }
  })
  pipes.forEach((pp, i) => {
    nodes[pp.up].ends.push({ pipe: i, up: true })
    nodes[pp.down].ends.push({ pipe: i, up: false })
  })

  // ---- the event ----
  const evDevice = devices.find((d) => d.id === event.id)
  const evNode = index.get(event.id)
  const tProps = target.data.props
  const tau0 = target.data.kind === 'valve' ? valvePosition(model, target.id) : 1
  if (target.data.kind === 'valve' && !(tProps.valveType === 'throttle' || tProps.valveType === 'float')) return fail('Only throttling valves can be stroked — this one regulates itself')
  const progress = (t: number) => (event.duration <= 0 ? (t >= event.start ? 1 : 0) : Math.min(1, Math.max(0, (t - event.start) / event.duration)))

  // Joukowsky and the critical time, from the pipe feeding the operated component
  const evHyd = evDevice ? evDevice.a : evNode
  const feeder = evHyd === undefined ? undefined : pipes.filter((pp) => pp.down === evHyd || pp.up === evHyd).sort((x, y) => Math.abs(y.Q[0]) - Math.abs(x.Q[0]))[0]
  const feederEdge = feeder && raw.find((x) => x.e.id === feeder.id)!
  const aMain = feederEdge?.a ?? 1000
  const v0 = feederEdge ? Math.abs(feeder!.Q[0]) / area(feederEdge.e.data!.props.diameter) : 0
  // travel time to the nearest free surface (Dijkstra over pipes; inline parts are crossed instantly)
  const time = new Array(nodes.length).fill(Infinity)
  if (evHyd !== undefined) {
    // a valve's surge builds on the side the water arrives from; a tripped pump's runs up its discharge
    const from = evDevice && target.data.kind === 'pump' ? evDevice.b : evHyd
    time[from] = 0
    const open = new Set(time.map((_, i) => i))
    while (open.size) {
      let cur = -1
      for (const i of open) if (cur < 0 || time[i] < time[cur]) cur = i
      open.delete(cur)
      if (!isFinite(time[cur])) break
      for (const end of nodes[cur].ends) {
        const pp = pipes[end.pipe]
        const other = end.up ? pp.down : pp.up
        time[other] = Math.min(time[other], time[cur] + pp.n * dt)
      }
      for (const d of devices) if (d !== evDevice && d.type !== 'closed' && (d.a === cur || d.b === cur)) time[d.a === cur ? d.b : d.a] = Math.min(time[d.a === cur ? d.b : d.a], time[cur])
    }
  }
  const surfaces = nodes.map((n, i) => (n.kind === 'free' ? Infinity : time[i])).filter(isFinite)
  const criticalTime = surfaces.length ? 2 * Math.min(...surfaces) : 0

  // ---- recording ----
  const every = Math.max(1, Math.floor(steps / 500))
  const frameEvery = Math.max(1, Math.floor(steps / 240))
  const times: number[] = []
  const series: Record<string, number[]> = {}
  const envelope: Record<string, { max: number; min: number }> = {}
  for (const n of nodes) {
    series[n.key] = []
    envelope[n.key] = { max: -Infinity, min: Infinity }
  }
  const eventFlow: number[] = []
  const frames: TransientFrame[] = []
  let cavitated = false
  const pressureOf = (n: HNode) => (n.H - n.z) * rhoG

  const record = (t: number, step: number) => {
    for (const n of nodes) {
      const pr = pressureOf(n)
      const env = envelope[n.key]
      if (pr > env.max) env.max = pr
      if (pr < env.min) env.min = pr
    }
    if (step % every === 0) {
      times.push(t)
      for (const n of nodes) series[n.key].push(pressureOf(n))
      eventFlow.push(evDevice ? evDevice.Q : evNode !== undefined ? nodes[evNode].ce * Math.sqrt(Math.max(0, nodes[evNode].H - nodes[evNode].z)) + nodes[evNode].demand : 0)
    }
    if (step % frameEvery === 0) {
      const f: TransientFrame = { t, nodes: {}, devices: {}, links: {} }
      for (const n of nodes) if (!n.key.includes(':')) f.nodes[n.key] = pressureOf(n)
      for (const d of devices) f.devices[d.id] = { flow: d.Q, pIn: pressureOf(nodes[d.a]), pOut: pressureOf(nodes[d.b]) }
      for (const pp of pipes) f.links[pp.id] = { flow: pp.Q[pp.n >> 1], pStart: (pp.H[0] - pp.zUp) * rhoG, pEnd: (pp.H[pp.n] - pp.zDown) * rhoG }
      frames.push(f)
    }
  }
  record(0, 0)

  // ---- time marching ----
  for (let step = 1; step <= steps; step++) {
    const t = step * dt
    const s = progress(t)

    // the operation itself
    if (evDevice && target.data.kind === 'valve') {
      const K = valveK(tau0 + (event.to - tau0) * s, tProps.kOpen, tProps.trim)
      evDevice.type = isFinite(K) ? 'loss' : 'closed'
      evDevice.kv = isFinite(K) ? K / (2 * G * area(tProps.diameter) ** 2) : 0
    } else if (evDevice && target.data.kind === 'pump' && t >= event.start) {
      // power lost: the rotor coasts down, speed halving every `inertia` seconds
      evDevice.speed = (tProps.speed * command(model, target.id)) / (1 + (t - event.start) / Math.max(0.05, event.inertia ?? 1))
    } else if (evNode !== undefined) {
      const n = nodes[evNode]
      const from = n.ce0 > 0 ? 1 : 0
      const full = n.ce0 > 0 ? n.ce0 : emitterCoeff({ ...target, data: { ...target.data, props: { ...tProps, fused: true, active: true } } }, { ...model, controls: {} }, rhoG)
      n.ce = full * (from + (event.to - from) * s)
    }

    // interior points, and the characteristic arriving at each pipe end
    for (const n of nodes) n.SC = n.SB = 0
    for (const pp of pipes) {
      const { H, Q, Hn, Qn, B, R, n } = pp
      for (let i = 1; i < n; i++) {
        const CP = H[i - 1] + B * Q[i - 1] - R * Q[i - 1] * Math.abs(Q[i - 1])
        const CM = H[i + 1] - B * Q[i + 1] + R * Q[i + 1] * Math.abs(Q[i + 1])
        Hn[i] = (CP + CM) / 2
        Qn[i] = (CP - CM) / (2 * B)
      }
      const CM0 = H[1] - B * Q[1] + R * Q[1] * Math.abs(Q[1]) // towards the upstream node
      const CPn = H[n - 1] + B * Q[n - 1] - R * Q[n - 1] * Math.abs(Q[n - 1]) // towards the downstream node
      Hn[0] = CM0 // parked here until the node head is known
      Hn[n] = CPn
      nodes[pp.up].SC += CM0 / B
      nodes[pp.up].SB += 1 / B
      nodes[pp.down].SC += CPn / B
      nodes[pp.down].SB += 1 / B
    }

    // inline parts couple their two nodes through Q
    const owned = new Set<number>()
    for (const d of devices) {
      const na = nodes[d.a]
      const nb = nodes[d.b]
      owned.add(d.a).add(d.b)
      let Q = 0
      if (d.type !== 'closed' && na.SB > 0 && nb.SB > 0) {
        const E = na.SC / na.SB - nb.SC / nb.SB // head available across the part at zero flow
        const M = 1 / na.SB + 1 / nb.SB
        if (d.type === 'loss') {
          Q = d.kv > 0 ? (Math.sign(E) * (-M + Math.sqrt(M * M + 4 * d.kv * Math.abs(E)))) / (2 * d.kv) : E / M
        } else {
          // pump: (H_b − H_a) = pump head at this speed; f rises with Q, so bisect
          const sp = Math.max(0.03, d.speed)
          const head = (q: number) => pumpHead(q, d.props, sp)
          const f = (q: number) => -E + M * q - head(q)
          if (f(0) < 0) {
            let lo = 0
            let hi = Math.max(d.props.designFlow, Math.abs(d.Q)) * 2
            for (let k = 0; k < 30 && f(hi) < 0; k++) hi *= 2
            for (let k = 0; k < 50; k++) {
              const mid = (lo + hi) / 2
              if (f(mid) < 0) lo = mid
              else hi = mid
            }
            Q = (lo + hi) / 2
          }
        }
        if (d.noReverse && Q < 0) Q = 0
      }
      d.Q = Q
      if (na.SB > 0) na.H = (na.SC - Q) / na.SB
      if (nb.SB > 0) nb.H = (nb.SC + Q) / nb.SB
    }

    // tees, three-way valves and jet pumps: find the hub head at which what the ports deliver balances what the hub's own pipes take
    for (const hub of hubs) {
      const hn = nodes[hub.node]
      owned.add(hub.node)
      hub.ports.forEach((pt) => owned.add(pt.node))
      const through = (pt: Hub['ports'][number], Hh: number) => {
        const pn = nodes[pt.node]
        if (pt.closed || pn.SB === 0) return 0
        const E = pn.SC / pn.SB + pt.gain - Hh
        const M = 1 / pn.SB
        const Q = pt.kv > 0 ? (Math.sign(E) * (-M + Math.sqrt(M * M + 4 * pt.kv * Math.abs(E)))) / (2 * pt.kv) : E / M
        return pt.noReverse && Q < 0 ? 0 : Q
      }
      const balance = (Hh: number) => hn.SC - hn.SB * Hh + hub.ports.reduce((s, pt) => s + through(pt, Hh), 0)
      let lo = hn.H - 50
      let hi = hn.H + 50
      for (let k = 0; k < 30 && balance(lo) < 0; k++) lo -= (hi - lo) * 2
      for (let k = 0; k < 30 && balance(hi) > 0; k++) hi += (hi - lo) * 2
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2
        if (balance(mid) > 0) lo = mid
        else hi = mid
      }
      hn.H = (lo + hi) / 2
      for (const pt of hub.ports) {
        pt.Q = through(pt, hn.H)
        const pn = nodes[pt.node]
        if (pn.SB > 0) pn.H = (pn.SC - pt.Q) / pn.SB
      }
    }

    // everything else
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (owned.has(i) || n.SB === 0) continue
      if (n.kind === 'fixed') continue
      if (n.kind === 'vessel') {
        const v = n.vessel!
        v.water = Math.min(v.props.volume * 0.98, Math.max(0, v.water + (n.SC - n.SB * n.H) * dt))
        n.H = n.z + vesselPressure(v.props, v.water) / rhoG
        continue
      }
      const net = n.SC - n.demand
      let H = net / n.SB
      let ce = n.ce
      if (n.relief && H - n.z > n.relief.setHead) ce += n.relief.c
      if (ce > 0) {
        // SB·x² + ce·x − (net − SB·z) = 0 with x = √(H − z)
        const rhs = net - n.SB * n.z
        if (rhs > 0) {
          const x = (-ce + Math.sqrt(ce * ce + 4 * n.SB * rhs)) / (2 * n.SB)
          H = n.z + x * x
        }
      }
      n.H = H
    }

    // an air valve admits air the moment the line reaches atmospheric: the pressure simply cannot go lower there
    for (const n of nodes) if (n.breaksVacuum && n.H < n.z) n.H = n.z
    // vapour pressure is a floor: below it the column parts
    for (const n of nodes)
      if (n.kind === 'free' && n.H - n.z < hVapour) {
        n.H = n.z + hVapour
        cavitated = true
      }

    // close the pipe ends on their node heads, then swap time levels
    for (const pp of pipes) {
      const { Hn, Qn, B, n } = pp
      const Hu = nodes[pp.up].H
      const Hd = nodes[pp.down].H
      Qn[0] = (Hu - Hn[0]) / B
      Qn[n] = (Hn[n] - Hd) / B
      Hn[0] = Hu
      Hn[n] = Hd
      pp.H.set(Hn)
      pp.Q.set(Qn)
    }
    record(t, step)
  }

  let peak = { key: '', pressure: -Infinity }
  let trough = { key: '', pressure: Infinity }
  for (const [key, e] of Object.entries(envelope)) {
    if (e.max > peak.pressure) peak = { key, pressure: e.max }
    if (e.min < trough.pressure) trough = { key, pressure: e.min }
  }
  return {
    ok: true,
    event,
    dt,
    reaches: pipes.reduce((s, pp) => s + pp.n, 0),
    times,
    series,
    eventFlow,
    envelope,
    joukowsky: fluid.density * aMain * v0,
    waveSpeed: aMain,
    criticalTime,
    peak,
    trough,
    cavitated,
    frames,
    solveMs: performance.now() - t0,
  }
}
