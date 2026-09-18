// Event sequences: the command each wired device gets, as a pure function of lab time.
import { sequenceValue, stepControl } from '../src/model/control'
import { defaultProps, type Kind } from '../src/model/types'

let failed = 0
const check = (name: string, got: number, want: number) => {
  const ok = Math.abs(got - want) < 1e-9
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}: ${got} (expected ${want})`)
}
const p = {
  enabled: true,
  repeat: false,
  period: 100,
  steps: [
    { at: 0, target: 'v', value: 0, ramp: 0 },
    { at: 10, target: 'v', value: 1, ramp: 20 },
    { at: 20, target: 'v', value: 0.2, ramp: 10 }, // cuts the opening ramp short, from wherever it had got to
    { at: 5, target: 'p', value: 0, ramp: 0 },
    { at: 60, target: 'all', value: 0, ramp: 0 },
  ],
}
check('before its first step a device is left as configured', sequenceValue(p, 'p', 4), 1)
check('a step switches it', sequenceValue(p, 'p', 5), 0)
check('another device follows its own steps', sequenceValue(p, 'v', 5), 0)
check('half-way up a ramp', sequenceValue(p, 'v', 15), 0.25)
check('a new step starts from where the ramp had got to', sequenceValue(p, 'v', 25), 0.5 + (0.2 - 0.5) * 0.5)
check('and ends on its own value', sequenceValue(p, 'v', 40), 0.2)
check('“everything wired” reaches every device', sequenceValue(p, 'v', 61), 0)
check('repeat wraps the clock', sequenceValue({ ...p, repeat: true }, 'v', 115), 0.25)

// through the control scan: one block, two wires, two different commands
const node = (id: string, kind: Kind, props = {}) => ({ id, data: { kind, label: id, props: { ...defaultProps(kind), ...props } } })
const nodes = [node('seq', 'sequence', p), node('v', 'valve'), node('p', 'pump')]
const edges = [
  { id: 's1', type: 'signal', source: 'seq', sourceHandle: 'sig', target: 'v', targetHandle: 'ctl' },
  { id: 's2', type: 'signal', source: 'seq', sourceHandle: 'sig', target: 'p', targetHandle: 'ctl' },
]
const c = stepControl({ nodes, edges, t: 15, dt: 0 })
check('scan: valve command', c.commands.v, 0.25)
check('scan: pump command', c.commands.p, 0)
const off = stepControl({ nodes: [node('seq', 'sequence', { ...p, enabled: false }), nodes[1], nodes[2]], edges, t: 15, dt: 0 })
check('a disabled sequence lets everything run (no command at all)', off.commands.p ?? 1, 1)

if (failed) {
  console.error(`${failed} sequence check(s) failed`)
  process.exit(1)
}
console.log('sequence checks passed')
