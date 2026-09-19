// Steam layer. The gas engine has already solved pressures and mass flows (with steam-table density, loads that
// condense duty / h_fg, and pipes that condense what their surface loses). This pass follows the *condensate*:
// where it forms, which trap it drains to, whether that trap can cope — and adds up where the boiler's heat went.
import { G, P_ATM, area, frictionFactor } from '../model/physics'
import { CP_STEAM, flashFraction, hWater, hf, hfg, hg, pSat, rhoSteam, steamSpace, steamTemp, trapType, warmupCondensate, pipeHeatLoss, tSat, trapCapacity } from '../model/steam'
import { isControl, type Model, type Results } from '../model/types'
import { pipeCondensate } from './gas'
import { command } from './inp'
import { thermalNetwork, type Carrier, type Thermal } from './thermal'

export interface SteamResults {
  /** per pipe: heat lost to the room (W) and the condensate that makes (kg/s) */
  links: Record<
    string,
    {
      heatLoss: number
      condensate: number
      /** what it would condense if the steam arrived saturated */ saturated: number
      tSat: number
      /** °C in and out, and K of superheat left at the outlet */ tIn: number
      tOut: number
      superheat: number
      /** kg made warming the cold pipe up */ warmup: number
    }
  >
  loads: Record<
    string,
    {
      duty: number
      steam: number
      tSat: number
      carryover: number
      flash: number
      short: boolean
      /** load fraction, steam-space gauge pressure, and the load fraction below which it cannot drain */ fraction: number
      space: number
      stallAt: number
      stalled: boolean
    }
  >
  traps: Record<string, { load: number; capacity: number; steamLoss: number; lossPower: number; costPerYear: number; flash: number; /** kg arriving while the pipework warms up */ warmup: number }>
  boilers: Record<string, { steam: number; heat: number; fuel: number; /** °C, when returned condensate sets it */ feedTemp?: number }>
  /** °C just after each pressure-reducing or throttling valve (slightly superheated) */
  throttled: Record<string, number>
  /** condensate-return pipework: what each line carries, and the back-pressure it puts on the traps and loads draining into it */
  returns: {
    links: Record<string, { flow: number; flash: number; velocity: number; dp: number }>
    receivers: Record<string, { condensate: number; flashVent: number; heat: number; temp: number }>
    /** condensate pumps: a receiver that lifts its condensate on to another tank through a liquid-filled line */
    pumps: Record<string, { flow: number; head: number; power: number; npsha: number; to: string }>
    /** gauge pressure in the return system at each node it touches, Pa */
    backPressure: Record<string, number>
  }
  totals: { generated: number; heat: number; useful: number; mainsLoss: number; trapLoss: number; stranded: number; returned: number; heatReturned: number }
}

const HOURS = 8000 // a plant year

