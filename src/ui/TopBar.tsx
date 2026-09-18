import { useRef, useState } from 'react'
import { solver } from '../engine/client'
import { MASS_FLOW_UNITS, METRIC, UNITS, US, type UnitPrefs } from '../model/units'
import { FLUIDS } from '../model/types'
import { shareUrl } from '../share'
import { useLab, usesClock, type Overlay } from '../store'
import { Icon } from './icons'

const clock = (t: number) => {
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const UNIT_NAMES: Record<keyof UnitPrefs, string> = {
  pressure: 'Pressure',
  flow: 'Flow',
  length: 'Length',
  head: 'Head',
  diameter: 'Diameter',
  roughness: 'Roughness',
  velocity: 'Velocity',
  power: 'Power',
  temperature: 'Temperature',
  time: 'Time',
  volume: 'Volume',
  kfactor: 'K-factor',
}

export function TopBar() {
  const s = useLab()
  const steam = !!FLUIDS.find((f) => f.id === s.fluidId)?.steam
  const [unitsOpen, setUnitsOpen] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const hasTanks = s.nodes.some(usesClock)

  const [shared, setShared] = useState<'idle' | 'copied' | 'shown'>('idle')
  const [link, setLink] = useState('')
  const share = async () => {
    const url = await shareUrl(s.exportProject(), location.origin + location.pathname)
    setLink(url)
    try {
      await navigator.clipboard.writeText(url)
      setShared('copied')
      setTimeout(() => setShared('idle'), 2500)
    } catch {
      setShared('shown') // no clipboard permission: show the link so it can be copied by hand
    }
  }
  const save = () => {
    const blob = new Blob([s.exportProject()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${s.projectName.replace(/[^\w-]+/g, '-').toLowerCase() || 'rig'}.fluidlab.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="30" height="30">
          <defs>
            <linearGradient id="logo" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#7df3ff" />
              <stop offset="1" stopColor="#2a6bff" />
            </linearGradient>
          </defs>
          <path d="M16 2.5C16 2.5 6 13.5 6 20a10 10 0 0 0 20 0C26 13.500 16 2.500 16 2.500z" fill="url(#logo)" />
          <path d="M9.500 20.500q3.200-2.600 6.500 0t6.500 0" fill="none" stroke="#04101f" strokeWidth="2.200" strokeLinecap="round" />
        </svg>
        <div>
          <b>
            Fluid<em>Lab</em>
          </b>
          <span>hydraulic network bench</span>
        </div>
      </div>

      <div className="seg" title="What the pipe colours show">
        {((s.results.thermal ? ['pressure', 'velocity', 'thermal', 'plain'] : ['pressure', 'velocity', 'plain']) as Overlay[]).map((o) => (
          <button key={o} className={s.overlay === o ? 'on' : ''} onClick={() => s.set({ overlay: o })}>
            {o}
          </button>
        ))}
      </div>

      <div className="sim">
        <button className={`round ${s.running ? 'on' : ''}`} onClick={() => s.set({ running: !s.running })} title={s.running ? 'Pause lab clock' : 'Run lab clock'}>
          {s.running ? Icon.pause : Icon.play}
        </button>
        <div className="clock">
          <b>{clock(s.simTime)}</b>
          <span>{hasTanks ? 'lab time' : 'steady state'}</span>
        </div>
        <select value={s.timeScale} onChange={(e) => s.set({ timeScale: Number(e.target.value) })} title="Time acceleration">
          {[1, 5, 10, 20, 30, 60, 300, 1200].map((x) => (
            <option key={x} value={x}>
              {x}×
            </option>
          ))}
        </select>
        <button className="icon-btn" onClick={s.resetSim} title="Reset tank levels and clock">
          {Icon.reset}
        </button>
      </div>

      <div className="history">
        <button className="icon-btn" disabled={!s.past.length} onClick={s.undo} title="Undo (⌘Z)">
          {Icon.undo}
        </button>
        <button className="icon-btn" disabled={!s.future.length} onClick={s.redo} title="Redo (⇧⌘Z)">
          {Icon.redo}
        </button>
      </div>

      {s.results.thermal && !steam && (
        <div className="seg" title="Water temperatures: where they settle, or marched through lab time (warm-up, cool-down, dead legs)">
          {(['steady', 'live'] as const).map((m) => (
            <button
              key={m}
              className={s.heatMode === m ? 'on' : ''}
              onClick={() => s.set({ heatMode: m, heat: null, ...(m === 'live' ? { overlay: 'thermal' as Overlay } : s.solved ? { results: s.solved } : {}) })}
            >
              {m === 'steady' ? 'settled' : 'live heat'}
            </button>
          ))}
        </div>
      )}
      {s.results.channel && (
        <div className="seg" title="Open channels: the settled water surface, or marched through lab time (flood waves, gate surges)">
          {(['steady', 'live'] as const).map((m) => (
            <button key={m} className={s.flowMode === m ? 'on' : ''} onClick={() => s.set({ flowMode: m, wave: null, ...(m === 'steady' && s.solved ? { results: s.solved } : {}) })}>
              {m === 'steady' ? 'settled' : 'live flow'}
            </button>
          ))}
        </div>
      )}
      {s.results.gas && (
        <div className="gas-badge" title={steam ? 'Saturated steam: flows are mass flows' : 'Flows are standard volumes at 15 °C and 1 atm'}>
          {steam ? 'STEAM · mass flow' : 'GAS · standard flow'}
        </div>
      )}

      <div className="spacer" />

      <div className={`solver ${s.results.ok ? 'ok' : s.results.error ? 'bad' : ''}`} title={`${solver.name}${solver.threaded ? ' · in a Web Worker' : ''}`}>
        <i />
        <div>
          <b>{!s.engineReady ? 'Loading solver…' : s.results.ok ? `Solved in ${s.results.solveMs.toFixed(1)} ms` : s.results.error ? 'Not solved' : 'Idle'}</b>
          <span>{s.results.gas ? 'Gas network · Newton' : solver.name}</span>
        </div>
      </div>

      <div className="pop-wrap">
        <button className="btn" onClick={() => setUnitsOpen(!unitsOpen)}>
          Units {Icon.chevron}
        </button>
        {unitsOpen && (
          <div className="popover" onMouseLeave={() => setUnitsOpen(false)}>
            <div className="seg full">
              <button className={s.units.pressure === 'kPa' && s.units.flow === 'L/min' ? 'on' : ''} onClick={() => s.set({ units: METRIC })}>
                Metric
              </button>
              <button className={s.units.pressure === 'psi' && s.units.flow === 'GPM' ? 'on' : ''} onClick={() => s.set({ units: US })}>
                US customary
              </button>
            </div>
            {(Object.keys(UNITS) as (keyof UnitPrefs)[])
              .filter((q) => UNITS[q].length > 1)
              .map((q) => (
                <div className="field" key={q}>
                  <span>{UNIT_NAMES[q]}</span>
                  <select value={s.units[q]} onChange={(e) => s.set({ units: { ...s.units, [q]: e.target.value } })}>
                    {UNITS[q]
                      .filter((u) => q !== 'flow' || MASS_FLOW_UNITS.includes(u.id) === steam)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.label}
                        </option>
                      ))}
                  </select>
                </div>
              ))}
            <p className="muted">Stored in SI — units only change the display.</p>
          </div>
        )}
      </div>
      <button className="btn" onClick={s.newProject}>
        New
      </button>
      <button className="btn" onClick={() => file.current?.click()}>
        Open
      </button>
      <button className="btn primary" onClick={save}>
        Save
      </button>
      <div className="pop-wrap">
        <button className="btn" onClick={share} title="Copy a link that opens this rig — the rig travels inside the link itself">
          {shared === 'copied' ? 'Link copied' : 'Share'}
        </button>
        {shared === 'shown' && (
          <div className="popover" onMouseLeave={() => setShared('idle')}>
            <p className="muted">Copy this link — the whole rig is inside it:</p>
            <input className="share-link" readOnly value={link} onFocus={(e) => e.target.select()} autoFocus />
          </div>
        )}
      </div>
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0]
          if (!f) return
          try {
            s.loadProject(await f.text())
          } catch (err) {
            alert(`Could not open that file: ${err instanceof Error ? err.message : err}`)
          }
          e.target.value = ''
        }}
      />
    </header>
  )
}
