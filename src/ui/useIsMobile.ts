import { useSyncExternalStore } from 'react'

const query = typeof window !== 'undefined' ? window.matchMedia('(max-width: 860px)') : null

/** True on phone-sized viewports, where the side panels become slide-over sheets. */
export function useIsMobile() {
  return useSyncExternalStore(
    (cb) => {
      query?.addEventListener('change', cb)
      return () => query?.removeEventListener('change', cb)
    },
    () => query?.matches ?? false,
  )
}
