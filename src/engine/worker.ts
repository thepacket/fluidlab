/// <reference lib="webworker" />
// The solver's home: EPANET-WASM runs here so the bench never blocks while a network converges.
import { systemCurve } from './analysis'
import { engine } from './epanet'
import { runTransient } from './transient'
import type { Request, Response } from './client'

const ready = engine.ready()

self.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data
  await ready
  let res: Response
  if (req.type === 'transient') res = { seq: req.seq, type: 'transient', result: runTransient(req.model, engine.solve(req.model), req.event) }
  else if (req.type === 'solve') res = { seq: req.seq, type: 'solve', results: engine.solve(req.model) }
  else res = { seq: req.seq, type: 'systemCurve', points: systemCurve(engine, req.model, req.pumpId) }
  self.postMessage(res)
}
