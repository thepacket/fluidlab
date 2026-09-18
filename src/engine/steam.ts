// Steam layer. The gas engine has already solved pressures and mass flows (with steam-table density, loads that
// condense duty / h_fg, and pipes that condense what their surface loses). This pass follows the *condensate*:
// where it forms, which trap it drains to, whether that trap can cope — and adds up where the boiler's heat went.
import { P_ATM } from '../model/physics'
import { flashFraction, hWater, hfg, hg, pSat, pipeHeatLoss, tSat, throttledTemp, trapCapacity } from '../model/steam'
import { isControl, type Model, type Results } from '../model/types'
import { pipeCondensate } from './gas'
import type { Thermal } from './thermal'

export interface SteamResults {
  /** per pipe: heat lost to the room (W) and the condensate that makes (kg/s) */
  links: Record<string, { heatLoss: number; condensate: number; tSat: number }>
  loads: Record<string, { duty: number; steam: number; tSat: number; carryover: number; flash: number; short: boolean }>
  traps: Record<string, { load: number; capacity: number; steamLoss: number; lossPower: number; costPerYear: number; flash: number }>
  boilers: Record<string, { steam: number; heat: number; fuel: number }>
  /** °C just after each pressure-reducing or throttling valve (slightly superheated) */
  throttled: Record<string, number>
  totals: { generated: number; heat: number; useful: number; mainsLoss: number; trapLoss: number; stranded: number }
}

const HOURS = 8000 // a plant year

export function solveSteam(model: Model, res: Results): { steam: SteamResults; thermal: Thermal } | undefined {
  if (!res.ok || !model.fluid.steam) return undefined
  const out: SteamResults = { links: {}, loads: {}, traps: {}, boilers: {}, throttled: {}, totals: { generated: 0, heat: 0, useful: 0, mainsLoss: 0, trapLoss: 0, stranded: 0 } }
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
  const parcels: { at: string; kg: number; from: string }[] = []
  for (const e of model.edges) {
    const l = res.links[e.id]
    if (e.type === 'signal' || !e.data || !l) continue
    const pMean = abs((l.pStart + l.pEnd) / 2)
    const condensate = pipeCondensate(e.data.props, pMean)
    const heatLoss = pipeHeatLoss(e.data.props, tSat(pMean)) * Math.max(0.01, e.data.props.length)
    out.links[e.id] = { heatLoss, condensate, tSat: tSat(pMean) }
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
    parcels.push({ at: to, kg: condensate, from: e.data.label })
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
      out.loads[nd.id] = { duty: steam * hfg(pa), steam, tSat: tSat(pa), carryover: 0, flash: flashFraction(pa, P_ATM + (p.backPressure ?? 0)), short }
      out.totals.useful += steam * hfg(pa)
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
        capacity: p.state === 'closed' ? 0 : trapCapacity(p.orifice, pa - P_ATM - (p.backPressure ?? 0)),
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
        break
      }
      if (kind === 'steamload' && out.loads[cur]) {
        out.loads[cur].carryover += parcel.kg
        break
      }
      const drip = (neighbours.get(cur) ?? []).find(working)
      if (drip) {
        out.traps[drip].load += parcel.kg
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
