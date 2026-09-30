import { useEffect, useRef, useState } from 'react'
import { getThumb } from '../lib/thumbnails'
import type { MediaRef } from '../types'

/** Shape used before the real dimensions arrive — most clips are landscape. */
const FALLBACK_ASPECT = '16 / 9'

/**
 * One observer for every card on screen.
 *
 * A thumbnail costs a fetch and a decode, so with a long list the work has to
 * follow the scroll rather than the mount — otherwise opening the panel fires
 * off hundreds of them at once and nothing is usable until they all land. Shared
 * rather than per-card because the cards come and go constantly while scrolling.
 *
 * `rootMargin` starts the work a screenful early, so a card is usually filled in
 * by the time it is actually looked at.
 */
const ROOT_MARGIN = '400px 0px'
let observer: IntersectionObserver | null = null
const onVisible = new Map<Element, () => void>()

function watch(el: Element, cb: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    cb()
    return () => {}
  }
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const notify = onVisible.get(entry.target)
          // One-shot: once a card has been seen it stays loaded.
          observer?.unobserve(entry.target)
          onVisible.delete(entry.target)
          notify?.()
        }
      },
      { rootMargin: ROOT_MARGIN },
    )
  }
  onVisible.set(el, cb)
  observer.observe(el)
  return () => {
    observer?.unobserve(el)
    onVisible.delete(el)
  }
}

/**
 * The picture block of one combo card.
 *
 * Nothing about this is a fixed square any more: the thumbnail is generated at
 * the source's own aspect ratio and the box reserves exactly that shape, so a
 * portrait clip reads as portrait and nothing is cropped away. The box has to
 * reserve the space *before* the image arrives, otherwise every card reflows as
 * its preview loads and the grid jumps under the pointer.
 *
 * Rendering is async and can fail (remote clip blocked by CORS, file deleted
 * from the config folder…), so there are four visible states and none of them
 * is ever a broken image: a frame, a spinner, a type letter, or a placeholder.
 */
export function ComboThumb({ media }: { media: MediaRef | null }) {
  const cacheKey =
    media?.configPath ??
    media?.blobId ??
    (media?.source === 'url' ? media.url : null) ??
    ''

  const hostRef = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  const [thumb, setThumb] = useState<{ url: string; width: number; height: number } | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'empty'>(
    cacheKey ? 'idle' : 'empty',
  )

  // Defer until the card is near the viewport.
  useEffect(() => {
    const el = hostRef.current
    if (!el || seen) return
    return watch(el, () => setSeen(true))
  }, [seen])

  useEffect(() => {
    if (!media || !seen) return
    let alive = true
    setState('loading')
    void getThumb(media).then((result) => {
      if (!alive) return
      setThumb(result)
      setState(result ? 'done' : 'empty')
    })
    return () => {
      alive = false
    }
    // Re-run only when the underlying media changes, not on every parent render.
  }, [cacheKey, media, seen])

  return (
    <div
      ref={hostRef}
      className="relative w-full rounded-md bg-black/40 border border-white/5 overflow-hidden"
      style={{ aspectRatio: thumb ? `${thumb.width} / ${thumb.height}` : FALLBACK_ASPECT }}
    >
      {state === 'done' && thumb ? (
        <img src={thumb.url} alt="" className="w-full h-full object-cover" />
      ) : media && state !== 'idle' ? (
        <div className="w-full h-full flex items-center justify-center">
          {state === 'loading' ? (
            <span className="w-3 h-3 rounded-full border border-gray-600 border-t-transparent animate-spin" />
          ) : (
            <span className="text-[10px] font-bold text-gray-600">
              {media.type === 'video' ? 'VIDEO' : 'IMAGE'}
            </span>
          )}
        </div>
      ) : (
        <span className="w-full h-full flex items-center justify-center text-[10px] text-gray-700">
          {state === 'idle' ? '' : '—'}
        </span>
      )}
    </div>
  )
}
