// Main-thread face of the solver. Work is posted to a Web Worker; each kind of request is
// "latest wins" — while one is in flight, newer requests replace each other instead of queueing,
// so dragging a slider can never build up a backlog.
import type { Model, Results } from '../model/types'
import { systemCurve as systemCurveSync, type XY } from './analysis'
import type { HydraulicEngine } from './epanet'
import { runTransient, type TransientEvent, type TransientResult } from './transient'

export type Request =
  { seq: number; type: 'transient'; model: Model; event: TransientEvent } | { seq: number; type: 'solve'; model: Model } | { seq: number; type: 'systemCurve'; model: Model; pumpId: string }
export type Response = { seq: number; type: 'transient'; result: TransientResult } | { seq: number; type: 'solve'; results: Results } | { seq: number; type: 'systemCurve'; points: XY[] }

type Payload = { type: 'transient'; model: Model; event: TransientEvent } | { type: 'solve'; model: Model } | { type: 'systemCurve'; model: Model; pumpId: string }
type Value = Results | XY[] | TransientResult | null
interface Job {
  payload: Payload
  resolve: (v: Value) => void
}

/** Strip React Flow bookkeeping so only the hydraulic model crosses the thread boundary. */
const slim = (m: Model): Model => ({
  fluid: m.fluid,
  levels: m.levels,
  controls: m.controls,
  nodes: m.nodes.map((n) => ({ id: n.id, data: { kind: n.data.kind, label: n.data.label, props: n.data.props } })),
  edges: m.edges.map((e) => ({
    id: e.id,
    type: e.type,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    data: e.data && { label: e.data.label, props: e.data.props },
  })),
})

class SolverClient {
  name = 'EPANET 2.2 · WebAssembly'
  private local: HydraulicEngine | null = null
  threaded = false
  private worker: Worker | null = null
  private seq = 0
  private inflight = new Map<string, { seq: number; job: Job }>()
  private waiting = new Map<string, Job>()

  async ready() {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<Response>) => this.settle(e.data)
      this.worker.onerror = () => this.fallBack()
      this.threaded = true
    } catch {
      await this.fallBack()
    }
  }

  solve(model: Model) {
    return this.request({ type: 'solve', model: slim(model) }) as Promise<Results | null>
  }
  /** Water-hammer run: steady solve + Method of Characteristics, both off the main thread. */
  transient(model: Model, event: TransientEvent) {
    return this.request({ type: 'transient', model: slim(model), event }) as Promise<TransientResult | null>
  }
  systemCurve(model: Model, pumpId: string) {
    return this.request({ type: 'systemCurve', model: slim(model), pumpId }) as Promise<XY[] | null>
  }

  private request(payload: Payload) {
    return new Promise<Value>((resolve) => {
      const job = { payload, resolve }
      if (this.inflight.has(payload.type)) {
        this.waiting.get(payload.type)?.resolve(null) // superseded
        this.waiting.set(payload.type, job)
      } else this.dispatch(job)
    })
  }

  private dispatch(job: Job) {
    const seq = ++this.seq
    this.inflight.set(job.payload.type, { seq, job })
    if (this.worker) this.worker.postMessage({ seq, ...job.payload })
    else
      setTimeout(() => {
        const p = job.payload
        const local = this.local!
        if (p.type === 'transient') this.settle({ seq, type: 'transient', result: runTransient(p.model, local.solve(p.model), p.event) })
        else this.settle(p.type === 'solve' ? { seq, type: 'solve', results: local.solve(p.model) } : { seq, type: 'systemCurve', points: systemCurveSync(local, p.model, p.pumpId) })
      }, 0)
  }

  private settle(res: Response) {
    const cur = this.inflight.get(res.type)
    if (!cur || cur.seq !== res.seq) return
    this.inflight.delete(res.type)
    cur.job.resolve(res.type === 'solve' ? res.results : res.type === 'transient' ? res.result : res.points)
    const next = this.waiting.get(res.type)
    if (next) {
      this.waiting.delete(res.type)
      this.dispatch(next)
    }
  }

  /** No worker support (or it crashed): run the same engine on the main thread. */
  private async fallBack() {
    this.worker?.terminate()
    this.worker = null
    this.threaded = false
    this.local = (await import('./epanet')).engine // only pulled into the main bundle's graph when needed
    await this.local.ready()
    for (const { job } of this.inflight.values()) {
      this.inflight.delete(job.payload.type)
      this.dispatch(job)
    }
  }
}

export const solver = new SolverClient()
