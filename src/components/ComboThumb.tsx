import { useEffect, useState } from 'react'
import { getThumb } from '../lib/thumbnails'
import type { MediaRef } from '../types'

/** Shape used before the real dimensions arrive — most clips are landscape. */
const FALLBACK_ASPECT = '16 / 9'

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
 * from the config folder…), so there are three visible states and none of them
 * is ever a broken image: a frame, a type letter, or a quiet placeholder.
 */
export function ComboThumb({ media }: { media: MediaRef | null }) {
  const cacheKey =
    media?.configPath ??
    media?.blobId ??
    (media?.source === 'url' ? media.url : null) ??
    ''

  const [thumb, setThumb] = useState<{ url: string; width: number; height: number } | null>(null)
  const [state, setState] = useState<'loading' | 'done' | 'empty'>(cacheKey ? 'loading' : 'empty')

  useEffect(() => {
    if (!media) {
      setThumb(null)
      setState('empty')
      return
    }
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
  }, [cacheKey, media])

  return (
    <div
      className="relative w-full rounded-md bg-black/40 border border-white/5 overflow-hidden"
      style={{ aspectRatio: thumb ? `${thumb.width} / ${thumb.height}` : FALLBACK_ASPECT }}
    >
      {state === 'done' && thumb ? (
        <img src={thumb.url} alt="" className="w-full h-full object-cover" />
      ) : media ? (
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
          —
        </span>
      )}
    </div>
  )
}
