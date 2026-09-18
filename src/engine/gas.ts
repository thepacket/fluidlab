// Gas network engine: steady, isothermal, compressible flow on the same model the liquid engines use.
//
// A gas expands as it loses pressure, so head loss is no longer proportional to Q². Along an isothermal pipe the
// momentum equation integrates to
//     p₁² − p₂² = (f·L/D + ΣK) · ṁ²·Z·R·T / A²
// — the squared absolute pressures do the job that heads do for a liquid. Everything is solved in mass flow and
// absolute pressure; flows are reported as *standard* volume flow (15 °C, 1 atm), the way gas is metered.
//
// Same bench, different meaning: a reservoir is a pressure source, a pump is a compressor (pressure ratio instead of
// head), a PRV is a regulator with a little droop, a pressure vessel is a receiver, and a nozzle chokes once the
// pressure ratio across it passes the critical value. Elevation is ignored — a gas column weighs almost nothing.
//
// Method: unknown pressures at the free nodes, mass balance as the residual, damped Newton with a numerical
// Jacobian (rigs are small), wrapped in a short loop that refreshes the friction factors.
import { dischargeDevice, lossDevice } from '../model/catalog'
import { G, P_ATM, area, elementK, fittingK, frictionFactor, meterK, ratedDp, regimeOf, valveK } from '../model/physics'
import { EMPTY_RESULTS, isControl, isInline, type Fluid, type Model, type ModelNode, type Props, type Results, type Warning } from '../model/types'
import { hfg, pipeHeatLoss, rhoSteam, tSat } from '../model/steam'
import { command, commandedOff, valvePosition, type Overrides } from './inp'

const R_UNIVERSAL = 8.314462618
export const T_STD = 288.15

/** Z·R_specific·T for the gas at its working temperature — the group that turns pressure into density. */
export const zrt = (f: Fluid, pAbs?: number) => (f.steam && pAbs ? pAbs / rhoSteam(pAbs) : ((f.gas!.z * R_UNIVERSAL) / f.gas!.molarMass) * f.gas!.temperature)
/** Density at standard conditions: converts mass flow to standard volume flow. */
export const rhoStd = (f: Fluid) => (f.steam ? 1 : (P_ATM * f.gas!.molarMass) / (R_UNIVERSAL * T_STD)) // steam is metered by mass: 1 "m³" ≡ 1 kg
/** Rate of pressure rise (Pa/s) in a receiver of this volume taking in `qStd` of standard flow. */
export const receiverRate = (f: Fluid, volume: number, qStd: number) => (qStd * rhoStd(f) * zrt(f)) / Math.max(1e-6, volume)

/** Steam condensing in a pipe (kg/s): the heat its surface loses, divided by what each kilogram gives up. */
export const pipeCondensate = (p: Props, pAbs: number) => (pipeHeatLoss(p, tSat(pAbs)) * Math.max(0.01, p.length)) / hfg(pAbs)

/** Compressor map, same shape as the pump's: pressure ratio falls from shut-off as flow rises. Returns standard flow. */
export function compressorFlow(ratio: number, p: Props, speed: number): number {
  const rd = Math.max(1.01, p.pressureRatio ?? 2.5)
  const x = 3 * ((4 / 3) * speed * speed - (ratio - 1) / (rd - 1))
  return x > 0 ? p.designFlow * Math.sqrt(x) : 0
}
export const compressorRatio = (q: number, p: Props, speed: number) => 1 + (Math.max(1.01, p.pressureRatio ?? 2.5) - 1) * ((4 / 3) * speed * speed - (q / p.designFlow) ** 2 / 3)

/** Mass flow through an orifice of effective area CdA from absolute p_up to p_down: subcritical or choked. */
export function orificeFlow(cdA: number, pUp: number, pDown: number, f: Fluid): { mdot: number; choked: boolean } {
  if (pUp <= pDown || cdA <= 0) return { mdot: 0, choked: false }
  const g = f.gas!.gamma
  const r = pDown / pUp
  const rc = Math.pow(2 / (g + 1), g / (g - 1))
  if (r <= rc) return { mdot: cdA * pUp * Math.sqrt(g / zrt(f, pUp)) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1))), choked: true }
  return { mdot: cdA * pUp * Math.sqrt(((2 * g) / ((g - 1) * zrt(f, pUp))) * (Math.pow(r, 2 / g) - Math.pow(r, (g + 1) / g))), choked: false }
}

