import { useMemo, useState } from 'react'
import { EXPERIMENTS } from '../experiments'
import { LOSS_DEVICES } from '../model/catalog'
import { KIND_META, type Kind } from '../model/types'
import { useLab } from '../store'
import { KindIcon } from './icons'

/** One thing you can drop on the bench: a component kind, optionally narrowed to a catalogue entry. */
interface PaletteItem {
  key: string // what travels in the drag payload: "kind" or "kind:variant"
  kind: Kind
  name: string
  blurb: string
}

const item = (kind: Kind): PaletteItem => ({ key: kind, kind, name: KIND_META[kind].name, blurb: KIND_META[kind].blurb })
const catalogue = (group: string) => LOSS_DEVICES.filter((d) => d.group === group).map((d): PaletteItem => ({ key: `fitting:${d.id}`, kind: 'fitting', name: d.name, blurb: d.blurb }))

const GROUPS: { name: string; items: PaletteItem[] }[] = [
  { name: 'Sources & storage', items: (['reservoir', 'tank', 'vessel'] as Kind[]).map(item) },
  { name: 'Pumps & valves', items: (['pump', 'valve', 'relief'] as Kind[]).map(item) },
  { name: 'Nodes', items: (['junction', 'outlet', 'leak'] as Kind[]).map(item) },
  { name: 'Instruments', items: (['gauge', 'dpgauge', 'meter', 'element'] as Kind[]).map(item) },
  { name: 'Control', items: (['manual', 'timer', 'switch', 'pid', 'logic', 'lamp'] as Kind[]).map(item) },
  { name: 'Fittings', items: catalogue('Fittings') },
  { name: 'Equipment', items: catalogue('Equipment') },
]

export function Sidebar() {
  const [tab, setTab] = useState<'build' | 'lab'>('lab')
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<Record<string, boolean>>({ Fittings: true, Equipment: true })
  const experimentId = useLab((s) => s.experimentId)
  const load = useLab((s) => s.loadExperiment)
  const set = useLab((s) => s.set)
  const add = (key: string) => {
    window.dispatchEvent(new CustomEvent('fluidlab:add', { detail: key }))
    set({ sheet: 'none' })
  }

  const q = query.trim().toLowerCase()
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !q || `${i.name} ${i.blurb} ${g.name}`.toLowerCase().includes(q)) })).filter((g) => g.items.length), [q])

  return (
    <aside className="sidebar">
      <div className="tabs wide">
        <button className={tab === 'lab' ? 'on' : ''} onClick={() => setTab('lab')}>
          Experiments
        </button>
        <button className={tab === 'build' ? 'on' : ''} onClick={() => setTab('build')}>
          Components
        </button>
      </div>

      {tab === 'build' ? (
        <>
          <input className="search" type="search" placeholder="Search components…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="scroll">
            {groups.map((g) => {
              const open = !!q || !closed[g.name] // a search opens every group it matches in
              return (
                <div key={g.name}>
                  <button className={`group-head ${open ? 'open' : ''}`} onClick={() => setClosed({ ...closed, [g.name]: open })}>
                    {g.name}
                    <i>{g.items.length}</i>
                  </button>
                  {open &&
                    g.items.map((i) => (
                      <div
                        key={i.key}
                        className="palette-item"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/fluidlab', i.key)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onClick={() => add(i.key)}
                      >
                        <div className="palette-icon">
                          <KindIcon kind={i.kind} />
                        </div>
                        <div>
                          <b>{i.name}</b>
                          <span>{i.blurb}</span>
                        </div>
                      </div>
                    ))}
                </div>
              )
            })}
            {!groups.length && <p className="muted">Nothing in the library matches “{query}”.</p>}
            <div className="howto">
              <p>
                <kbd>click</kbd> or <kbd>drag</kbd> a component onto the bench
              </p>
              <p>
                <kbd>pull</kbd> from a port to lay a pipe
              </p>
              <p>
                <kbd>R</kbd> rotates · <kbd>⌫</kbd> deletes · <kbd>⌘Z</kbd> undoes
              </p>
            </div>
          </div>
        </>
      ) : (
        <div className="scroll">
          {EXPERIMENTS.map((ex) => (
            <button key={ex.id} className={`exp-item ${experimentId === ex.id ? 'on' : ''}`} onClick={() => (load(ex.id), set({ sheet: 'none' }))}>
              <i>{ex.no}</i>
              <div>
                <b>{ex.title}</b>
                <span>{ex.concept}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}
