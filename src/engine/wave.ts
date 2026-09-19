// Unsteady open-channel flow: the Saint-Venant equations marched through lab time.
//
// The steady engine (channel.ts) says where the water surface settles; this one moves it there. Each reach is a row
// of finite-volume cells carrying area A and discharge Q:
//     ∂A/∂t + ∂Q/∂x = 0        ∂Q/∂t + ∂(Q²/A + g·I₁)/∂x = g·A·(S₀ − S_f)
// Fluxes are HLL (so bores and hydraulic jumps capture themselves), the bed slope enters through hydrostatic
// reconstruction (so still water stays still), and Manning friction is taken implicitly (so shallow cells stay
// stable). Junctions are small ponds that exchange water with the reach ends around them; weirs and gates pass the
// flow their own law allows between the cells either side; inflows, outfalls and lakes are boundary states.
// It starts from the steady solution, so nothing moves until something changes: a flood pulse, a gate, a lake level.
import { G } from '../model/physics'
import {
  GATE_CC,
  area,
  bisect,
  criticalDepth,
  firstMoment,
  froude,
  hydraulicRadius,
  isChannel,
  isFull,
  lining,
  normalDepth,
  slopeClass,
  slotWidth,
  specificEnergy,
  superDepth,
  topWidth,
  weirExponent,
  weirFlow,
  zoneName,
} from '../model/openchannel'
import type { LinkResult, Model, NodeResult, Props, Results } from '../model/types'
import type { ChannelResults, ReachResult } from './channel'
import { command } from './inp'

interface ReachState {
  a: number[]
  q: number[]
}
export interface WaveState {
  reaches: Record<string, ReachState>
  /** water depth in the pond at each junction */
  ponds: Record<string, number>
  /** discharge through each weir / gate, for the readouts */
  through: Record<string, number>
  /** discharge of each reach as its cell faces actually pass it (cell-centre Q carries a small bias where friction is strong) */
  flux: Record<string, number>
  /** what each tank or reservoir on the channels is gaining right now, m³/s */
  lakes: Record<string, number>
}

const DRY = 1e-4
export const cellsFor = (length: number) => Math.min(60, Math.max(12, Math.round(length / 2)))

function depthOf(p: Props, a: number): number {
  if (a <= 0) return 0
  if (p.shape === 'circ') {
    const full = area(p, p.diameter)
    return a >= full ? p.diameter + (a - full) / slotWidth(p) : bisect((y) => area(p, y) - a, 0, p.diameter, 24)
  }
  const b = p.shape === 'tri' ? 0 : p.width
  const z = p.shape === 'rect' ? 0 : p.sideSlope
  return z > 0 ? (-b + Math.sqrt(b * b + 4 * z * a)) / (2 * z) : a / b
}

interface Side {
  h: number
  u: number
  z: number
}
/** HLL flux across an interface with hydrostatic reconstruction. Returns mass flux and the momentum flux each side feels. */
function interfaceFlux(p: Props, L: Side, R: Side): [number, number, number] {
  const zs = Math.max(L.z, R.z)
  const hl = Math.max(0, L.h + L.z - zs)
  const hr = Math.max(0, R.h + R.z - zs)
  if (hl < DRY && hr < DRY) return [0, G * firstMoment(p, L.h), G * firstMoment(p, R.h)]
  const [al, ar] = [area(p, hl), area(p, hr)]
  const cl = hl > DRY ? Math.sqrt((G * al) / topWidth(p, hl)) : 0
  const cr = hr > DRY ? Math.sqrt((G * ar) / topWidth(p, hr)) : 0
  const ul = hl > DRY ? L.u : 0
  const ur = hr > DRY ? R.u : 0
  const sl = hl > DRY ? Math.min(ul - cl, ur - cr) : ur - 2 * cr
  const sr = hr > DRY ? Math.max(ul + cl, ur + cr) : ul + 2 * cl
  const fl = [al * ul, al * ul * ul + G * firstMoment(p, hl)]
  const fr = [ar * ur, ar * ur * ur + G * firstMoment(p, hr)]
  let f: number[]
  if (sl >= 0) f = fl
  else if (sr <= 0) f = fr
  else f = [0, 1].map((k) => (sr * fl[k] - sl * fr[k] + sl * sr * ((k ? ar * ur : ar) - (k ? al * ul : al))) / (sr - sl))
  return [f[0], f[1] + G * (firstMoment(p, L.h) - firstMoment(p, hl)), f[1] + G * (firstMoment(p, R.h) - firstMoment(p, hr))]
}

