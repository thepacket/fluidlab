// Open-channel engine: steady gradually-varied flow through a network of reaches.
//
//   1. Reaches are oriented towards the nearest outfall, and continuity gives every reach its discharge.
//   2. A subcritical pass walks upstream from every downstream control (outfall, weir, gate, junction stage),
//      solving the energy equation station by station (the standard step method).
//   3. A supercritical pass walks downstream from every upstream control (critical inlet, gate jet, weir toe).
//   4. Where both profiles exist the one with the larger specific force wins — the hand-over is the hydraulic jump.
//   5. Where a channel forks, the split is iterated until both branches agree on the water level at the fork.
import { G } from '../model/physics'
import {
  GATE_CC,
  area,
  bisect,
  criticalDepth,
  frictionSlope,
  froude,
  gateDepth,
  hydraulicRadius,
  isChannel,
  isFull,
  lakeSill,
  lining,
  normalDepth,
  sectionTop,
  slopeClass,
  specificEnergy,
  specificForce,
  superDepth,
  weirHead,
  zoneName,
  type SlopeClass,
} from '../model/openchannel'
import { EMPTY_RESULTS, type Model, type ModelEdge, type ModelNode, type Props, type Results, type Warning } from '../model/types'
import { command } from './inp'

const STATIONS = 80

export interface ReachResult {
  flow: number
  /** distance from the upstream end, m */
  x: number[]
  bed: number[]
  depth: number[]
  froude: number[]
  yn: number | null
  yc: number
  slope: number
  slopeClass: SlopeClass
  /** zones met from upstream to downstream: "S2 → jump → S1" */
  profile: string
  /** node id at the upstream end */
  from: string
  to: string
  jump?: { x: number; y1: number; y2: number; loss: number; power: number }
  vMax: number
}
export interface ChannelResults {
  reaches: Record<string, ReachResult>
}

interface Reach {
  e: ModelEdge
  p: Props
  up: string
  dn: string
  zu: number
  zd: number
  dx: number
  s0: number
  q: number
  yc: number
  yn: number | null
  sub: number[]
  sup: number[]
  y: number[]
}
interface Structure {
  /** upstream depth the structure imposes; null = it is not controlling */
  yUp: number | null
  toe: number | null
  headOver: number
  submerged: boolean
}

