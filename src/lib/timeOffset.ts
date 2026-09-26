/**
 * The intentional A→B time offset.
 *
 * Positive = B leads: at any moment B sits `offset` seconds further into its own
 * timeline than A does ("B is faster"). Negative = B lags. This exists for pairs
 * that really do have a constant skew — a second render, a capture that started
 * a beat late — where lining the two up means the sync loop must *hold* them
 * apart by a fixed amount instead of pulling them onto the same clock.
 */

export const OFFSET_MIN = -3
export const OFFSET_MAX = 3
/** Fine control down to a hundredth of a second. */
export const OFFSET_STEP = 0.01

export function clampOffset(v: number): number {
  if (!Number.isFinite(v)) return 0
  const stepped = Math.round(v / OFFSET_STEP) * OFFSET_STEP
  return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, stepped))
}

/** `+0.05s` / `-1.20s` / `0.00s` — signed, for the readout next to the slider. */
export function formatOffset(v: number): string {
  if (Math.abs(v) < OFFSET_STEP / 2) return '0.00s'
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}s`
}