interface GNode {
  key: string
  fixed: boolean
  p: number // absolute, Pa
  demand: number // kg/s leaving
  cdA: number // vent to atmosphere
  /** steam load: heat duty (W), met by condensing duty / h_fg(p) of steam */
  duty?: number
  /** steam condensing in the pipes that end here, kg/s */
  cond: number
  relief?: { set: number; cdA: number }
}
interface GLink {
  id: string
  a: number
  b: number
  kind: 'pipe' | 'loss' | 'closed' | 'compressor' | 'prv' | 'psv' | 'fcv'
  /** (f·L/D + K) / A² — the resistance in p² terms, before ZRT */
  res: number
  noReverse: boolean
  props: Props
  speed: number
  mdot: number
  pipe?: { length: number; diameter: number; roughness: number; minorK: number }
}

const EPS = 1e5 // Pa²: smooths the square-root law where the pressure difference vanishes

export function solveGas(model: Model, overrides: Overrides = {}): Results {
  const t0 = performance.now()
  const fluid = model.fluid
  const ZRT = zrt(fluid)
  const rs = rhoStd(fluid)
  const warnings: Warning[] = []

  // ---- network ----
  const nodes: GNode[] = []
  const index = new Map<string, number>()
  const add = (key: string, p = NaN): GNode => {
    const n: GNode = { key, fixed: false, p, demand: 0, cdA: 0, cond: 0 }
    index.set(key, nodes.length)
    nodes.push(n)
    return n
  }
  const links: GLink[] = []
  let ejector = false
  const onBore = (K: number, d: number) => K / area(d) ** 2

  for (const nd of model.nodes) {
    const kind = nd.data.kind
    if (isControl(kind)) continue
    const p = nd.data.props
    if (isInline(kind)) {
      add(`${nd.id}:in`)
      add(`${nd.id}:out`)
      const a = index.get(`${nd.id}:in`)!
      const b = index.get(`${nd.id}:out`)!
      const link: GLink = { id: nd.id, a, b, kind: 'loss', res: 0, noReverse: false, props: p, speed: 0, mdot: 0 }
      if (kind === 'pump') {
        link.speed = overrides.pumpSpeed?.[nd.id] ?? p.speed * command(model, nd.id)
        link.kind = p.on && link.speed >= 0.01 ? 'compressor' : 'closed'
        link.noReverse = true
      } else if (kind === 'dpgauge') link.kind = 'closed'
      else if (kind === 'meter') link.res = onBore(meterK(p), p.diameter)
      else if (kind === 'element') link.res = onBore(elementK(p), p.diameter)
      else if (kind === 'fitting') {
        const spec = lossDevice(p.variant)
        if (spec.model === 'k') {
          const { bore, K } = fittingK(p, spec.byDiameters)
          link.res = onBore(K, bore)
        } else link.res = onBore(ratedDp(p.ratedFlow, p) / (500 * (p.ratedFlow / area(p.diameter)) ** 2), p.diameter) // the datasheet point, read as a K
      } else if (kind === 'valve') {
        const type = p.valveType
        if (type === 'throttle' || type === 'float' || type === 'picv') {
          const K = valveK(valvePosition(model, nd.id), p.kOpen, p.trim)
          if (isFinite(K)) link.res = onBore(K, p.diameter)
          else link.kind = 'closed'
        } else if (commandedOff(model, nd.id)) link.kind = 'closed'
        else {
          link.res = onBore(Math.max(0.1, p.kOpen), p.diameter)
          if (type === 'check') link.noReverse = true
          else link.kind = type as 'prv' | 'psv' | 'fcv'
        }
      }
      links.push(link)
      continue
    }
    const n = add(nd.id)
    if (kind === 'tee' || kind === 'threeway' || kind === 'jetpump') {
      // the hub is the common port; every other port reaches it through its own loss, as in the liquid engine
      const handles = new Set<string>()
      for (const e of model.edges) {
        if (e.type === 'signal') continue
        if (e.source === nd.id && e.sourceHandle) handles.add(e.sourceHandle)
        if (e.target === nd.id && e.targetHandle) handles.add(e.targetHandle)
      }
      for (const h of handles) {
        if ((kind === 'threeway' && h === 'ab') || (kind === 'jetpump' && h === 'd')) continue
        add(`${nd.id}:${h}`)
        const link: GLink = { id: `${nd.id}:${h}`, a: index.get(`${nd.id}:${h}`)!, b: index.get(nd.id)!, kind: 'loss', res: 0, noReverse: false, props: p, speed: 0, mdot: 0 }
        if (kind === 'tee') link.res = onBore(h === 'l' || h === 'r' ? p.kRun / 2 : p.kBranch, p.diameter)
        else if (kind === 'threeway') {
          const x = Math.min(1, Math.max(0, p.position * command(model, nd.id)))
          const K = valveK(h === 'a' ? x : 1 - x, p.kOpen, p.trim)
          if (isFinite(K)) link.res = onBore(K, p.diameter)
          else link.kind = 'closed'
        } else {
          // a gas ejector's entrainment is a compressible-flow problem of its own: here it only costs pressure
          link.res = h === 'm' ? onBore(1 + p.kn, p.nozzleDiameter) : (1 + p.ks) / Math.max(1e-9, area(p.throatDiameter) - area(p.nozzleDiameter)) ** 2
          if (h === 's') link.noReverse = true
          ejector = true
        }
        links.push(link)
      }
      continue
    }
    if (kind === 'reservoir') {
      n.fixed = true
      n.p = P_ATM + Math.max(0, p.pressure ?? 400e3)
    } else if (kind === 'vessel') {
      n.fixed = true
      n.p = model.levels?.[`${nd.id}:gas`] ?? P_ATM + p.initPressure
    } else if (kind === 'tank') {
      // in a steam system an open tank is the condensate receiver: the steam layer looks after it
      if (!fluid.steam) warnings.push({ id: nd.id, level: 'warn', text: `${nd.data.label}: an open tank cannot hold gas — use a pressure vessel as a receiver` })
    } else if (kind === 'junction') n.demand = (p.demand ?? 0) * rs
    else if (kind === 'outlet') {
      if (commandedOff(model, nd.id) || (dischargeDevice(p.variant)?.glyph === 'sprinkler' && !p.fused)) n.cdA = 0
      else if (p.mode === 'demand') n.demand = p.demand * rs
      // a K-factor is a water rating: Q = K√p = Cd·A·√(2p/ρ_w) gives the equivalent orifice
      else n.cdA = p.mode === 'kfactor' ? p.kFactor * Math.sqrt(500) : p.cd * area(p.nozzleDiameter)
    } else if (kind === 'steamload') n.duty = fluid.steam ? Math.max(0, p.duty) : 0
    else if (kind === 'trap') n.cdA = p.state === 'open' ? 0.7 * area(p.orifice) : 0
    else if (kind === 'leak') n.cdA = p.active === false ? 0 : p.cd * area(p.holeDiameter)
    else if (kind === 'relief') n.relief = { set: P_ATM + p.setPressure, cdA: 0.7 * area(p.diameter) }
  }

  if (ejector) warnings.push({ level: 'info', text: 'Jet pumps only cost pressure in a gas network — entrainment by a gas jet is not modelled' })
  const port = (id: string, handle?: string | null) => index.get(`${id}:${handle}`) ?? (index.has(id) ? index.get(id) : index.get(`${id}:${handle === 'out' ? 'out' : 'in'}`))
  for (const e of model.edges) {
    if (e.type === 'signal' || !e.data || e.data.props.conduit === 'condensate') continue
    const a = port(e.source, e.sourceHandle)
    const b = port(e.target, e.targetHandle)
    if (a === undefined || b === undefined || a === b) continue
    const p = e.data.props
    links.push({
      id: e.id,
      a,
      b,
      kind: 'pipe',
      res: 0,
      noReverse: false,
      props: p,
      speed: 0,
      mdot: 0,
      pipe: { length: Math.max(0.01, p.length), diameter: Math.max(1e-3, p.diameter), roughness: p.roughness, minorK: p.minorK || 0 },
    })
  }

  // ---- what can reach a pressure source ----
  const byKind = new Map(model.nodes.map((n) => [n.id, n.data.kind]))
  const adj = nodes.map(() => [] as number[])
  // a differential gauge never bridges its two taps; a shut valve still belongs to the network it sits in
  for (const l of links)
    if (byKind.get(l.id) !== 'dpgauge') {
      adj[l.a].push(l.b)
      adj[l.b].push(l.a)
    }
  const reached = new Set<number>()
  const stack = nodes.map((n, i) => (n.fixed ? i : -1)).filter((i) => i >= 0)
  while (stack.length) {
    const i = stack.pop()!
    if (reached.has(i)) continue
    reached.add(i)
    adj[i].forEach((j) => !reached.has(j) && stack.push(j))
  }
  const excluded: string[] = []
  for (const nd of model.nodes) {
    if (isControl(nd.data.kind)) continue
    const i = index.get(nd.id) ?? index.get(`${nd.id}:in`)!
    // receivers and return headers belong to the condensate side, which the steam layer solves
    const mine = model.edges.filter((e) => e.type !== 'signal' && (e.source === nd.id || e.target === nd.id))
    if (fluid.steam && (nd.data.kind === 'tank' || (mine.length > 0 && mine.every((e) => e.data?.props.conduit === 'condensate')))) continue
    if (!reached.has(i) || adj[i].length === 0) excluded.push(nd.id)
  }
  const live = links.filter((l) => reached.has(l.a) && reached.has(l.b))
  for (const e of model.edges) if (e.type !== 'signal' && e.data?.props.conduit !== 'condensate' && !live.some((l) => l.id === e.id)) excluded.push(e.id)
  if (!live.length || !nodes.some((n) => n.fixed)) {
    return { ...EMPTY_RESULTS, gas: true, excluded, warnings, error: model.nodes.length ? 'Connect a pressure source (reservoir) or a receiver to something with a pipe' : undefined }
  }

  // ---- flow laws ----
  const pFixed = nodes.filter((n) => n.fixed).map((n) => n.p)
  const start = pFixed.reduce((s, v) => s + v, 0) / pFixed.length
  // A flat starting guess is hopeless across a regulator (400 kPa upstream, 2 kPa downstream). Walk outwards from
  // the sources instead: pressure carries across a pipe, drops to the setpoint through a regulator, and is
  // multiplied by the design ratio through a compressor.
  for (const n of nodes) if (!n.fixed) n.p = NaN
  const queue = nodes.map((n, i) => (n.fixed ? i : -1)).filter((i) => i >= 0)
  while (queue.length) {
    const i = queue.shift()!
    for (const l of links) {
      if (l.kind === 'closed' || (l.a !== i && l.b !== i)) continue
      const forward = l.a === i
      const j = forward ? l.b : l.a
      if (isFinite(nodes[j].p)) continue
      const ratio = l.kind === 'compressor' ? 1 + (Math.max(1.01, l.props.pressureRatio ?? 2.5) - 1) * l.speed * l.speed : 1
      let guess = forward ? nodes[i].p * ratio * 0.999 : (nodes[i].p / ratio) * 1.001
      // start a regulator half-open, inside its droop band — at the setpoint itself its gradient is zero
      if (l.kind === 'prv' && forward) guess = Math.min(guess, P_ATM + l.props.pressureSetting - 0.5 * Math.max(50, 0.02 * l.props.pressureSetting))
      nodes[j].p = Math.max(P_ATM, guess)
      queue.push(j)
    }
  }
  for (const n of nodes) if (!isFinite(n.p)) n.p = start

  // steam is not an ideal gas at one temperature: its p/ρ comes from the steam table at the link's mean pressure
  const zrtAt = (pa: number, pb: number) => (fluid.steam ? zrt(fluid, (pa + pb) / 2) : ZRT)
  const sqrtLaw = (dPi: number, res: number, k: number) => (res > 0 ? dPi / Math.sqrt(res * k * (Math.abs(dPi) + EPS)) : dPi * 1e-3) // tiny res: near-rigid coupling
  const flow = (l: GLink, pa: number, pb: number): number => {
    if (l.kind === 'closed') return 0
    const dPi = pa * pa - pb * pb
    let m: number
    if (l.kind === 'compressor') m = rs * compressorFlow(pb / Math.max(1, pa), l.props, l.speed)
    else {
      m = sqrtLaw(dPi, Math.max(l.res, 1e-3), zrtAt(pa, pb))
      // regulators throttle an otherwise open valve, with a little droop — just like the real spring-loaded kind
      const droop = Math.max(50, 0.02 * l.props.pressureSetting) // 2 % of the set pressure, never less than 50 Pa
      if (l.kind === 'prv') m *= Math.min(1, Math.max(0, (P_ATM + l.props.pressureSetting - pb) / droop))
      else if (l.kind === 'psv') m *= Math.min(1, Math.max(0, (pa - (P_ATM + l.props.pressureSetting)) / droop))
      else if (l.kind === 'fcv') m = Math.min(m, l.props.flowSetting * rs)
    }
    return l.noReverse || l.kind === 'prv' || l.kind === 'psv' || l.kind === 'fcv' ? Math.max(0, m) : m
  }
  const vent = (n: GNode, p: number) => (n.duty ? n.duty / hfg(p) : 0) + orificeFlow(n.cdA, p, P_ATM, fluid).mdot + (n.relief && p > n.relief.set ? orificeFlow(n.relief.cdA, p, P_ATM, fluid).mdot : 0)

  const free = nodes.map((n, i) => (!n.fixed && reached.has(i) ? i : -1)).filter((i) => i >= 0)
  const residual = (P: Float64Array): Float64Array => {
    const r = new Float64Array(nodes.length)
    for (const l of live) {
      const m = flow(l, P[l.a], P[l.b])
      r[l.a] -= m
      r[l.b] += m
    }
    for (const i of free) r[i] -= nodes[i].demand + nodes[i].cond + vent(nodes[i], P[i])
    return r
  }
  const norm = (r: Float64Array) => free.reduce((s, i) => Math.max(s, Math.abs(r[i])), 0)

  const P = Float64Array.from(nodes.map((n) => (isFinite(n.p) ? n.p : start)))
  let converged = free.length === 0
  for (let outer = 0; outer < 8; outer++) {
    // friction factors from the flows of the previous pass
    for (const l of live)
      if (l.pipe) {
        const { length, diameter, roughness, minorK } = l.pipe
        const re = (4 * Math.abs(l.mdot)) / (Math.PI * diameter * fluid.dynamicViscosity)
        const f = frictionFactor(Math.max(re, 3000), roughness / diameter)
        l.res = ((f * length) / diameter + minorK) / area(diameter) ** 2
      }
    if (fluid.steam) {
      // steam condensing on the pipe walls leaves the flow: book it at the pipe's free end(s)
      for (const n of nodes) n.cond = 0
      for (const l of live)
        if (l.pipe) {
          const c = pipeCondensate(l.props, (P[l.a] + P[l.b]) / 2)
          const ends = [l.a, l.b].filter((i) => !nodes[i].fixed)
          ends.forEach((i) => (nodes[i].cond += c / ends.length))
        }
    }
    for (let it = 0; it < 60 && free.length; it++) {
      const r0 = residual(P)
      const n0 = norm(r0)
      if (n0 < 1e-9) {
        converged = true
        break
      }
      // numerical Jacobian on the free pressures
      const N = free.length
      const J = Array.from({ length: N }, () => new Float64Array(N))
      for (let c = 0; c < N; c++) {
        const i = free[c]
        const h = Math.max(1, P[i] * 1e-6)
        // central differences: the regulator and check-valve laws have corners a one-sided step can sit on
        P[i] += h
        const r1 = residual(P)
        P[i] -= 2 * h
        const r2 = residual(P)
        P[i] += h
        for (let k = 0; k < N; k++) J[k][c] = (r1[free[k]] - r2[free[k]]) / (2 * h)
      }
      const dx = solveLinear(
        J,
        free.map((i) => -r0[i]),
      )
      if (!dx) break
      // damped step: never let a pressure go below a tenth of an atmosphere, and insist the residual shrinks
      let step = 1
      for (let tries = 0; tries < 12; tries++) {
        const trial = Float64Array.from(P)
        // no pressure may move by more than half its value in one step, nor fall below a tenth of an atmosphere
        free.forEach((i, c) => (trial[i] = Math.max(0.1 * P_ATM, P[i] + Math.max(-0.5 * P[i], Math.min(0.5 * P[i], step * dx[c])))))
        if (norm(residual(trial)) < n0 || tries === 11) {
          P.set(trial)
          break
        }
        step /= 2
      }
    }
    let moved = 0
    for (const l of live) {
      const m = flow(l, P[l.a], P[l.b])
      moved = Math.max(moved, Math.abs(m - l.mdot) / Math.max(1e-9, Math.abs(m)))
      l.mdot = m
    }
    if (moved < 1e-4 && outer > 0) break
  }
  if (!converged && norm(residual(P)) > 1e-6) warnings.push({ level: 'warn', text: 'The gas solver did not fully converge — treat these numbers with care' })

  // ---- results, in the app's vocabulary ----
  const res: Results = { ...EMPTY_RESULTS, ok: true, gas: true, warnings, nodes: {}, links: {}, devices: {}, excluded }
  const gauge = (i: number) => P[i] - P_ATM
  const asHead = (pa: number) => pa / (1000 * G) // m of water gauge — a gas has no useful head of its own
  const net = new Float64Array(nodes.length)
  for (const l of live) {
    net[l.a] -= l.mdot
    net[l.b] += l.mdot
  }
  const byId = new Map(model.nodes.map((n) => [n.id, n] as [string, ModelNode]))
  const choked: string[] = []
  for (const [key, i] of index) {
    if (key.includes(':') || !reached.has(i) || excluded.includes(key)) continue
    const n = nodes[i]
    // a source's "outflow" is negative (it supplies); a receiver's is positive while it fills
    const outflow = n.fixed ? net[i] / rs : (n.demand + vent(n, P[i])) / rs
    res.nodes[key] = { head: asHead(gauge(i)), pressure: gauge(i), elevation: 0, outflow }
    const v = orificeFlow(n.cdA, P[i], P_ATM, fluid)
    if (v.choked && v.mdot > 0) choked.push(key)
    if (n.relief && P[i] > n.relief.set) warnings.push({ id: key, level: 'warn', text: `${byId.get(key)!.data.label}: lifting — venting gas to hold its set pressure` })
  }
  if (choked.length) {
    const names = choked.map((k) => byId.get(k)!.data.label)
    warnings.push({
      id: choked[0],
      level: 'info',
      text: `${names.length > 3 ? `${names.length} outlets are` : `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'}`} choked — the jet is sonic, so only the pressure behind it sets the flow`,
    })
  }
  let vMax = 1
  for (const l of live) {
    const pa = P[l.a]
    const pb = P[l.b]
    const q = l.mdot / rs
    if (l.pipe) {
      const A = area(l.pipe.diameter)
      const v = Math.abs(l.mdot) / (((pa + pb) / 2 / zrtAt(pa, pb)) * A)
      const re = (4 * Math.abs(l.mdot)) / (Math.PI * l.pipe.diameter * fluid.dynamicViscosity)
      const sign = l.mdot >= 0 ? 1 : -1
      res.links[l.id] = {
        flow: q,
        velocity: v,
        headloss: asHead((pa - pb) * sign),
        dp: (pa - pb) * sign,
        re,
        f: frictionFactor(Math.max(re, 1), l.pipe.roughness / l.pipe.diameter),
        regime: regimeOf(re),
        pStart: pa - P_ATM,
        pEnd: pb - P_ATM,
      }
      vMax = Math.max(vMax, v)
      const mach = v / Math.sqrt(fluid.gas!.gamma * zrtAt(pa, pb))
      if (mach > 0.3)
        warnings.push({
          id: l.id,
          level: 'warn',
          text: `${model.edges.find((e) => e.id === l.id)?.data?.label ?? 'Pipe'}: Mach ${mach.toFixed(2)} — too fast for the isothermal pipe model to be trusted`,
        })
      else if (fluid.steam ? v > 40 : v > 25)
        warnings.push({
          id: l.id,
          level: fluid.steam ? 'warn' : 'info',
          text: `${model.edges.find((e) => e.id === l.id)?.data?.label ?? 'Pipe'}: ${v.toFixed(0)} m/s — ${fluid.steam ? 'steam mains are sized for 25–35 m/s; this fast it erodes fittings and roars' : 'above the usual 20 m/s limit for gas lines'}`,
        })
    } else {
      const nd = byId.get(l.id)
      if (!nd) continue // an internal port of a tee, three-way valve or jet pump
      const dev: Results['devices'][string] = {
        flow: q,
        headIn: asHead(pa - P_ATM),
        headOut: asHead(pb - P_ATM),
        pIn: pa - P_ATM,
        pOut: pb - P_ATM,
        dH: asHead(pb - pa),
        status: l.kind === 'closed' ? 'closed' : 'open',
      }
      if (nd.data.kind === 'pump' && l.kind === 'compressor') {
        const g = fluid.gas!.gamma
        const ratio = pb / pa
        dev.efficiency = nd.data.props.bepEfficiency
        dev.hydraulicPower = l.mdot * (g / (g - 1)) * ZRT * (Math.pow(Math.max(1, ratio), (g - 1) / g) - 1)
        dev.shaftPower = dev.hydraulicPower / Math.max(0.05, dev.efficiency ?? 0.7)
        dev.ratio = ratio
        if (q < 1e-9) warnings.push({ id: l.id, level: 'warn', text: `${nd.data.label}: no flow — the system pressure is above what it can reach at this speed` })
      } else if (nd.data.kind !== 'dpgauge') {
        dev.velocity = Math.abs(l.mdot) / (((pa + pb) / 2 / zrtAt(pa, pb)) * area(nd.data.props.diameter ?? 0.04))
        if (l.kind === 'prv' || l.kind === 'psv' || l.kind === 'fcv') dev.status = Math.abs(q) < 1e-9 ? 'closed' : 'active'
        if (nd.data.kind === 'valve' && (nd.data.props.valveType === 'throttle' || nd.data.props.valveType === 'float')) {
          dev.position = valvePosition(model, nd.id)
          dev.K = valveK(dev.position, nd.data.props.kOpen, nd.data.props.trim)
        }
      }
      res.devices[l.id] = dev
    }
  }
  const ps = [...Object.values(res.nodes).map((x) => x.pressure), ...Object.values(res.devices).flatMap((x) => [x.pIn, x.pOut])]
  res.pMin = Math.min(0, ...ps)
  res.pMax = Math.max(1000, ...ps)
  res.vMax = vMax
  if (excluded.length) warnings.push({ level: 'info', text: 'Greyed-out parts are not connected to a pressure source' })
  res.solveMs = performance.now() - t0
  return res
}

/** Gaussian elimination with partial pivoting; the systems here are a few dozen unknowns at most. */
function solveLinear(A: Float64Array[], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (Math.abs(M[piv][c]) < 1e-300) return null
    ;[M[c], M[piv]] = [M[piv], M[c]]
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c]
      if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]
    x[r] = s / M[r][r]
  }
  return x
}