/** `feeds`: discharge (m³/s) arriving from the pipework at outlets that empty into a channel. */
export function solveChannel(model: Model, feeds: Record<string, number> = {}, draws: Record<string, number> = {}): Results | null {
  const edges = model.edges.filter((e) => isChannel(e))
  if (!edges.length) return null
  const t0 = performance.now()
  const warnings: Warning[] = []
  const res: Results = { ...EMPTY_RESULTS, ok: true, warnings, nodes: {}, links: {}, devices: {}, excluded: [] }
  if (model.fluid.gas) return { ...res, ok: false, error: 'Open channels need a liquid — pick one in the fluid menu' }
  const rhoG = model.fluid.density * G
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const kindOf = (id: string) => byId.get(id)?.data.kind
  // A tank or an open reservoir is a lake to the channel: a water level, and a sill the channel leaves (or enters) over.
  const isLake = (id: string) => kindOf(id) === 'tank' || (kindOf(id) === 'reservoir' && (byId.get(id)!.data.props.sourceType ?? 'surface') === 'surface')
  const lakeLevel = (id: string) => {
    const p = byId.get(id)!.data.props
    return kindOf(id) === 'tank' ? p.elevation + (model.levels?.[id] ?? p.initLevel) : p.head
  }
  const z = (id: string): number => {
    const p = byId.get(id)?.data.props
    if (!p) return 0
    return isLake(id) ? lakeSill(kindOf(id)!, p) : (p.elevation ?? 0)
  }

  // ---- 1. orientation -----------------------------------------------------------------------------
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    for (const [a, b] of [
      [e.source, e.target],
      [e.target, e.source],
    ]) {
      if (!adj.has(a)) adj.set(a, [])
      adj.get(a)!.push(b)
    }
  }
  const ids = [...adj.keys()]
  const dropAt = (id: string) => (kindOf(id) === 'junction' ? Math.max(0, byId.get(id)!.data.props.drop ?? 0) : 0)
  // a lake is where water ends up if every reach at it runs downhill towards it; otherwise it is a source
  const lakeSink = (id: string) => isLake(id) && adj.get(id)!.every((m) => z(m) > z(id))
  const terminal = (id: string) => kindOf(id) === 'outfall' || lakeSink(id) || (adj.get(id)!.length === 1 && kindOf(id) !== 'inflow' && kindOf(id) !== 'outlet' && !isLake(id))
  const dist = new Map<string, number>()
  const queue = ids.filter(terminal)
  queue.forEach((id) => dist.set(id, 0))
  for (let i = 0; i < queue.length; i++) for (const m of adj.get(queue[i])!) if (!dist.has(m)) (dist.set(m, dist.get(queue[i])! + 1), queue.push(m))
  // water runs from high rank to low rank: further from the sea first, then higher ground
  const order = ids.filter((id) => dist.has(id)).sort((a, b) => dist.get(b)! - dist.get(a)! || z(b) - z(a) || ids.indexOf(a) - ids.indexOf(b))
  const rank = new Map(order.map((id, i) => [id, i]))
  for (const id of ids) if (!dist.has(id)) res.excluded.push(id)

  const reaches: Reach[] = []
  for (const e of edges) {
    if (!rank.has(e.source) || !rank.has(e.target)) {
      res.excluded.push(e.id)
      continue
    }
    const fwd = rank.get(e.source)! < rank.get(e.target)!
    const [up, dn] = fwd ? [e.source, e.target] : [e.target, e.source]
    const p = { ...e.data!.props }
    if (p.lining !== 'custom') p.manningN = lining(p.lining).n
    const L = Math.max(0.1, p.length)
    const zu = z(up) - dropAt(up) // a junction can be a step in the bed: reaches leaving it start that much lower
    reaches.push({ e, p, up, dn, zu, zd: z(dn), dx: L / STATIONS, s0: (zu - z(dn)) / L, q: 0, yc: 0, yn: null, sub: [], sup: [], y: [] })
  }
  if (res.excluded.length) warnings.push({ level: 'info', text: 'Greyed-out channel parts have nowhere to drain to — add an outfall' })
  const leaving = (id: string) => reaches.filter((r) => r.up === id)
  const entering = (id: string) => reaches.filter((r) => r.dn === id)
  const main = (rs: Reach[]) => rs.reduce<Reach | undefined>((m, r) => (!m || r.q > m.q ? r : m), undefined)

  // ---- 2. discharges --------------------------------------------------------------------------------
  const share = new Map<string, number>() // at a fork: fraction taken by the first branch
  const bracket = new Map<string, [number, number]>()
  const shares = new Map<string, number[]>() // three branches or more: the fraction each one takes
  const outflow = new Map<string, number>()
  const lakeQ = new Map<string, number>() // what each source lake is giving, found by iteration below
  const route = () => {
    for (const id of order) {
      const nd = byId.get(id)!
      const p = nd.data.props
      let total = entering(id).reduce((s, r) => s + r.q, 0)
      if (nd.data.kind === 'inflow') total += Math.max(0, p.flow * command(model, id))
      if (nd.data.kind === 'outlet') total += Math.max(0, feeds[id] ?? 0)
      total += lakeQ.get(id) ?? 0
      if (nd.data.kind === 'junction') total -= p.demand ?? 0
      total -= draws[id] ?? 0 // pipework tapping the channel here (negative: discharging into it)
      total = Math.max(0, total)
      const outs = leaving(id)
      outflow.set(id, outs.length ? 0 : total)
      outs.forEach((r, i) => {
        r.q = outs.length === 1 ? total : outs.length === 2 ? total * (i === 0 ? share.get(id)! : 1 - share.get(id)!) : total * shares.get(id)![i]
        r.yc = criticalDepth(r.q, r.p)
        r.yn = normalDepth(r.q, r.p, r.s0)
      })
    }
  }
  for (const id of order) {
    const outs = leaving(id)
    if (outs.length === 2) (share.set(id, 0.5), bracket.set(id, [0, 1]))
    if (outs.length > 2)
      shares.set(
        id,
        outs.map(() => 1 / outs.length),
      )
  }

  // ---- 3. subcritical pass --------------------------------------------------------------------------
  const structures = new Map<string, Structure>()
  /** Steps between stations are cut until the bed falls only a small fraction of the critical depth in each — coarse steps ring on steep slopes. */
  const substeps = (r: Reach): [number, number] => {
    const n = Math.min(24, Math.max(1, Math.ceil((r.dx * Math.max(Math.abs(r.s0), 0.002)) / (0.04 * Math.max(r.yc, 0.01)))))
    return [n, r.dx / n]
  }
  const stationsUp = (r: Reach, yEnd: number) => {
    const y = new Array<number>(STATIONS + 1)
    const top = sectionTop(r.p)
    y[STATIONS] = Math.min(top, Math.max(yEnd, r.yc))
    const [n, dx] = substeps(r)
    for (let i = STATIONS - 1; i >= 0; i--) {
      let yd = y[i + 1]
      for (let k = 0; k < n; k++) {
        // energy at the station below, plus half the friction loss; the bed rises by s0·dx going upstream
        const target = specificEnergy(r.q, r.p, yd) + 0.5 * frictionSlope(r.q, r.p, yd) * dx - r.s0 * dx
        const f = (v: number) => specificEnergy(r.q, r.p, v) - 0.5 * frictionSlope(r.q, r.p, v) * dx - target
        yd = f(r.yc) > 0 ? r.yc : f(top) < 0 ? top : bisect(f, r.yc, top, 50)
      }
      y[i] = yd
    }
    return y
  }
  const stationsDown = (r: Reach, yStart: number) => {
    const y = new Array<number>(STATIONS + 1)
    y[0] = Math.min(yStart, r.yc)
    const [n, dx] = substeps(r)
    for (let i = 1; i <= STATIONS; i++) {
      let yu = y[i - 1]
      for (let k = 0; k < n; k++) {
        const avail = specificEnergy(r.q, r.p, yu) - 0.5 * frictionSlope(r.q, r.p, yu) * dx + r.s0 * dx
        // on the supercritical branch both energy and friction fall as depth grows
        const g = (v: number) => avail - specificEnergy(r.q, r.p, v) - 0.5 * frictionSlope(r.q, r.p, v) * dx
        yu = g(r.yc) <= 0 ? r.yc : bisect(g, 1e-5, r.yc, 50)
      }
      y[i] = yu
    }
    return y
  }

  /** Water level a node shows to the reaches arriving at it; null = nothing downstream holds the water up. */
  const stageOf = (id: string): number | null => {
    const nd = byId.get(id)!
    const p = nd.data.props
    const outs = leaving(id)
    if (!outs.length) {
      if (isLake(id)) return lakeLevel(id) > z(id) ? lakeLevel(id) : null
      return nd.data.kind === 'outfall' && p.mode === 'level' ? p.level : null
    }
    const total = outs.reduce((s, r) => s + r.q, 0)
    const tail = total > 0 ? outs.reduce((s, r) => s + (r.zu + r.sub[0]) * r.q, 0) / total : Math.max(...outs.map((r) => r.zu + r.sub[0]))
    if (nd.data.kind !== 'weir' && nd.data.kind !== 'gate') return tail
    const d = outs[0]
    const zs = z(id)
    const q = total
    const st: Structure = { yUp: null, toe: null, headOver: 0, submerged: false }
    structures.set(id, st)
    if (q <= 0) return tail
    const approach = main(entering(id))
    const tw = tail - zs
    if (nd.data.kind === 'weir') {
      const crest = p.crestHeight ?? 0
      let h = weirHead(p, q)
      const va = approach ? q / Math.max(1e-9, area(approach.p, crest + h)) : 0
      const toe = superDepth(q, d.p, (crest + h + (va * va) / (2 * G)) * 0.95) // ~5 % lost over the crest
      st.submerged = tw > crest && specificForce(q, d.p, tw) > specificForce(q, d.p, toe)
      if (st.submerged) h = weirHead(p, q, tw - crest)
      st.headOver = h
      st.yUp = crest + h
      st.toe = st.submerged ? null : toe
      return zs + crest + h
    }
    const a = Math.max(1e-4, p.opening * command(model, id))
    const b = Math.max(0.01, p.width)
    const y1 = gateDepth(b, a, q)
    if (y1 <= a * 1.001 && tw <= a) {
      // The flow would pass under the lip without touching it — unless the channel's own depth reaches the gate, in
      // which case the surface hangs on the lip: just deep enough to touch, no deeper.
      if (!approach || approach.yn === null || approach.yn <= a) return tail
      st.yUp = a
      st.headOver = 0
      return zs + a
    }
    const jet = Math.min(GATE_CC * a, d.yc)
    st.submerged = specificForce(q, d.p, tw) > specificForce(q, d.p, jet) && tw > jet
    if (st.submerged) {
      // Henry: momentum from the contracted jet to the tailwater gives the depth standing against the gate,
      // energy from upstream to the jet gives the depth behind it. Continuous with free flow at the onset.
      const qu = q / b
      const y2 = GATE_CC * a
      const ys = Math.sqrt(Math.max(y2 * y2, tw * tw + ((2 * qu * qu) / G) * (1 / tw - 1 / y2)))
      const need = ys + (qu * qu) / (2 * G * y2 * y2)
      st.yUp = Math.max(
        tw,
        bisect((v) => v + (qu * qu) / (2 * G * v * v) - need, Math.cbrt((qu * qu) / G), 200),
      )
    } else st.yUp = y1
    st.toe = st.submerged ? null : jet
    st.headOver = st.yUp - (st.submerged ? tw : jet)
    return zs + st.yUp
  }
  const subPass = () => {
    structures.clear()
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i]
      const ins = entering(id)
      if (!ins.length) continue
      const stage = stageOf(id)
      const nd = byId.get(id)!
      for (const r of ins) {
        if (r.q <= 0) r.sub = new Array(STATIONS + 1).fill(0)
        else if (stage !== null) r.sub = stationsUp(r, stage - r.zd)
        else r.sub = stationsUp(r, nd.data.kind === 'outfall' && nd.data.props.mode === 'normal' && r.yn !== null ? r.yn : r.yc)
      }
    }
  }

  const core = () => {
    for (const id of bracket.keys()) (share.set(id, 0.5), bracket.set(id, [0, 1]))
    for (const [id, f] of shares)
      shares.set(
        id,
        f.map(() => 1 / f.length),
      )
    for (let pass = 0; pass < 40; pass++) {
      route()
      subPass()
      let moved = 0
      for (const [id, [lo, hi]] of bracket) {
        const [a, b] = leaving(id)
        const diff = a.zu + a.sub[0] - (b.zu + b.sub[0]) // branch a backs up higher → it is being given too much
        const next: [number, number] = diff > 0 ? [lo, share.get(id)!] : [share.get(id)!, hi]
        bracket.set(id, next)
        const mid = (next[0] + next[1]) / 2
        moved = Math.max(moved, Math.abs(mid - share.get(id)!))
        share.set(id, mid)
      }
      // three branches or more: nudge every branch towards the one water level they must share at the fork.
      // A branch's level rises roughly as ⅔·depth/flow (exact for critical flow), which is a good enough slope to step with.
      for (const [id, f] of shares) {
        const outs = leaving(id)
        const total = outs.reduce((s, r) => s + r.q, 0)
        if (total <= 0) continue
        const stage = outs.map((r) => r.zu + r.sub[0])
        const k = outs.map((r) => (0.67 * Math.max(r.sub[0], 0.01)) / Math.max(r.q, 1e-4 * total))
        const common = outs.reduce((s, _, i) => s + stage[i] / k[i], 0) / outs.reduce((s, _, i) => s + 1 / k[i], 0)
        const q = outs.map((r, i) => Math.max(0, r.q + (0.7 * (common - stage[i])) / k[i]))
        const sum = q.reduce((s, v) => s + v, 0) || 1
        const next = q.map((v) => v / sum)
        moved = Math.max(moved, ...next.map((v, i) => Math.abs(v - f[i])))
        shares.set(id, next)
      }
      if (moved < 1e-5) break
    }

    // ---- 4. supercritical pass, and the choice between the two ------------------------------------------
    for (const id of order) {
      const st = structures.get(id)
      const feeder = main(entering(id))
      for (const r of leaving(id)) {
        if (r.q <= 0) {
          r.y = new Array(STATIONS + 1).fill(0)
          continue
        }
        let start = r.yc
        if (st?.yUp != null) start = st.toe ?? r.yc
        else if (feeder && feeder.q > 0 && (feeder.y[STATIONS] < feeder.yc * 0.99 || dropAt(id) > 0)) start = superDepth(r.q, r.p, specificEnergy(feeder.q, feeder.p, feeder.y[STATIONS]) + dropAt(id)) // a step in the bed hands its height over as energy
        r.sup = stationsDown(r, start)
        r.y = r.sub.map((ys, i) => (r.sup[i] < r.yc * 0.999 && specificForce(r.q, r.p, r.sup[i]) > specificForce(r.q, r.p, ys) * (1 + 1e-9) ? r.sup[i] : ys))
      }
    }
  }

  // ---- lakes: a tank or reservoir gives whatever flow makes the energy at the head of its channel equal its level ----
  const lakes = order.filter((id) => isLake(id) && !lakeSink(id) && leaving(id).length > 0)
  if (!lakes.length) core()
  for (let sweep = 0; sweep < (lakes.length > 1 ? 2 : 1); sweep++) {
    for (const id of lakes) {
      const H = lakeLevel(id) - z(id)
      const energy = () => {
        const r = main(leaving(id))!
        return r.q > 0 ? specificEnergy(r.q, r.p, r.y[0]) : 0
      }
      // no channel can take more than critical flow under this much energy
      let qMax = 0
      for (const r of leaving(id)) {
        let best = 0
        for (let i = 1; i < 60; i++) best = Math.max(best, area(r.p, (H * i) / 60) * Math.sqrt(2 * G * Math.max(0, H - (H * i) / 60)))
        qMax += best
      }
      let [lo, hi] = [0, H > 1e-4 ? qMax * 1.02 : 0]
      for (let i = 0; i < 22 && hi > 0; i++) {
        lakeQ.set(id, (lo + hi) / 2)
        core()
        if (energy() > H) hi = (lo + hi) / 2
        else lo = (lo + hi) / 2
      }
      lakeQ.set(id, lo)
      core()
    }
  }

  // ---- 5. results -------------------------------------------------------------------------------------
  const channel: ChannelResults = { reaches: {} }
  const nu = model.fluid.dynamicViscosity / model.fluid.density
  const jumps: string[] = []
  for (const r of reaches) {
    const cls = slopeClass(r.s0, r.yn, r.yc)
    const x = r.y.map((_, i) => i * r.dx)
    const bed = x.map((d) => r.zu - r.s0 * d)
    const fr = r.y.map((y) => froude(r.q, r.p, y))
    const v = r.y.map((y) => (y > 0 ? r.q / area(r.p, y) : 0))
    const out: ReachResult = { flow: r.q, x, bed, depth: r.y, froude: fr, yn: r.yn, yc: r.yc, slope: r.s0, slopeClass: cls, profile: 'dry', from: r.up, to: r.dn, vMax: Math.max(...v) }
    if (r.q > 0) {
      const zones: string[] = []
      // a jump can also stand exactly where a fast reach hands over to a slow one
      const feeder = structures.get(r.up)?.yUp != null ? undefined : main(entering(r.up))
      if (feeder && feeder.q > 0 && feeder.y[STATIONS] < feeder.yc * 0.999 && r.y[0] > r.yc * 1.001 && r.y[0] > feeder.y[STATIONS] * 1.1) {
        const [y1, y2] = [feeder.y[STATIONS], r.y[0]]
        const loss = Math.max(0, specificEnergy(feeder.q, feeder.p, y1) - specificEnergy(r.q, r.p, y2))
        out.jump = { x: 0, y1, y2, loss, power: rhoG * r.q * loss }
        zones.push('jump')
      }
      for (let i = 0; i <= STATIONS; i++) {
        const isJump = i > 0 && r.y[i - 1] < r.yc * 0.999 && r.y[i] > r.yc * 1.001 && r.y[i] === r.sub[i] && r.y[i - 1] === r.sup[i - 1]
        // a step of a few per cent either side of critical depth is an undular ripple, not a jump worth reporting
        if (isJump && !out.jump && r.y[i] > r.y[i - 1] * 1.1) {
          const [y1, y2] = [r.y[i - 1], r.y[i]]
          const loss = Math.max(0, specificEnergy(r.q, r.p, y1) - specificEnergy(r.q, r.p, y2) + r.s0 * r.dx)
          out.jump = { x: (i - 0.5) * r.dx, y1, y2, loss, power: rhoG * r.q * loss }
          zones.push('jump')
        }
        const zn = isFull(r.p, r.y[i]) ? 'full' : zoneName(cls, r.y[i], r.yn, r.yc)
        if (zones[zones.length - 1] !== zn) zones.push(zn)
      }
      // a lone station of another zone at either end is just the boundary itself (critical depth at a brink)
      out.profile = zones.filter((zn, i) => zn !== 'uniform' || zones.length === 1 || i === zones.length - 1 || i === 0).join(' → ')
      if (out.jump) jumps.push(`${r.e.data!.label} (${out.jump.y1.toFixed(2)} → ${out.jump.y2.toFixed(2)} m)`)
    }
    channel.reaches[r.e.id] = out

    const fwd = r.up === r.e.source
    const vMean = v.reduce((s, a) => s + a, 0) / v.length
    const yMid = r.y[STATIONS >> 1]
    const [yA, yB] = fwd ? [r.y[0], r.y[STATIONS]] : [r.y[STATIONS], r.y[0]]
    const loss = r.q > 0 ? r.zu + specificEnergy(r.q, r.p, r.y[0]) - (r.zd + specificEnergy(r.q, r.p, r.y[STATIONS])) : 0
    res.links[r.e.id] = {
      flow: fwd ? r.q : -r.q,
      velocity: vMean,
      headloss: loss,
      dp: loss * rhoG,
      re: (vMean * 4 * hydraulicRadius(r.p, yMid)) / nu,
      f: 0,
      regime: r.q > 0 ? 'turbulent' : 'still',
      pStart: yA * rhoG,
      pEnd: yB * rhoG,
    }
    const yMax = Math.max(...r.y)
    const label = r.e.data!.label
    if (r.p.shape === 'circ' && yMax >= r.p.diameter)
      warnings.push({ id: r.e.id, level: 'info', text: `${label}: running full — pressurised, with ${(yMax - r.p.diameter).toFixed(2)} m of head over its crown at the worst point` })
    else if (r.p.shape !== 'circ' && yMax > r.p.bankHeight)
      warnings.push({ id: r.e.id, level: 'warn', text: `${label}: overtopping — water is ${yMax.toFixed(2)} m deep in a ${r.p.bankHeight} m channel` })
    if (out.vMax > lining(r.p.lining).vMax)
      warnings.push({
        id: r.e.id,
        level: 'warn',
        text: `${label}: ${out.vMax.toFixed(1)} m/s will scour it — this lining (${lining(r.p.lining).name.toLowerCase()}) stands about ${lining(r.p.lining).vMax} m/s`,
      })
  }
  if (jumps.length) warnings.push({ level: 'info', text: `Hydraulic jump in ${jumps.join(', ')}` })

  for (const id of order) {
    const nd = byId.get(id) as ModelNode
    const ins = entering(id)
    const outs = leaving(id)
    const st = structures.get(id)
    const before = main(ins)
    const after = main(outs)
    const yDn = after ? after.y[0] : before ? before.y[STATIONS] : 0
    const yUp = before ? before.y[STATIONS] : yDn
    const q = (before ? ins : outs).reduce((s, r) => s + r.q, 0)
    const depth = nd.data.kind === 'weir' || nd.data.kind === 'gate' ? yUp : after ? yDn : yUp
    const ref = after ?? before
    if (isLake(id)) {
      // positive = the lake is gaining water, the same convention tanks and reservoirs use in the pipe engine
      const p = nd.data.props
      res.nodes[id] = {
        head: lakeLevel(id),
        pressure: nd.data.kind === 'tank' ? (lakeLevel(id) - p.elevation) * rhoG : 0,
        elevation: nd.data.kind === 'tank' ? p.elevation : lakeLevel(id),
        outflow: ins.reduce((s, r) => s + r.q, 0) - outs.reduce((s, r) => s + r.q, 0),
        extra: { channelNet: ins.reduce((s, r) => s + r.q, 0) - outs.reduce((s, r) => s + r.q, 0) },
      }
      continue
    }
    res.nodes[id] = {
      head: z(id) + depth,
      pressure: depth * rhoG,
      elevation: z(id),
      outflow: nd.data.kind === 'inflow' ? -q : (outflow.get(id) ?? 0),
      extra: {
        depth,
        depthUp: yUp,
        depthDn: yDn,
        flow: q,
        froude: ref ? froude(ref.q, ref.p, depth) : 0,
        headOver: st?.headOver ?? 0,
        submerged: st?.submerged ? 1 : 0,
        controlling: st?.yUp != null ? 1 : 0,
      },
    }
    if (st?.submerged) warnings.push({ id, level: 'info', text: `${nd.data.label}: drowned by the tailwater — it no longer measures flow on its own` })
    if (nd.data.kind === 'gate' && st && st.yUp === null && q > 0) warnings.push({ id, level: 'info', text: `${nd.data.label}: the gate lip is clear of the water — it is not controlling anything` })
    if (
      nd.data.kind !== 'junction' &&
      nd.data.kind !== 'gauge' &&
      nd.data.kind !== 'thermo' &&
      nd.data.kind !== 'outlet' &&
      nd.data.kind !== 'inflow' &&
      nd.data.kind !== 'outfall' &&
      nd.data.kind !== 'weir' &&
      nd.data.kind !== 'gate'
    )
      warnings.push({ id, level: 'warn', text: `${nd.data.label}: channels only join channel parts, junctions and gauges — this is treated as a plain joint` })
  }

  const ps = Object.values(res.nodes).map((n) => n.pressure)
  res.pMin = 0
  res.pMax = Math.max(1000, ...ps)
  res.vMax = Math.max(0.5, ...Object.values(res.links).map((l) => l.velocity))
  res.channel = channel
  res.solveMs = performance.now() - t0
  return res
}

