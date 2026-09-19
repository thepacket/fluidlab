// Steam layer. The gas engine has already solved pressures and mass flows (with steam-table density, loads that
// condense duty / h_fg, and pipes that condense what their surface loses). This pass follows the *condensate*:
// where it forms, which trap it drains to, whether that trap can cope — and adds up where the boiler's heat went.
import { G, P_ATM, area, frictionFactor } from '../model/physics'
import { flashFraction, hWater, hf, hfg, hg, pSat, rhoSteam, steamSpace, trapType, warmupCondensate, pipeHeatLoss, tSat, throttledTemp, trapCapacity } from '../model/steam'
import { isControl, type Model, type Results } from '../model/types'
import { pipeCondensate } from './gas'
import { command } from './inp'
import type { Thermal } from './thermal'

export interface SteamResults {
  /** per pipe: heat lost to the room (W) and the condensate that makes (kg/s) */
  links: Record<string, { heatLoss: number; condensate: number; tSat: number; /** kg made warming the cold pipe up */ warmup: number }>
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
    returns: { links: {}, receivers: {}, backPressure: {} },
    totals: { generated: 0, heat: 0, useful: 0, mainsLoss: 0, trapLoss: 0, stranded: 0, returned: 0, heatReturned: 0 },
  }
  const thermal: Thermal = { nodes: {}, devices: {}, links: {}, tMin: Infinity, tMax: -Infinity }
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const abs = (gauge: number) => gauge + P_ATM
  const seen = (t: number) => ((thermal.tMin = Math.min(thermal.tMin, t)), (thermal.tMax = Math.max(thermal.tMax, t)), t)

  const firstBoiler = model.nodes.find((n) => n.data.kind === 'reservoir' && res.nodes[n.id])
  const feedTemp = firstBoiler?.data.props.feedTemp ?? 80
  const steamCost = firstBoiler?.data.props.steamCost ?? 35 // per tonne

  for (const [id, n] of Object.entries(res.nodes)) thermal.nodes[id] = seen(tSat(abs(n.pressure)))
  for (const [id, d] of Object.entries(res.devices)) {
    const nd = byId.get(id)!
    const [pIn, pOut] = d.flow >= 0 ? [abs(d.pIn), abs(d.pOut)] : [abs(d.pOut), abs(d.pIn)]
    const tOut = nd.data.kind === 'valve' && Math.abs(d.flow) > 1e-9 && pIn - pOut > 2000 ? throttledTemp(pIn, pOut) : tSat(pOut)
    if (tOut > tSat(pOut) + 0.5) out.throttled[id] = tOut
    thermal.devices[id] = { tIn: seen(tSat(abs(d.pIn))), tOut: seen(tSat(abs(d.pOut))), heat: 0 }
  }

  // ---- condensate made in the pipes, and the way the steam is flowing ----
  const downstream = new Map<string, { to: string; flow: number }[]>()
  const neighbours = new Map<string, string[]>()
  const parcels: { at: string; kg: number; warm: number; from: string }[] = []
  for (const e of model.edges) {
    const l = res.links[e.id]
    if (e.type === 'signal' || !e.data || !l) continue
    const pMean = abs((l.pStart + l.pEnd) / 2)
    const condensate = pipeCondensate(e.data.props, pMean)
    const heatLoss = pipeHeatLoss(e.data.props, tSat(pMean)) * Math.max(0.01, e.data.props.length)
    const warmup = warmupCondensate(e.data.props, pMean)
    out.links[e.id] = { heatLoss, condensate, tSat: tSat(pMean), warmup }
    thermal.links[e.id] = { tStart: seen(tSat(abs(l.pStart))), tEnd: seen(tSat(abs(l.pEnd))) }
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
