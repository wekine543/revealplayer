/**
 * Native fullscreen (真全屏) helpers.
 *
 * These drive the real Fullscreen API — the browser takes over the whole
 * screen, including its own chrome. That is a different thing from the
 * "web fullscreen" layout mode in the store, which only rearranges the page.
 */

/** Safari still ships the prefixed API for elements, and iOS only has that. */
type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

/** Is the document currently in native fullscreen? */
export function isNativeFullscreen(): boolean {
  const doc = document as WebkitDocument
  return !!(doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null)
}

/**
 * Enter or leave native fullscreen for `el`.
 *
 * Both calls can reject — iOS Safari does not support element fullscreen at
 * all, and every browser refuses a request that is not tied to a user gesture.
 * A rejected toggle should never surface as an unhandled error, so failures are
 * swallowed here and the UI simply stays as it was.
 */
export async function toggleNativeFullscreen(el: HTMLElement | null): Promise<void> {
  if (!el) return
  const doc = document as WebkitDocument
  try {
    if (isNativeFullscreen()) {
      const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen
      await exit?.call(doc)
    } else {
      const enter = el.requestFullscreen ?? (el as WebkitElement).webkitRequestFullscreen
      await enter?.call(el)
    }
  } catch {
    /* fullscreen unsupported or blocked — nothing to do */
  }
}
