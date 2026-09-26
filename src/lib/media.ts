import type { MediaItem } from '../types'

const VIDEO_EXT = ['mp4', 'webm', 'ogg', 'mov']
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg']

export function getMediaType(fileName: string): 'video' | 'image' | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (IMAGE_EXT.includes(ext)) return 'image'
  return null
}

export function isMediaFile(fileName: string): boolean {
  return getMediaType(fileName) !== null
}

/** Reject rather than hang forever when a source never reports back. */
const LOAD_TIMEOUT_MS = 25000

/**
 * Park a media element in the document while it loads.
 *
 * Mobile Safari refuses to decode a <video> that is not in the document, so
 * loading detached — which works fine on desktop Chrome — leaves a phone
 * staring at a black canvas with no error. It is parked far off-screen and
 * taken out again afterwards.
 */
export function parkMedia(el: HTMLElement): () => void {
  return park(el)
}

function park(el: HTMLElement): () => void {
  el.style.position = 'fixed'
  el.style.left = '-10000px'
  el.style.top = '0'
  el.style.width = '1px'
  el.style.height = '1px'
  el.style.opacity = '0'
  el.style.pointerEvents = 'none'
  el.setAttribute('aria-hidden', 'true')
  document.body.appendChild(el)
  return () => {
    if (el.parentNode) el.parentNode.removeChild(el)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Create an HTMLVideoElement (hidden and parked in the document) for a URL.
 *
 * Resolves once metadata is in, which is all the loader needs; the engine
 * builds its own element to actually play.
 */
export function createVideoElement(url: string): Promise<HTMLVideoElement> {
  return withTimeout(
    new Promise<HTMLVideoElement>((resolve, reject) => {
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      const unpark = park(video)

      let settled = false
      const done = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }

      video.addEventListener('loadedmetadata', () =>
        done(() => {
          resolve(video)
          // Taken out on the next macrotask, after the caller has had its
          // microtask turn to read the dimensions off the element.
          setTimeout(unpark, 0)
        }),
      )
      video.addEventListener('error', () =>
        done(() => {
          const code = video.error?.code
          const detail = code ? ` (media error ${code})` : ''
          unpark()
          reject(new Error(`Failed to load video: ${url}${detail}`))
        }),
      )

      video.src = url
      // Explicit after parking: some browsers otherwise wait for a play
      // attempt before fetching anything.
      video.load()
    }),
    LOAD_TIMEOUT_MS,
    `Video ${url}`,
  )
}

/**
 * Create an HTMLImageElement for a given URL.
 */
export function createImageElement(url: string): Promise<HTMLImageElement> {
  return withTimeout(
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'

      img.addEventListener('load', () => resolve(img))
      img.addEventListener('error', () => {
        reject(new Error(`Failed to load image: ${url}`))
      })

      img.src = url
    }),
    LOAD_TIMEOUT_MS,
    `Image ${url}`,
  )
}

/**
 * Load a local File into a MediaItem with an object URL.
 */
export async function loadLocalFile(file: File): Promise<MediaItem> {
  const type = getMediaType(file.name)
  if (!type) throw new Error(`Unsupported file type: ${file.name}`)

  const url = URL.createObjectURL(file)

  if (type === 'video') {
    const video = await createVideoElement(url)
    return {
      type: 'video',
      source: 'local',
      url,
      fileName: file.name,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
    }
  } else {
    const img = await createImageElement(url)
    return {
      type: 'image',
      source: 'local',
      url,
      fileName: file.name,
      width: img.naturalWidth,
      height: img.naturalHeight,
    }
  }
}

/**
 * Load a remote URL into a MediaItem.
 */
export async function loadUrlMedia(url: string): Promise<MediaItem> {
  // Guess type from URL extension. The path may be percent-encoded (a Chinese
  // or spaced file name served by the store does), so sniff the decoded form.
  const path = url.split('?')[0]
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // Not valid percent-encoding — sniff what we were given.
  }
  let type = getMediaType(decoded) ?? getMediaType(path)
  if (!type) {
    // Try fetching headers
    const res = await fetch(url, { method: 'HEAD', mode: 'cors' })
    const ct = res.headers.get('Content-Type') ?? ''
    if (ct.startsWith('video/')) type = 'video'
    else if (ct.startsWith('image/')) type = 'image'
    else throw new Error('Cannot determine media type from URL')
  }

  if (type === 'video') {
    const video = await createVideoElement(url)
    return {
      type: 'video',
      source: 'url',
      url,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
    }
  } else {
    const img = await createImageElement(url)
    return {
      type: 'image',
      source: 'url',
      url,
      width: img.naturalWidth,
      height: img.naturalHeight,
    }
  }
}

/**
 * Format seconds to mm:ss
 */
export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '00:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
