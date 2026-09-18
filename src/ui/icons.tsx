import type { Kind } from '../model/types'

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function KindIcon({ kind }: { kind: Kind | 'pipe' | 'network' }) {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" {...S}>
      {kind === 'reservoir' && (
        <>
          <path d="M4 7v17a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V7" />
          <path d="M4 13q3-2.5 6 0t6 0 6 0 6 0" stroke="var(--accent)" />
          <path d="M9 19h6M18 22h5" stroke="var(--accent)" opacity=".6" />
        </>
      )}
      {kind === 'tank' && (
        <>
          <rect x="8" y="3" width="16" height="24" rx="3" />
          <path d="M8 16q2-2 4 0t4 0 4 0 4 0" stroke="var(--accent)" />
          <path d="M6 29h20" />
        </>
      )}
      {kind === 'junction' && (
        <>
          <path d="M3 16h26M16 16v13" opacity=".5" />
          <circle cx="16" cy="16" r="4.5" fill="var(--accent)" stroke="none" />
        </>
      )}
      {kind === 'outlet' && (
        <>
          <path d="M3 13h10l5 1.5v3L13 19H3" />
          <path d="M21 16q4 0 7-2M21 16q4 1 7 4M21 16q3 3 5 8" stroke="var(--accent)" strokeDasharray="1 3.5" />
        </>
      )}
      {kind === 'gauge' && (
        <>
          <circle cx="16" cy="16" r="12" />
          <path d="M16 16l6-7" stroke="#ff5d7a" strokeWidth="2.2" />
          <path d="M8 21a9.5 9.5 0 0 1 0-10M24 11a9.5 9.5 0 0 1 0 10" stroke="var(--accent)" opacity=".8" />
        </>
      )}
      {kind === 'pump' && (
        <>
          <circle cx="16" cy="16" r="11" />
          <path d="M16 13c3-3 7-2 9 1M19 16c3 3 2 7-1 9M16 19c-3 3-7 2-9-1M13 16c-3-3-2-7 1-9" stroke="var(--accent)" />
          <circle cx="16" cy="16" r="2" fill="currentColor" />
        </>
      )}
      {kind === 'valve' && (
        <>
          <path d="M4 9v14l12-7zM28 9v14l-12-7z" />
          <path d="M16 16V7M11 7h10" stroke="var(--accent)" />
        </>
      )}
      {kind === 'meter' && (
        <>
          <rect x="4" y="8" width="24" height="16" rx="4" />
          <path d="M10 19v-3M14 19v-6M18 19v-4M22 19v-7" stroke="var(--accent)" />
        </>
      )}
      {kind === 'element' && (
        <>
          <path d="M3 9h6l6 5h2l12-5M3 23h6l6-5h2l12 5" />
          <path d="M8 16h16" stroke="var(--accent)" strokeWidth="2.4" strokeDasharray="3 3" />
        </>
      )}
      {kind === 'dpgauge' && (
        <>
          <rect x="5" y="4" width="22" height="22" rx="5" />
          <path d="M12 19l4-9 4 9z" stroke="var(--accent)" />
          <path d="M2 22h3M27 22h3" />
        </>
      )}
      {kind === 'timer' && (
        <>
          <circle cx="16" cy="18" r="10.5" />
          <path d="M13 4h6M16 4v3.500M24 9l2-2" />
          <path d="M16 18V11.500" stroke="var(--accent)" strokeWidth="2.200" />
          <path d="M16 18l4.500 2.500" stroke="var(--accent)" strokeWidth="2.200" />
        </>
      )}
      {kind === 'manual' && (
        <>
          <rect x="4" y="4" width="24" height="24" rx="6" />
          <path d="M16 10v6M11.500 12.500a6.500 6.500 0 1 0 9 0" stroke="var(--accent)" strokeWidth="2.200" />
        </>
      )}
      {kind === 'switch' && (
        <>
          <path d="M3 22h8l10-8M23 22h6" />
          <circle cx="11" cy="22" r="2" fill="currentColor" />
          <circle cx="23" cy="22" r="2" fill="currentColor" />
          <path d="M6 9h20M6 5h20" stroke="var(--accent)" strokeDasharray="2 3" />
        </>
      )}
      {kind === 'pid' && (
        <>
          <rect x="4" y="4" width="24" height="24" rx="5" />
          <path d="M8 22c4 0 4-12 8-12s4 7 8 5" stroke="var(--accent)" strokeWidth="2.200" />
          <path d="M8 13h16" strokeDasharray="2 3" opacity=".6" />
        </>
      )}
      {kind === 'logic' && (
        <>
          <path d="M9 7h7a9 9 0 0 1 0 18H9z" />
          <path d="M3 12h6M3 20h6M25 16h5" stroke="var(--accent)" />
        </>
      )}
      {kind === 'lamp' && (
        <>
          <path d="M9 23V14a7 7 0 0 1 14 0v9zM7 27h18" />
          <path d="M16 2v2M5.500 6l1.500 1.500M26.500 6L25 7.500" stroke="var(--accent)" />
        </>
      )}
      {kind === 'vessel' && (
        <>
          <rect x="9" y="3" width="14" height="24" rx="7" />
          <path d="M9 17q7-5 14 0" stroke="var(--accent)" />
          <path d="M12 29h8M16 3V1" />
        </>
      )}
      {kind === 'leak' && (
        <>
          <path d="M3 13h26" opacity=".5" />
          <circle cx="16" cy="13" r="5" />
          <path d="M16 20v2M12 21l-1.500 3M20 21l1.500 3M16 26v2" stroke="var(--accent)" />
        </>
      )}
      {kind === 'jetpump' && (
        <>
          <path d="M3 9h8l6 3h3l9-3M3 19h8l6-3h3l9 3M10 19v9" />
          <path d="M3 14h13" stroke="var(--accent)" strokeWidth="2.400" />
        </>
      )}
      {kind === 'tee' && <path d="M3 12h26M3 20h9v9M29 20h-9v9" />}
      {kind === 'threeway' && (
        <>
          <path d="M3 8v12l10-6zM29 8v12l-10-6zM10 29h12l-6-10z" />
          <circle cx="16" cy="14" r="2" fill="var(--accent)" stroke="none" />
        </>
      )}
      {kind === 'airvalve' && (
        <>
          <path d="M3 27h26M14 27v-6h4v6" />
          <path d="M9 21v-8a7 7 0 0 1 14 0v8z" />
          <circle cx="16" cy="12" r="3" stroke="var(--accent)" />
        </>
      )}
      {kind === 'stager' && (
        <>
          <rect x="4" y="4" width="24" height="24" rx="5" />
          <path d="M9 23v-5M14 23v-9M19 23v-12M24 23v-3" stroke="var(--accent)" strokeWidth="2.400" />
        </>
      )}
      {kind === 'schedule' && (
        <>
          <rect x="4" y="4" width="24" height="24" rx="5" />
          <path d="M8 21h5v-8h9v8h3" stroke="var(--accent)" strokeWidth="2.200" />
        </>
      )}
      {kind === 'fitting' && (
        <>
          <path d="M3 20h13a6 6 0 0 0 6-6V3" />
          <path d="M3 12h11M14 12V3" opacity=".5" />
          <path d="M8 16h5" stroke="var(--accent)" strokeWidth="2.400" />
        </>
      )}
      {kind === 'relief' && (
        <>
          <path d="M4 9v14l10-7zM14 16l9-6v12z" />
          <path d="M23 16l1.500-3 1.500 6 1.500-6 1.500 3" stroke="var(--accent)" />
          <path d="M14 9V3M11 5l3-2 3 2" stroke="var(--accent)" />
        </>
      )}
      {kind === 'sequence' && (
        <>
          <rect x="4" y="4" width="24" height="24" rx="5" />
          <path d="M8 21h4v-7h5v4h4v-8h3" stroke="var(--accent)" strokeWidth="2.200" />
          <path d="M8 25h16" strokeDasharray="1 3" />
        </>
      )}
      {kind === 'thermo' && (
        <>
          <path d="M13 5a3 3 0 0 1 6 0v12.5a6 6 0 1 1-6 0z" />
          <path d="M16 11v9" stroke="var(--accent)" strokeWidth="2.400" />
          <circle cx="16" cy="23" r="2.500" fill="var(--accent)" stroke="none" />
        </>
      )}
      {kind === 'steamload' && (
        <>
          <rect x="3" y="9" width="26" height="14" rx="7" />
          <path d="M8 16h3l2-4 3 8 3-8 2 4h3" stroke="var(--accent)" />
          <path d="M9 9V4M23 23v5" />
        </>
      )}
      {kind === 'trap' && (
        <>
          <circle cx="16" cy="15" r="10" />
          <path d="M10 11h12M16 11v9" stroke="var(--accent)" strokeWidth="2.400" />
          <path d="M16 25v4" />
        </>
      )}
      {kind === 'inflow' && (
        <>
          <path d="M3 26h26M4 6h9v10" />
          <path d="M13 12q8 0 9 9h7" stroke="var(--accent)" />
        </>
      )}
      {kind === 'weir' && (
        <>
          <path d="M3 27h26M15 27V14" strokeWidth="2.400" />
          <path d="M3 10h10q7 0 9 12h7" stroke="var(--accent)" />
        </>
      )}
      {kind === 'gate' && (
        <>
          <path d="M3 27h26M16 3v17M11 3h10" />
          <path d="M3 10h13M16 23h13" stroke="var(--accent)" />
        </>
      )}
      {kind === 'outfall' && (
        <>
          <path d="M3 20h14v9" />
          <path d="M3 14h13q7 0 8 15" stroke="var(--accent)" />
        </>
      )}
      {kind === 'pipe' && (
        <>
          <path d="M3 12h26M3 20h26" />
          <path d="M8 16h3M15 16h3M22 16h3" stroke="var(--accent)" strokeWidth="2.4" />
        </>
      )}
      {kind === 'network' && (
        <>
          <path d="M7 8h10v16h8M17 16h8" opacity=".6" />
          <circle cx="7" cy="8" r="3" fill="var(--accent)" stroke="none" />
          <circle cx="25" cy="16" r="3" />
          <circle cx="25" cy="24" r="3" />
        </>
      )}
    </svg>
  )
}

export const Icon = {
  play: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.500 3.64A1 1 0 0 0 7 4.5z" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
      <rect x="5" y="4" width="5" height="16" rx="1.2" />
      <rect x="14" y="4" width="5" height="16" rx="1.2" />
    </svg>
  ),
  reset: (
    <svg viewBox="0 0 24 24" width="15" height="15" {...S} strokeWidth={2.2}>
      <path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v5h5" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" width="16" height="16" {...S} strokeWidth={3}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  undo: (
    <svg viewBox="0 0 24 24" width="16" height="16" {...S} strokeWidth={2.2}>
      <path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />
    </svg>
  ),
  redo: (
    <svg viewBox="0 0 24 24" width="16" height="16" {...S} strokeWidth={2.2}>
      <path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />
    </svg>
  ),
  parts: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...S} strokeWidth={2.2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" width="14" height="14" {...S} strokeWidth={2.4}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
}
