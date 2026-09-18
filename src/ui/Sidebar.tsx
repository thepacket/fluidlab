import { useState } from 'react'
import { EXPERIMENTS } from '../experiments'
import { KIND_META, type Kind } from '../model/types'
import { useLab } from '../store'
import { KindIcon } from './icons'

const GROUPS: { name: string; kinds: Kind[] }[] = [
  { name: 'Sources & storage', kinds: ['reservoir', 'tank'] },
  { name: 'Equipment', kinds: ['pump', 'valve'] },
  { name: 'Nodes', kinds: ['junction', 'outlet'] },
  { name: 'Control', kinds: ['manual', 'timer', 'switch', 'pid', 'logic', 'lamp'] },
  { name: 'Instruments', kinds: ['gauge', 'dpgauge', 'meter', 'element'] },
]

export function Sidebar() {
  const [tab, setTab] = useState<'build' | 'lab'>('lab')
  const experimentId = useLab((s) => s.experimentId)
  const load = useLab((s) => s.loadExperiment)
  const set = useLab((s) => s.set)
  const add = (k: Kind) => {
    window.dispatchEvent(new CustomEvent('fluidlab:add', { detail: k }))
    set({ sheet: 'none' })
  }

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
        <div className="scroll">
          {GROUPS.map((g) => (
            <div key={g.name}>
              <h4>{g.name}</h4>
              {g.kinds.map((k) => (
                <div
                  key={k}
                  className="palette-item"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/fluidlab', k)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => add(k)}
                >
                  <div className="palette-icon">
                    <KindIcon kind={k} />
                  </div>
                  <div>
                    <b>{KIND_META[k].name}</b>
                    <span>{KIND_META[k].blurb}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
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