export function solveSteam(model: Model, res: Results): { steam: SteamResults; thermal: Thermal } | undefined {
  if (!res.ok || !model.fluid.steam) return undefined
  const out: SteamResults = {
    links: {},
    loads: {},
    traps: {},
    boilers: {},
    throttled: {},
    returns: { links: {}, receivers: {}, pumps: {}, backPressure: {} },
    totals: { generated: 0, heat: 0, useful: 0, mainsLoss: 0, trapLoss: 0, stranded: 0, returned: 0, heatReturned: 0 },
  }
  const thermal: Thermal = { nodes: {}, devices: {}, links: {}, tMin: Infinity, tMax: -Infinity }
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const abs = (gauge: number) => gauge + P_ATM
  const seen = (t: number) => ((thermal.tMin = Math.min(thermal.tMin, t)), (thermal.tMax = Math.max(thermal.tMax, t)), t)

  const firstBoiler = model.nodes.find((n) => n.data.kind === 'reservoir' && res.nodes[n.id])
  const feedTemp = firstBoiler?.data.props.feedTemp ?? 80
  const steamCost = firstBoiler?.data.props.steamCost ?? 35 // per tonne

  // ---- energy: carry the steam's enthalpy along the flows ----
  // A boiler may superheat; a throttling valve keeps enthalpy while dropping pressure, which leaves the steam superheated
  // too. Either way a pipe has to take that superheat out before it can condense anything, and the steam stays hotter
  // than saturation until it has.
  const net = thermalNetwork(model, res)
  const pAt = (k: string) => {
    const [id, end] = k.split(':')
    return abs(end ? (end === 'out' ? res.devices[id].pOut : res.devices[id].pIn) : res.nodes[id].pressure)
  }
  const H = new Map<string, number>()
  for (const k of net.points) H.set(k, hg(pAt(k)))
  for (const [k, n] of net.fixed) if (n.data.kind === 'reservoir') H.set(k, hg(pAt(k)) + CP_STEAM * Math.max(0, n.data.props.superheat ?? 0))
  const edgeOf = new Map(model.edges.map((e) => [e.id, e]))
  const made = new Map<string, number>() // condensate formed in each pipe, kg/s
  const lost = new Map<string, number>()
  const arriving = (c: Carrier, hIn: number): number => {
    if (!c.edge) return hIn // an inline part throttles: same enthalpy, lower pressure
    const p = edgeOf.get(c.edge)!.data!.props
    const len = Math.max(0.01, p.length)
    const dry = hg(pAt(c.to))
    // The first stretch of the pipe runs hotter than saturation and only cools; once the superheat is spent the rest
    // runs at saturation temperature and condenses. Find how much of the length the superheat lasts for.
    const spare = c.q * Math.max(0, hIn - dry)
    const qHot = pipeHeatLoss(p, (steamTemp(hIn, pAt(c.from)) + tSat(pAt(c.to))) / 2) * len
    const qSat = pipeHeatLoss(p, tSat((pAt(c.from) + pAt(c.to)) / 2)) * len
    const hotShare = qHot > 0 ? Math.min(1, spare / qHot) : 1
    const q = hotShare >= 1 ? qHot : spare + (1 - hotShare) * qSat
    const hOut = hIn - q / c.q
    lost.set(c.edge, q)
    made.set(c.edge, hotShare >= 1 ? 0 : ((1 - hotShare) * qSat) / hfg(pAt(c.to)))
    return Math.max(hOut, dry) // what travels on is dry steam; the condensate goes to the traps
  }
  const carriers = net.carriers.filter((c) => c.q > 0)
  const feeding = new Map<string, Carrier[]>()
  for (const c of carriers) feeding.set(c.to, [...(feeding.get(c.to) ?? []), c])
  for (let sweep = 0; sweep < 100; sweep++) {
    let change = 0
    for (const [k, list] of feeding) {
      if (net.fixed.has(k)) continue
      const h = list.reduce((s, c) => s + c.q * arriving(c, H.get(c.from)!), 0) / list.reduce((s, c) => s + c.q, 0)
      change = Math.max(change, Math.abs(h - H.get(k)!))
      H.set(k, h)
    }
    if (change < 1) break
  }
  const tempAt = (k: string) => steamTemp(H.get(k) ?? hg(pAt(k)), pAt(k))
  for (const id of Object.keys(res.nodes)) if (net.points.has(id)) thermal.nodes[id] = seen(tempAt(id))
  for (const [id, d] of Object.entries(res.devices)) {
    const [a, b] = d.flow >= 0 ? [`${id}:in`, `${id}:out`] : [`${id}:out`, `${id}:in`]
    const tOut = tempAt(b)
    if (tOut > tSat(pAt(b)) + 0.5) out.throttled[id] = tOut
    thermal.devices[id] = { tIn: seen(tempAt(a)), tOut: seen(tOut), heat: 0 }
  }

  // ---- condensate made in the pipes, and the way the steam is flowing ----
  const downstream = new Map<string, { to: string; flow: number }[]>()
  const neighbours = new Map<string, string[]>()
  const parcels: { at: string; kg: number; warm: number; from: string }[] = []
  for (const e of model.edges) {
    const l = res.links[e.id]
    if (e.type === 'signal' || !e.data || !l) continue
    const pMean = abs((l.pStart + l.pEnd) / 2)
    const saturated = pipeCondensate(e.data.props, pMean)
    // a pipe with no flow in it still loses heat and still condenses: fall back on the saturated figure there
    const condensate = made.get(e.id) ?? saturated
    const heatLoss = lost.get(e.id) ?? pipeHeatLoss(e.data.props, tSat(pMean)) * Math.max(0.01, e.data.props.length)
    const warmup = warmupCondensate(e.data.props, pMean)
    const [kA, kB] = [net.key(e.source, e.sourceHandle), net.key(e.target, e.targetHandle)]
    const [tA, tB] = [net.points.has(kA) ? tempAt(kA) : tSat(abs(l.pStart)), net.points.has(kB) ? tempAt(kB) : tSat(abs(l.pEnd))]
    const [tIn, tOut, pOutAbs] = l.flow >= 0 ? [tA, tB, abs(l.pEnd)] : [tB, tA, abs(l.pStart)]
    out.links[e.id] = { heatLoss, condensate, saturated, tSat: tSat(pMean), tIn, tOut, superheat: Math.max(0, tOut - tSat(pOutAbs)), warmup }
    thermal.links[e.id] = { tStart: seen(tA), tEnd: seen(tB) }
    out.totals.mainsLoss += heatLoss
    const [from, to] = l.flow >= 0 ? [e.source, e.target] : [e.target, e.source]
    if (Math.abs(l.flow) > 1e-9) {
      if (!downstream.has(from)) downstream.set(from, [])
      downstream.get(from)!.push({ to, flow: Math.abs(l.flow) })
    }
    for (const [a, b] of [
      [e.source, e.target],
      [e.target, e.source],
    ]) {
      if (!neighbours.has(a)) neighbours.set(a, [])
      neighbours.get(a)!.push(b)
    }
    parcels.push({ at: to, kg: condensate, warm: warmup, from: e.data.label })
  }

  // ---- loads and traps ----
  for (const nd of model.nodes) {
    const r = res.nodes[nd.id]
    if (!r || isControl(nd.data.kind)) continue
    const p = nd.data.props
    const pa = abs(r.pressure)
    if (nd.data.kind === 'steamload') {
      const steam = Math.max(0, r.outflow)
      const short = tSat(pa) < p.processTemp + 5
      const fraction = Math.min(1, Math.max(0, (p.load ?? 1) * command(model, nd.id)))
      const space = steamSpace(pa, p.processTemp, fraction)
      out.loads[nd.id] = {
        duty: steam * hfg(space),
        steam,
        tSat: tSat(space),
        carryover: 0,
        flash: flashFraction(space, P_ATM + (p.backPressure ?? 0)),
        short,
        fraction,
        space: space - P_ATM,
        stallAt: 0,
        stalled: false,
      }
      out.totals.useful += steam * hfg(space)
      if (short)
        res.warnings.push({
          id: nd.id,
          level: 'warn',
          text: `${nd.data.label}: steam arrives at ${tSat(pa).toFixed(0)} °C — too cool to heat the process to ${p.processTemp} °C. It needs at least ${((pSat(p.processTemp + 5) - P_ATM) / 1000).toFixed(0)} kPa here`,
        })
    } else if (nd.data.kind === 'trap') {
      const steamLoss = Math.max(0, r.outflow)
      const lossPower = steamLoss * (hg(pa) - hWater(feedTemp))
      out.traps[nd.id] = {
        load: 0,
        capacity: p.state === 'closed' ? 0 : trapType(p.trapType).capacity * trapCapacity(p.orifice, pa - P_ATM - (p.backPressure ?? 0)),
        warmup: 0,
        steamLoss,
        lossPower,
        costPerYear: (steamLoss * 3600 * HOURS * steamCost) / 1000,
        flash: flashFraction(pa, P_ATM + (p.backPressure ?? 0)),
      }
      out.totals.trapLoss += lossPower
      if (steamLoss > 1e-6)
        res.warnings.push({
          id: nd.id,
          level: 'warn',
          text: `${nd.data.label}: failed open — blowing ${(steamLoss * 3600).toFixed(0)} kg/h of live steam, about ${Math.round(out.traps[nd.id].costPerYear).toLocaleString('en-US')} a year`,
        })
    } else if (nd.data.kind === 'reservoir') {
      const steam = Math.max(0, -r.outflow)
      const heat = steam * (hg(pa) - hWater(p.feedTemp ?? 80))
      out.boilers[nd.id] = { steam, heat, fuel: heat / Math.max(0.3, p.boilerEfficiency ?? 0.82) }
      out.totals.generated += steam
      out.totals.heat += heat
    }
  }

  // ---- walk every parcel of condensate to the trap that will take it ----
  const working = (id: string) => byId.get(id)?.data.kind === 'trap' && byId.get(id)!.data.props.state !== 'closed' && !!res.nodes[id]
  const stranded = new Map<string, number>()
  for (const parcel of parcels) {
    let cur = parcel.at
    const visited = new Set<string>()
    for (;;) {
      const kind = byId.get(cur)?.data.kind
      if (working(cur)) {
        out.traps[cur].load += parcel.kg
        out.traps[cur].warmup += parcel.warm
        break
      }
      if (kind === 'steamload' && out.loads[cur]) {
        out.loads[cur].carryover += parcel.kg
        break
      }
      const drip = (neighbours.get(cur) ?? []).find(working)
      if (drip) {
        out.traps[drip].load += parcel.kg
        out.traps[drip].warmup += parcel.warm
        break
      }
      visited.add(cur)
      const next = (downstream.get(cur) ?? []).filter((d) => !visited.has(d.to)).sort((a, b) => b.flow - a.flow)[0]
      if (!next) {
        stranded.set(cur, (stranded.get(cur) ?? 0) + parcel.kg)
        out.totals.stranded += parcel.kg
        break
      }
      cur = next.to
    }
  }
  for (const [id, kg] of stranded) {
    const nd = byId.get(id)
    if (nd && kg * 3600 > 0.05)
      res.warnings.push({ id, level: 'warn', text: `${nd.data.label}: ${(kg * 3600).toFixed(1)} kg/h of condensate collects here with no working trap to drain it — that is how water hammer starts` })
  }
  // ---- condensate return: two-phase lines from the traps and loads back to a vented receiver ----
  const ret = model.edges.filter((e) => e.type !== 'signal' && e.data?.props.conduit === 'condensate')
  if (ret.length) {
    const next = new Map<string, { other: string; e: (typeof ret)[number] }[]>()
    for (const e of ret)
      for (const [a, b] of [
        [e.source, e.target],
        [e.target, e.source],
      ]) {
        if (!next.has(a)) next.set(a, [])
        next.get(a)!.push({ other: b, e })
      }
    // walk out from every receiver: that gives each node the line that leads home, and an order to work back along
    const home = new Map<string, { to: string; e: (typeof ret)[number] }>()
    const order: string[] = []
    const receivers = [...next.keys()].filter((id) => byId.get(id)?.data.kind === 'tank')
    const queue = [...receivers]
    const seenNode = new Set(queue)
    while (queue.length) {
      const cur = queue.shift()!
      order.push(cur)
      for (const { other, e } of next.get(cur) ?? []) {
        if (seenNode.has(other)) continue
        seenNode.add(other)
        home.set(other, { to: cur, e })
        queue.push(other)
      }
    }
    // what each line carries: mass, and the enthalpy it left the steam space with
    const mass = new Map<string, number>()
    const enthalpy = new Map<string, number>()
    const arriving = new Map<string, [number, number]>(receivers.map((id) => [id, [0, 0]]))
    for (const id of seenNode) {
      const kg = out.traps[id] ? out.traps[id].load : out.loads[id] ? out.loads[id].steam + out.loads[id].carryover : 0
      if (kg <= 0 || !res.nodes[id]) continue
      const h = kg * hf(abs(res.nodes[id].pressure))
      let cur = id
      while (home.has(cur)) {
        const { to, e } = home.get(cur)!
        mass.set(e.id, (mass.get(e.id) ?? 0) + kg)
        enthalpy.set(e.id, (enthalpy.get(e.id) ?? 0) + h)
        cur = to
      }
      const got = arriving.get(cur)
      if (got) arriving.set(cur, [got[0] + kg, got[1] + h])
    }
    const pRet = new Map<string, number>()
    for (const id of receivers) pRet.set(id, P_ATM + (byId.get(id)!.data.props.backPressure ?? 0))
    for (const id of order) {
      const link = home.get(id)
      if (!link) continue
      const pDown = pRet.get(link.to)!
      const p = link.e.data!.props
      const kg = mass.get(link.e.id) ?? 0
      // hot condensate dropping into a lower pressure flashes: the line carries a little steam that takes nearly all the room
      const lift = Math.max(0, (byId.get(link.to)?.data.props.elevation ?? 0) - (byId.get(id)?.data.props.elevation ?? 0)) * 950 * G
      // the flash fraction, and with it the density, belongs to the pressure half-way along the line: a short relaxed loop settles it
      let [x, v, f, dp] = [0, 0, 0, 0]
      let mid = 0 // pressure rise to the middle of the line, relaxed so the loop settles instead of hunting
      for (let pass = 0; pass < 25; pass++) {
        mid += 0.5 * (dp / 2 - mid)
        const pm = pDown + mid
        x = kg > 0 ? Math.min(1, Math.max(0, (enthalpy.get(link.e.id)! / kg - hf(pm)) / hfg(pm))) : 0
        const rho = 1 / (x / rhoSteam(pm) + (1 - x) / 950)
        v = kg / (rho * area(p.diameter))
        const mu = 1 / (x / 1.3e-5 + (1 - x) / 2.8e-4)
        f = frictionFactor(Math.max(3000, (kg * p.diameter) / (area(p.diameter) * mu)), (p.roughness ?? 0.045e-3) / p.diameter)
        dp = ((f * p.length) / p.diameter + (p.minorK ?? 0)) * 0.5 * rho * v * v + (kg > 0 ? lift : 0)
      }
      pRet.set(id, pDown + dp)
      out.returns.links[link.e.id] = { flow: kg, flash: x, velocity: v, dp }
      const forward = link.e.source === id
      res.links[link.e.id] = {
        flow: forward ? kg : -kg,
        velocity: v,
        headloss: dp / (1000 * G),
        dp,
        re: 0,
        f,
        regime: kg > 0 ? 'turbulent' : 'still',
        pStart: (forward ? pDown + dp : pDown) - P_ATM,
        pEnd: (forward ? pDown : pDown + dp) - P_ATM,
      }
      if (v > 25)
        res.warnings.push({
          id: link.e.id,
          level: 'warn',
          text: `${link.e.data!.label}: ${v.toFixed(0)} m/s — return lines are sized on their flash steam (${(x * 100).toFixed(0)} % by mass here), not on the water`,
        })
    }
    for (const [id, p] of pRet) out.returns.backPressure[id] = p - P_ATM
    for (const id of receivers) {
      const [kg, h] = arriving.get(id)!
      const pr = pRet.get(id)!
      const flash = kg > 0 ? Math.min(1, Math.max(0, (h / kg - hf(pr)) / hfg(pr))) : 0
      const liquid = kg * (1 - flash)
      out.returns.receivers[id] = { condensate: liquid, flashVent: kg * flash, heat: liquid * (hf(pr) - hWater(15)), temp: tSat(pr) }
      out.totals.returned += liquid
      out.totals.heatReturned += liquid * (hf(pr) - hWater(15))
      res.nodes[id] = { head: (pr - P_ATM) / (1000 * G), pressure: pr - P_ATM, elevation: byId.get(id)!.data.props.elevation ?? 0, outflow: 0 }
      thermal.nodes[id] = seen(tSat(pr))
    }
    // ---- pumped return: a receiver with a condensate pump sends its (now flash-free) water on to another tank ----
    // The traps upstream only have to reach the vented receiver; the lift and the long run home are the pump's problem.
    const twoPhase = new Set([...mass].filter(([, kg]) => kg > 0).map(([edge]) => edge)) // lines already carrying trap discharge
    for (const id of receivers) {
      const nd = byId.get(id)!
      if (!nd.data.props.pumped) continue
      // breadth-first along return lines that carry nothing else, to the nearest tank without a pump of its own
      const trail = new Map<string, { from: string; e: (typeof ret)[number] }>()
      const q = [id]
      let dest: string | undefined
      while (q.length && !dest) {
        const cur = q.shift()!
        for (const { other, e } of next.get(cur) ?? []) {
          if (twoPhase.has(e.id) || trail.has(other) || other === id) continue
          trail.set(other, { from: cur, e })
          if (byId.get(other)?.data.kind === 'tank' && !byId.get(other)!.data.props.pumped) {
            dest = other
            break
          }
          q.push(other)
        }
      }
      const rx = out.returns.receivers[id]
      if (!dest) {
        res.warnings.push({ id, level: 'warn', text: `${nd.data.label}: its condensate pump has nowhere to deliver — run a return line from it to a feed tank` })
        continue
      }
      const kg = rx.condensate
      const rho = 960 // water just under boiling
      let headM = ((byId.get(dest)!.data.props.backPressure ?? 0) - (nd.data.props.backPressure ?? 0)) / (rho * G)
      for (let cur = dest; cur !== id; cur = trail.get(cur)!.from) {
        const { from, e } = trail.get(cur)!
        const p = e.data!.props
        const v = kg / (rho * area(p.diameter))
        const f = frictionFactor(Math.max(3000, (rho * v * p.diameter) / 2.9e-4), (p.roughness ?? 0.045e-3) / p.diameter)
        const dp = ((f * p.length) / p.diameter + (p.minorK ?? 0)) * 0.5 * rho * v * v
        const rise = (byId.get(cur)?.data.props.elevation ?? 0) - (byId.get(from)?.data.props.elevation ?? 0)
        headM += dp / (rho * G) + rise
        out.returns.links[e.id] = { flow: kg, flash: 0, velocity: v, dp: dp + rise * rho * G }
        const forward = e.source === from
        res.links[e.id] = { flow: forward ? kg : -kg, velocity: v, headloss: dp / (rho * G), dp, re: (rho * v * p.diameter) / 2.9e-4, f, regime: kg > 0 ? 'turbulent' : 'still', pStart: 0, pEnd: 0 }
      }
      const npsha = Math.max(0, nd.data.props.suctionHead ?? 1) // a vented receiver holds water at its boiling point: only its height above the pump counts
      out.returns.pumps[id] = { flow: kg, head: Math.max(0, headM), power: (kg * G * Math.max(0, headM)) / 0.5, npsha, to: dest }
      if (kg > 0 && npsha < (nd.data.props.npshr ?? 2))
        res.warnings.push({
          id,
          level: 'error',
          text: `${nd.data.label}: condensate at ${rx.temp.toFixed(0)} °C is on the point of boiling, and ${npsha.toFixed(1)} m of height over the pump is less than the ${nd.data.props.npshr ?? 2} m it needs — it will cavitate. Raise the receiver`,
        })
      // what it forwards is counted where it ends up
      const home2 = out.returns.receivers[dest] ?? (out.returns.receivers[dest] = { condensate: 0, flashVent: 0, heat: 0, temp: rx.temp })
      home2.condensate += kg
      home2.heat += rx.heat
      home2.temp = rx.temp
      if (!res.nodes[dest]) res.nodes[dest] = { head: 0, pressure: byId.get(dest)!.data.props.backPressure ?? 0, elevation: byId.get(dest)!.data.props.elevation ?? 0, outflow: 0 }
    }
    // the return line's pressure is what the traps and loads really discharge against
    for (const [id, bp] of Object.entries(out.returns.backPressure)) {
      const r = res.nodes[id]
      const nd = byId.get(id)
      if (!r || !nd) continue
      const pa = abs(r.pressure)
      if (out.traps[id]) {
        out.traps[id].capacity = nd.data.props.state === 'closed' ? 0 : trapType(nd.data.props.trapType).capacity * trapCapacity(nd.data.props.orifice, r.pressure - bp)
        out.traps[id].flash = flashFraction(pa, P_ATM + bp)
      }
      if (out.loads[id]) out.loads[id].flash = flashFraction(abs(out.loads[id].space), P_ATM + bp)
    }
  }
  // stall: a load throttled back far enough has a steam space no hotter than it needs — and once that pressure is
  // no more than what stands in the return, the condensate has nothing to push it out
  for (const [id, l] of Object.entries(out.loads)) {
    const nd = byId.get(id)!
    const bp = out.returns.backPressure[id] ?? nd.data.props.backPressure ?? 0
    const supply = abs(res.nodes[id].pressure)
    const tp = nd.data.props.processTemp
    l.stallAt = Math.min(1, Math.max(0, (tSat(P_ATM + bp) - tp) / Math.max(1, tSat(supply) - tp)))
    l.stalled = l.steam > 0 && l.space <= bp + 2000
    if (l.stalled)
      res.warnings.push({
        id,
        level: 'error',
        text: `${nd.data.label}: stalled — at ${(l.fraction * 100).toFixed(0)} % load its steam space is down to ${(l.space / 1000).toFixed(0)} kPa, no more than the ${(bp / 1000).toFixed(0)} kPa behind its trap, so the condensate cannot drain and the exchanger floods`,
      })
  }
  // trap types are not interchangeable
  for (const [id, t] of Object.entries(out.traps)) {
    const nd = byId.get(id)!
    if (nd.data.props.state !== 'ok') continue
    const type = trapType(nd.data.props.trapType)
    const bp = out.returns.backPressure[id] ?? nd.data.props.backPressure ?? 0
    const working = type.workingLoss
    t.steamLoss += working
    t.lossPower += working * (hg(abs(res.nodes[id].pressure)) - hWater(feedTemp))
    t.costPerYear += (working * 3600 * HOURS * steamCost) / 1000
    out.totals.trapLoss += working * (hg(abs(res.nodes[id].pressure)) - hWater(feedTemp))
    if (bp > type.maxBack * Math.max(1, res.nodes[id].pressure))
      res.warnings.push({
        id,
        level: 'warn',
        text: `${nd.data.label}: ${(bp / 1000).toFixed(0)} kPa of back-pressure is more than a ${type.name.toLowerCase()} trap tolerates (${(type.maxBack * 100).toFixed(0)} % of its inlet) — it will not shut, and blows steam`,
      })
    if (type.holdsBack && t.load > 0)
      res.warnings.push({
        id,
        level: 'info',
        text: `${nd.data.label}: a thermostatic trap waits for its condensate to cool before it opens, so water stands in the drip leg — on a main, fit a float or thermodynamic trap`,
      })
    const startUp = t.warmup / 900 + t.load // the usual quarter-hour warm-up
    if (startUp > t.capacity && t.load <= t.capacity)
      res.warnings.push({
        id,
        level: 'info',
        text: `${nd.data.label}: fine once hot, but warming the pipework from cold sends it ${(startUp * 3600).toFixed(0)} kg/h for a quarter of an hour — more than the ${(t.capacity * 3600).toFixed(0)} kg/h it passes. Warm up slowly, or size for start-up`,
      })
  }
  // a boiler fed with returned condensate starts from hotter water
  for (const [id, b] of Object.entries(out.boilers)) {
    if (out.totals.returned <= 0 || b.steam <= 0) continue
    const nd = byId.get(id)!
    const share = Math.min(1, out.totals.returned / Math.max(out.totals.generated, 1e-9))
    const hFeed = share * (out.totals.heatReturned / out.totals.returned + hWater(15)) + (1 - share) * hWater(15)
    const heat = b.steam * (hg(abs(res.nodes[id].pressure)) - hFeed)
    out.totals.heat += heat - b.heat
    out.boilers[id] = { steam: b.steam, heat, fuel: heat / Math.max(0.3, nd.data.props.boilerEfficiency ?? 0.82), feedTemp: hFeed / 4190 }
  }

  for (const [id, t] of Object.entries(out.traps)) {
    const nd = byId.get(id)!
    if (nd.data.props.state === 'closed') res.warnings.push({ id, level: 'warn', text: `${nd.data.label}: blocked — nothing drains here, so the condensate travels on with the steam` })
    if (nd.data.props.state === 'ok' && t.load > t.capacity)
      res.warnings.push({
        id,
        level: 'warn',
        text: `${nd.data.label}: undersized — ${(t.load * 3600).toFixed(1)} kg/h arrives but it can pass ${(t.capacity * 3600).toFixed(1)} kg/h; condensate backs up into the main`,
      })
  }
  for (const [id, l] of Object.entries(out.loads)) {
    if (l.carryover > 0.03 * Math.max(l.steam, 1e-9) && l.carryover * 3600 > 0.5)
      res.warnings.push({
        id,
        level: 'info',
        text: `${byId.get(id)!.data.label}: ${(l.carryover * 3600).toFixed(1)} kg/h of pipe condensate arrives with the steam — a drip trap before it would deliver it dry`,
      })
  }
  if (!isFinite(thermal.tMin)) [thermal.tMin, thermal.tMax] = [100, 180]
  if (thermal.tMax - thermal.tMin < 1) thermal.tMax = thermal.tMin + 1
  return { steam: out, thermal }
}