interface Geo {
  id: string
  p: Props
  up: string
  dn: string
  n: number
  dx: number
  zu: number
  s0: number
  length: number
}

function geometry(model: Model, results: Results): Geo[] {
  const out: Geo[] = []
  for (const e of model.edges) {
    const r = results.channel?.reaches[e.id]
    if (!r || !isChannel(e)) continue
    const p = { ...e.data!.props }
    if (p.lining !== 'custom') p.manningN = lining(p.lining).n
    const length = r.x[r.x.length - 1]
    const n = cellsFor(length)
    out.push({ id: e.id, p, up: r.from, dn: r.to, n, dx: length / n, zu: r.bed[0], s0: r.slope, length })
  }
  return out
}

/** Flow a weir or gate passes with `hu` of water upstream and `hd` downstream (both above the structure's bed). Signed. */
function structureFlow(kind: string, p: Props, opening: number, hu: number, hd: number): number {
  if (hd > hu) return -structureFlow(kind, p, opening, hd, hu)
  if (kind === 'weir') {
    const crest = p.variant === 'parshall' ? 0 : (p.crestHeight ?? 0)
    const h = hu - crest
    if (h <= 0) return 0
    const tail = hd - crest
    return weirFlow(p, h) * (tail > 0 ? Math.max(0, 1 - (tail / h) ** weirExponent(p)) ** 0.385 : 1)
  }
  const b = Math.max(0.01, p.width)
  const a = Math.max(1e-4, opening)
  if (hu <= a) return 1.705 * b * hu ** 1.5 * (hd > 0 ? Math.max(0, 1 - (hd / hu) ** 1.5) ** 0.385 : 1) // lip clear of the water
  const free = (GATE_CC / Math.sqrt(1 + (GATE_CC * a) / hu)) * b * a * Math.sqrt(2 * G * hu)
  return hd > GATE_CC * a ? Math.min(free, GATE_CC * b * a * Math.sqrt(2 * G * Math.max(0, hu - hd))) : free
}

/** Start from the steady water surface. */
export function initWave(model: Model, results: Results): WaveState {
  const st: WaveState = { reaches: {}, ponds: {}, through: {}, flux: {}, lakes: {} }
  for (const g of geometry(model, results)) {
    const r = results.channel!.reaches[g.id]
    st.flux[g.id] = r.flow
    const a: number[] = []
    for (let i = 0; i < g.n; i++) {
      const s = ((i + 0.5) / g.n) * (r.depth.length - 1)
      const k = Math.min(r.depth.length - 2, Math.floor(s))
      a.push(area(g.p, r.depth[k] + (s - k) * (r.depth[k + 1] - r.depth[k])))
    }
    st.reaches[g.id] = { a, q: new Array(g.n).fill(r.flow) }
  }
  for (const [id, n] of Object.entries(results.nodes)) if (n.extra && 'depth' in n.extra) st.ponds[id] = n.extra.depth
  return st
}

