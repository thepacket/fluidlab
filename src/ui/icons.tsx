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
  chevron: (
    <svg viewBox="0 0 24 24" width="14" height="14" {...S} strokeWidth={2.4}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
}