/** One continuous water-surface profile through the reaches on either side of `throughId` (an edge or a node). */
export interface ProfileStation {
  dist: number
  bed: number
  surface: number
  normal: number | null
  critical: number
  froude: number
}
export function waterProfile(results: Results, throughId: string): { stations: ProfileStation[]; marks: { dist: number; label: string }[]; jumps: number[] } {
  const all = results.channel?.reaches ?? {}
  const entries = Object.entries(all)
  const start = all[throughId] ? throughId : (entries.find(([, r]) => r.to === throughId) ?? entries.find(([, r]) => r.from === throughId))?.[0]
  if (!start) return { stations: [], marks: [], jumps: [] }
  const biggest = (rs: [string, ReachResult][]) => rs.sort((a, b) => b[1].flow - a[1].flow)[0]
  const chain = [start]
  for (let nxt = biggest(entries.filter(([, r]) => r.to === all[start].from)); nxt && !chain.includes(nxt[0]); nxt = biggest(entries.filter(([, r]) => r.to === all[nxt![0]].from)))
    chain.unshift(nxt[0])
  for (let nxt = biggest(entries.filter(([, r]) => r.from === all[start].to)); nxt && !chain.includes(nxt[0]); nxt = biggest(entries.filter(([, r]) => r.from === all[nxt![0]].to))) chain.push(nxt[0])
  const stations: ProfileStation[] = []
  const marks: { dist: number; label: string }[] = []
  const jumps: number[] = []
  let base = 0
  for (const id of chain) {
    const r = all[id]
    marks.push({ dist: base, label: r.from })
    r.x.forEach((x, i) =>
      stations.push({ dist: base + x, bed: r.bed[i], surface: r.bed[i] + r.depth[i], normal: r.yn === null ? null : r.bed[i] + r.yn, critical: r.bed[i] + r.yc, froude: r.froude[i] }),
    )
    if (r.jump) jumps.push(base + r.jump.x)
    base += r.x[r.x.length - 1]
    if (id === chain[chain.length - 1]) marks.push({ dist: base, label: r.to })
  }
  return { stations, marks, jumps }
}