/** Advance by dt seconds of lab time. `budget` caps the sub-steps, so a very fine rig runs slow rather than freezing the page. */
export function stepWave(model: Model, results: Results, prev: WaveState | null, dt: number, feeds: Record<string, number> = {}, budget = 240): WaveState | null {
  if (!results.ok || !results.channel) return null
  const geo = geometry(model, results)
  if (!geo.length) return null
  const fresh = initWave(model, results)
  const st: WaveState = { reaches: {}, ponds: {}, through: {}, flux: {}, lakes: {} }
  for (const g of geo) {
    const had = prev?.reaches[g.id]
    st.reaches[g.id] = had && had.a.length === g.n ? { a: [...had.a], q: [...had.q] } : fresh.reaches[g.id]
  }
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const nodeIds = [...new Set(geo.flatMap((g) => [g.up, g.dn]))]
  for (const id of nodeIds) st.ponds[id] = prev?.ponds[id] ?? fresh.ponds[id] ?? 0
  const zOf = (id: string) => {
    const g = geo.find((x) => x.up === id)
    if (g) return g.zu
    const d = geo.find((x) => x.dn === id)!
    return d.zu - d.s0 * d.length
  }
  const kind = (id: string) => byId.get(id)!.data.kind
  const isLake = (id: string) => kind(id) === 'tank' || kind(id) === 'reservoir'
  const lakeLevel = (id: string) => {
    const p = byId.get(id)!.data.props
    return kind(id) === 'tank' ? p.elevation + (model.levels?.[id] ?? p.initLevel) : p.head
  }
  const pondArea = new Map<string, number>()
  for (const id of nodeIds) {
    let s = 0
    for (const g of geo) if (g.up === id || g.dn === id) s += Math.max(0.3, topWidth(g.p, Math.max(0.05, st.ponds[id]))) * g.dx
    pondArea.set(id, Math.max(1, s))
  }
  // toe velocities below structures are worked out once per call: they change slowly and cost a root-find
  const toe = new Map<string, number>()

  let t = 0
  for (let step = 0; step < budget && t < dt - 1e-9; step++) {
    // ---- CFL ----
    let h = dt - t
    for (const g of geo) {
      const s = st.reaches[g.id]
      for (let i = 0; i < g.n; i++) {
        const y = depthOf(g.p, s.a[i])
        if (y < DRY) continue
        const c = Math.sqrt((G * s.a[i]) / topWidth(g.p, y))
        h = Math.min(h, (0.45 * g.dx) / (Math.abs(s.q[i] / s.a[i]) + c))
      }
    }
    h = Math.max(h, 1e-3)

    const pondIn = new Map<string, number>(nodeIds.map((id) => [id, 0]))
    const ends = new Map<string, { up?: [number, number]; dn?: [number, number] }>() // boundary fluxes [mass, momentum] per reach
    const cell = (g: Geo, i: number): Side => {
      const s = st.reaches[g.id]
      const y = depthOf(g.p, s.a[i])
      return { h: y, u: y > DRY ? s.q[i] / s.a[i] : 0, z: g.zu - g.s0 * (i + 0.5) * g.dx }
    }
    for (const g of geo) ends.set(g.id, {})

    // ---- nodes ----
    for (const id of nodeIds) {
      const nd = byId.get(id)!
      const p = nd.data.props
      const ins = geo.filter((g) => g.dn === id)
      const outs = geo.filter((g) => g.up === id)
      const z = zOf(id)
      if (nd.data.kind === 'weir' || nd.data.kind === 'gate') {
        const [A, B] = [ins[0], outs[0]]
        const cu = A ? cell(A, A.n - 1) : undefined
        const cd = B ? cell(B, 0) : undefined
        const hu = cu ? Math.max(0, cu.h + cu.z - z) : 0
        const hd = cd ? Math.max(0, cd.h + cd.z - z) : 0
        const opening = nd.data.kind === 'gate' ? p.opening * command(model, id) : 0
        let qs = structureFlow(nd.data.kind, p, opening, hu, hd)
        // never take more than the cell holds this step
        if (A && qs > 0) qs = Math.min(qs, (st.reaches[A.id].a[A.n - 1] * A.dx) / h / 2)
        if (B && qs < 0) qs = -Math.min(-qs, (st.reaches[B.id].a[0] * B.dx) / h / 2)
        st.through[id] = qs
        if (A && cu) ends.get(A.id)!.dn = [qs, qs * cu.u + G * firstMoment(A.p, cu.h)]
        if (B && cd) {
          if (!toe.has(id)) toe.set(id, qs > 1e-6 ? superDepth(qs, B.p, Math.max(hu, 0.01) * 0.95) : 0)
          const aJet = Math.max(area(B.p, toe.get(id)!), area(B.p, cd.h) * 0.2, 1e-4)
          ends.get(B.id)!.up = [qs, qs * (qs > 0 ? Math.max(cd.u, qs / aJet) : cd.u) + G * firstMoment(B.p, cd.h)]
        }
        continue
      }
      const fixedQ = nd.data.kind === 'inflow' ? Math.max(0, p.flow * command(model, id)) : nd.data.kind === 'outlet' ? Math.max(0, feeds[id] ?? 0) : null
      if (fixedQ !== null && !ins.length) {
        for (const g of outs) {
          const c = cell(g, 0)
          const q = fixedQ / outs.length
          const aIn = Math.max(st.reaches[g.id].a[0], area(g.p, criticalDepth(q, g.p)), 1e-5)
          ends.get(g.id)!.up = [q, (q * q) / aIn + G * firstMoment(g.p, c.h)]
        }
        continue
      }
      // everything else is a body of water the reach ends talk to: a lake at its own level, an outfall, or a junction pond
      const terminal = !outs.length && nd.data.kind === 'outfall'
      for (const g of [...ins, ...outs]) {
        const atEnd = g.dn === id
        const c = cell(g, atEnd ? g.n - 1 : 0)
        let hGhost: number
        if (isLake(id)) hGhost = Math.max(0, lakeLevel(id) - z)
        else if (terminal) hGhost = p.mode === 'level' ? Math.max(0, p.level - z) : p.mode === 'normal' ? c.h : Math.min(c.h, criticalDepth(Math.abs(st.reaches[g.id].q[g.n - 1]), g.p))
        else hGhost = st.ponds[id]
        const still = isLake(id) && !atEnd // a lake feeding a channel is water at rest
        const ghost: Side = { h: hGhost, u: still ? 0 : c.u, z }
        const [fm, fqL, fqR] = atEnd ? interfaceFlux(g.p, c, ghost) : interfaceFlux(g.p, ghost, c)
        if (atEnd) ends.get(g.id)!.dn = [fm, fqL]
        else ends.get(g.id)!.up = [fm, fqR]
        pondIn.set(id, pondIn.get(id)! + (atEnd ? fm : -fm))
      }
      if (nd.data.kind === 'junction') pondIn.set(id, pondIn.get(id)! - (p.demand ?? 0))
    }

    // ---- reaches ----
    for (const g of geo) {
      const s = st.reaches[g.id]
      const fm = new Array<number>(g.n + 1)
      const fl = new Array<number>(g.n + 1) // momentum flux felt by the cell to the left of each face
      const fr = new Array<number>(g.n + 1)
      const e = ends.get(g.id)!
      ;[fm[0], fr[0]] = e.up ?? [0, G * firstMoment(g.p, depthOf(g.p, s.a[0]))]
      ;[fm[g.n], fl[g.n]] = e.dn ?? [0, G * firstMoment(g.p, depthOf(g.p, s.a[g.n - 1]))]
      let left = cell(g, 0)
      for (let i = 1; i < g.n; i++) {
        const right = cell(g, i)
        ;[fm[i], fl[i], fr[i]] = interfaceFlux(g.p, left, right)
        left = right
      }
      st.flux[g.id] = fm.reduce((sum, f) => sum + f, 0) / fm.length
      for (let i = 0; i < g.n; i++) {
        const a = Math.max(0, s.a[i] - (h / g.dx) * (fm[i + 1] - fm[i]))
        let q = s.q[i] - (h / g.dx) * (fl[i + 1] - fr[i])
        const y = depthOf(g.p, a)
        if (y < DRY) q = 0
        else q /= 1 + (h * G * g.p.manningN ** 2 * Math.abs(q)) / (a * hydraulicRadius(g.p, y) ** (4 / 3)) // implicit Manning
        s.a[i] = a
        s.q[i] = q
      }
    }
    for (const id of nodeIds) {
      if (!isLake(id)) st.ponds[id] = Math.max(0, st.ponds[id] + (pondIn.get(id)! * h) / pondArea.get(id)!)
      else st.lakes[id] = (st.lakes[id] ?? 0) + (pondIn.get(id)! * h) / dt // averaged over this call
    }
    t += h
  }
  return st
}

