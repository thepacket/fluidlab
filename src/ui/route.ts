// Pipe routing on the bench: the right-angled path React Flow proposes, rebuilt so that a pipe can hop over the
// pipes it crosses, and so the label can sit beside the longest straight run instead of on top of the flow.
import { create } from 'zustand'

export interface Pt {
  x: number
  y: number
}

/** The corner points of a smooth-step path, recovered from its `M … L … Q …` string. */
export function vertices(path: string): Pt[] {
  const cmds = [...path.matchAll(/([MLQ])\s*([^MLQ]*)/g)].map((m) => ({ c: m[1], n: (m[2].match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number) }))
  const pts: Pt[] = []
  cmds.forEach((k, i) => {
    if (k.c === 'Q') pts.push({ x: k.n[0], y: k.n[1] })
    else if (k.c === 'M' || cmds[i + 1]?.c !== 'Q') pts.push({ x: k.n[0], y: k.n[1] }) // an L that leads into a Q is only where the bend starts
  })
  // drop repeats and points in the middle of a straight run
  return pts.filter((p, i) => {
    const a = pts[i - 1]
    const b = pts[i + 1]
    if (a && Math.abs(a.x - p.x) < 0.01 && Math.abs(a.y - p.y) < 0.01) return false
    return !(a && b && ((Math.abs(a.x - p.x) < 0.01 && Math.abs(p.x - b.x) < 0.01) || (Math.abs(a.y - p.y) < 0.01 && Math.abs(p.y - b.y) < 0.01)))
  })
}

/** Every pipe's corner points, so each can find where the others cross it. Bumping `version` redraws the hops. */
const routes = new Map<string, Pt[]>()
export const useRoutes = create<{ version: number }>(() => ({ version: 0 }))
let pending = false
const bump = () => {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    useRoutes.setState({ version: useRoutes.getState().version + 1 })
  })
}
export function publishRoute(id: string, pts: Pt[] | null) {
  const was = routes.get(id)
  const same = pts && was && was.length === pts.length && was.every((p, i) => Math.abs(p.x - pts[i].x) < 0.5 && Math.abs(p.y - pts[i].y) < 0.5)
  if (same || (!pts && !was)) return
  if (pts) routes.set(id, pts)
  else routes.delete(id)
  bump()
}

const HOP = 11
const CORNER = 18

/** Where this pipe's horizontal runs cross another pipe's vertical runs — the horizontal pipe is the one that hops. */
function crossings(id: string, a: Pt, b: Pt): number[] {
  if (Math.abs(a.y - b.y) > 0.01) return []
  const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x]
  const xs: number[] = []
  for (const [other, pts] of routes) {
    if (other === id) continue
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]
      const q = pts[i]
      if (Math.abs(p.x - q.x) > 0.01) continue
      const [y0, y1] = p.y < q.y ? [p.y, q.y] : [q.y, p.y]
      // well inside both runs: never on a corner, never at a port
      if (p.x > x0 + CORNER + HOP && p.x < x1 - CORNER - HOP && a.y > y0 + HOP && a.y < y1 - HOP) xs.push(p.x)
    }
  }
  xs.sort((m, n) => m - n)
  return xs.filter((x, i) => i === 0 || x - xs[i - 1] > 2 * HOP + 2)
}

/** The drawn path: rounded corners, and a small arch wherever the pipe passes over another. */
export function buildPath(id: string, pts: Pt[]): string {
  if (pts.length < 2) return ''
  let d = `M${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const c = pts[i + 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const r = c ? Math.min(CORNER, len / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2) : 0
    const ux = (b.x - a.x) / (len || 1)
    const uy = (b.y - a.y) / (len || 1)
    const hops = crossings(id, a, b)
    if (ux < 0) hops.reverse()
    for (const x of hops) d += `L${x - HOP * ux} ${a.y}A${HOP} ${HOP} 0 0 ${ux > 0 ? 1 : 0} ${x + HOP * ux} ${a.y}`
    d += `L${b.x - ux * r} ${b.y - uy * r}`
    if (c) {
      const l2 = Math.hypot(c.x - b.x, c.y - b.y) || 1
      d += `Q${b.x} ${b.y} ${b.x + ((c.x - b.x) / l2) * r} ${b.y + ((c.y - b.y) / l2) * r}`
    }
  }
  return d
}

/** Where the label goes: beside the middle of the longest straight run, clear of the pipe itself. */
export function labelSpot(id: string, pts: Pt[], clearance: number): Pt & { side: 'above' | 'right' } {
  let best = 1
  let bestLen = -1
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    // prefer a horizontal run unless a vertical one is clearly longer: text sits naturally above a level pipe
    const score = Math.abs(pts[i].y - pts[i - 1].y) < 0.01 ? len * 1.4 : len
    if (score > bestLen) [best, bestLen] = [i, score]
  }
  const a = pts[best - 1]
  const b = pts[best]
  const level = Math.abs(a.y - b.y) < 0.01
  if (level) {
    // keep clear of the pipes this run crosses: take the middle of the longest stretch between them
    const stops = [Math.min(a.x, b.x), ...crossings(id, a, b), Math.max(a.x, b.x)]
    let x = (a.x + b.x) / 2
    let widest = -1
    for (let i = 1; i < stops.length; i++) if (stops[i] - stops[i - 1] > widest) [widest, x] = [stops[i] - stops[i - 1], (stops[i] + stops[i - 1]) / 2]
    return { x, y: a.y - clearance, side: 'above' }
  }
  return { x: a.x + clearance, y: (a.y + b.y) / 2, side: 'right' }
}

/** The middle run of the path and the axis it may be dragged along — null when the route has no free run. */
export function middleRun(pts: Pt[]): { at: Pt; axis: 'x' | 'y' } | null {
  if (pts.length < 4) return null
  const i = Math.floor(pts.length / 2)
  const a = pts[i - 1]
  const b = pts[i]
  return { at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, axis: Math.abs(a.x - b.x) < 0.01 ? 'x' : 'y' }
}

export const routeOf = (id: string) => routes.get(id)
