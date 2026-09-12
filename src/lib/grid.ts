/**
 * Grid ("both at once") layout maths.
 *
 * Shared by the renderer, which needs the split to place the two cells, and by
 * the React layer, which needs the joined aspect ratio to size the container.
 * Keeping it in one place is what stops the box on screen from disagreeing with
 * the picture drawn inside it.
 */

export const FALLBACK_ASPECT = 16 / 9

export interface GridLayout {
  /** true: A left / B right. false: A top / B bottom. */
  horizontal: boolean
  /** Aspect ratio (w / h) of the two cells joined together. */
  aspect: number
  /**
   * Fraction of the split axis taken by A — width when horizontal, height when
   * vertical. Measured from A's own end (left / top), not from the UV origin,
   * because A is the first cell in both directions.
   */
  split: number
  /** Both slots hold media. With one slot the single item gets the whole frame. */
  hasBoth: boolean
}

function usable(aspect: number | null): aspect is number {
  return typeof aspect === 'number' && isFinite(aspect) && aspect > 0
}

/**
 * Decide how to lay two media out side by side.
 *
 * Two landscape clips stack (A above B): putting them side by side would make
 * the joined frame very wide and both cells small. Anything else — two portraits,
 * or one of each — goes left/right, where a tall clip keeps its height instead of
 * being squeezed into half of it.
 *
 * The joined ratio is what the two clips measure when they are genuinely put
 * together: side by side they share a height, so the widths add; stacked they
 * share a width, so the heights add. Either way no cell has to letterbox — the
 * frame ends up exactly the size of its contents.
 */
export function gridLayout(aspectA: number | null, aspectB: number | null): GridLayout {
  const hasA = usable(aspectA)
  const hasB = usable(aspectB)

  if (hasA && hasB) {
    // Landscape is "at least as wide as it is tall"; a square counts, so two
    // squares stack rather than sitting side by side.
    const bothLandscape = aspectA >= 1 && aspectB >= 1

    if (!bothLandscape) {
      const aspect = aspectA + aspectB
      return { horizontal: true, aspect, split: clampSplit(aspectA / aspect), hasBoth: true }
    }

    // Stacked: share a width, so the heights add and A's share of the height is
    // the inverse of its aspect — hence aspectB, not aspectA, in the numerator.
    const aspect = (aspectA * aspectB) / (aspectA + aspectB)
    return { horizontal: false, aspect, split: clampSplit(aspectB / (aspectA + aspectB)), hasBoth: true }
  }

  const single = hasA ? aspectA : hasB ? aspectB : FALLBACK_ASPECT
  return { horizontal: true, aspect: single, split: 1, hasBoth: false }
}

/**
 * Keep the split away from 0 and 1.
 *
 * The shader divides by `split` and `1 - split`; a pathological clip (a 100:1
 * panorama next to a 1:100 strip) would otherwise divide by nearly zero.
 */
function clampSplit(split: number): number {
  return Math.min(0.98, Math.max(0.02, split))
}
