/**
 * Device class, used to pick defaults.
 *
 * Kept in one place because the engine and the settings layer have to agree: if
 * the quality default said "desktop" while the render caps said "mobile", a
 * phone would start at 原画 and immediately be throttled by the caps anyway.
 *
 * The UA check matters on its own: a phone in landscape is not "small", and
 * some tablets report a fine pointer, so neither signal is sufficient alone.
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false
  const coarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) <= 900
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent)
  return mobileUA || (coarsePointer && smallScreen)
}