/** The live water surface, packaged the way the steady engine reports its own — plus the node and link readings that go with it. */
export function waveView(model: Model, results: Results, st: WaveState): { channel: ChannelResults; nodes: Record<string, NodeResult>; links: Record<string, LinkResult> } {
  const rhoG = model.fluid.density * G
  const channel: ChannelResults = { reaches: {} }
  const nodes = { ...results.nodes }
  const links = { ...results.links }
  const geo = geometry(model, results)
  for (const g of geo) {
    const s = st.reaches[g.id]
    const steady = results.channel!.reaches[g.id]
    if (!s) continue
    const depth = s.a.map((a) => depthOf(g.p, a))
    const x = depth.map((_, i) => (i + 0.5) * g.dx)
    const flow = st.flux[g.id] ?? s.q.reduce((sum, q) => sum + q, 0) / g.n
    const qAbs = Math.max(1e-9, Math.abs(flow))
    const fr = depth.map((y, i) => froude(s.q[i], g.p, y))
    const v = depth.map((y, i) => (y > DRY ? Math.abs(s.q[i]) / s.a[i] : 0))
    const yc = criticalDepth(qAbs, g.p)
    const yn = normalDepth(qAbs, g.p, g.s0)
    const cls = slopeClass(g.s0, yn, yc)
    const out: ReachResult = {
      ...steady,
      flow: Math.abs(flow),
      x,
      bed: x.map((d) => g.zu - g.s0 * d),
      depth,
      froude: fr,
      yn,
      yc,
      slopeClass: cls,
      profile: 'dry',
      vMax: Math.max(...v),
      jump: undefined,
    }
    const zones: string[] = []
    for (let i = 0; i < g.n; i++) {
      if (i > 0 && !out.jump && fr[i - 1] > 1.05 && fr[i] < 0.95 && depth[i] > depth[i - 1] * 1.1) {
        const loss = Math.max(0, specificEnergy(s.q[i - 1], g.p, depth[i - 1]) - specificEnergy(s.q[i], g.p, depth[i]))
        out.jump = { x: i * g.dx, y1: depth[i - 1], y2: depth[i], loss, power: rhoG * qAbs * loss }
        zones.push('jump')
      }
      if (depth[i] < DRY) continue
      const zn = isFull(g.p, depth[i]) ? 'full' : zoneName(cls, depth[i], yn, yc)
      if (zones[zones.length - 1] !== zn) zones.push(zn)
    }
    if (zones.length) out.profile = zones.join(' → ')
    channel.reaches[g.id] = out
    const e = model.edges.find((k) => k.id === g.id)!
    const fwd = g.up === e.source
    const old = links[g.id]
    links[g.id] = { ...old, flow: fwd ? flow : -flow, velocity: v.reduce((a, b) => a + b, 0) / g.n, pStart: (fwd ? depth[0] : depth[g.n - 1]) * rhoG, pEnd: (fwd ? depth[g.n - 1] : depth[0]) * rhoG }
  }
  // a tank on the channels fills and drains at the live rate, not the settled one
  for (const [id, net] of Object.entries(st.lakes)) {
    const n = results.nodes[id]
    if (n?.extra?.channelNet !== undefined) nodes[id] = { ...n, outflow: n.outflow - n.extra.channelNet + net }
  }
  for (const [id, n] of Object.entries(results.nodes)) {
    if (!n.extra || !('depthUp' in n.extra)) continue
    const before = geo.find((g) => g.dn === id)
    const after = geo.find((g) => g.up === id)
    const yUp = before ? depthOf(before.p, st.reaches[before.id].a[before.n - 1]) : (st.ponds[id] ?? 0)
    const yDn = after ? depthOf(after.p, st.reaches[after.id].a[0]) : yUp
    const kind = model.nodes.find((k) => k.id === id)!.data.kind
    const structure = kind === 'weir' || kind === 'gate'
    const depth = structure ? yUp : (st.ponds[id] ?? yDn)
    const q = structure ? (st.through[id] ?? 0) : before ? st.reaches[before.id].q[before.n - 1] : after ? st.reaches[after.id].q[0] : 0
    const ref = after ?? before
    const crest = kind === 'weir' ? (model.nodes.find((k) => k.id === id)!.data.props.crestHeight ?? 0) : 0
    nodes[id] = {
      ...n,
      head: n.elevation + depth,
      pressure: depth * rhoG,
      outflow: kind === 'inflow' ? -Math.abs(q) : kind === 'outfall' ? Math.abs(q) : n.outflow,
      extra: { ...n.extra, depth, depthUp: yUp, depthDn: yDn, flow: Math.abs(q), froude: ref ? froude(q, ref.p, depth) : 0, headOver: structure ? Math.max(0, yUp - crest) : 0 },
    }
  }
  return { channel, nodes, links }
}
