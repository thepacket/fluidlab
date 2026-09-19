import { useSyncExternalStore } from 'react'

const query = typeof window !== 'undefined' ? window.matchMedia('(max-width: 860px)') : null

const coarse = typeof window !== 'undefined' ? window.matchMedia('(pointer: coarse)') : null

/** True when the main pointer is a finger: one finger must move the bench, and there is no hover, right button or keyboard. */
export function useIsTouch() {
  return useSyncExternalStore(
    (cb) => {
      coarse?.addEventListener('change', cb)
      return () => coarse?.removeEventListener('change', cb)
    },
    () => coarse?.matches ?? false,
  )
}

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
