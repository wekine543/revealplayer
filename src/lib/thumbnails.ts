/**
 * Small preview images for the combo list.
 *
 * Generating a thumbnail means reading the media again, which is not free, so
 * results are cached for the whole session — keyed by where the bytes live
 * (config path, IndexedDB blob id or remote URL). Cache entries hold the
 * failure as well, so a clip that cannot be decoded is not retried on every
 * re-render.
 */
import type { MediaRef } from '../types'
import { getBlob } from './db'
import { isActive, readMediaFile } from './configDir'
import { parkMedia } from './media'
import * as serverStore from './serverStore'

export type ThumbKind = 'image' | 'video'

/**
 * Thumbnails keep the SOURCE aspect ratio.
 *
 * They used to be generated square and centre-cropped, which was right when the
 * list showed them in a fixed square box. In the card grid a card takes its
 * shape from the picture, so cropping would quietly hide the top and bottom of
 * every portrait clip — the shape IS information here (portrait vs landscape is
 * the first thing you recognise about a clip).
 *
 * Only the long edge is bounded: enough pixels to look sharp on a retina card,
 * small enough that the data URLs stay cheap to keep in memory.
 */
const LONG_EDGE = 256
/** Floor so a very wide or tall source still produces a usable frame. */
const MIN_SHORT_EDGE = 48

export interface Thumb {
  url: string
  /** Output pixel size — the card uses the ratio to reserve the right shape. */
  width: number
  height: number
}

/**
 * A preview, or the reason there is none.
 *
 * `unsupported` separates "this browser cannot decode the clip" from every
 * other failure (missing file, unreachable URL, broken bytes). The card shows
 * a warning for the first and stays quiet for the rest — a library of phone
 * recordings is mostly HEVC, and those clips deserve an explanation rather
 * than a blank tile.
 */
export interface ThumbResult {
  thumb: Thumb | null
  unsupported: boolean
}

const NONE: ThumbResult = { thumb: null, unsupported: false }

/** Keyed by where the bytes live; holds failures too, so nothing is retried. */
const cache = new Map<string, ThumbResult>()
const inFlight = new Map<string, Promise<ThumbResult>>()

/**
 * How many previews are decoded at once.
 *
 * Each one fetches the clip and decodes a frame, and doing a hundred of those
 * in parallel is slower than doing them three at a time — the browser throttles,
 * the network saturates, and the frames the user is actually looking at land
 * last. Cards that scroll past pull themselves out of the queue before their
 * turn comes, so the limit costs nothing.
 */
const MAX_CONCURRENT = 3
let active = 0
const waiting: (() => void)[] = []

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active++
      task().then(resolve, reject).finally(() => {
        active--
        waiting.shift()?.()
      })
    }
    if (active < MAX_CONCURRENT) start()
    else waiting.push(start)
  })
}

function keyOf(ref: MediaRef | null): string | null {
  if (!ref) return null
  return ref.configPath ?? ref.blobId ?? (ref.source === 'url' ? ref.url : null) ?? null
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
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
 * Scale the source into a small JPEG data URL, preserving its aspect.
 *
 * No crop and no letterboxing: the canvas is sized to whatever shape the frame
 * already had, so nothing is dropped and no black bars are baked in.
 */
function toDataUrl(
  source: HTMLImageElement | HTMLVideoElement,
  sw: number,
  sh: number,
): Thumb | null {
  if (sw <= 0 || sh <= 0) return null

  const longEdge = Math.max(sw, sh)
  const scale = LONG_EDGE / longEdge
  const width = Math.max(MIN_SHORT_EDGE, Math.round(sw * scale))
  const height = Math.max(MIN_SHORT_EDGE, Math.round(sh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, width, height)
  try {
    return { url: canvas.toDataURL('image/jpeg', 0.72), width, height }
  } catch {
    // A cross-origin source taints the canvas — nothing we can show.
    return null
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = src
  })
}

/** Grab a frame near the start of the clip — the black first frame is useless. */
async function loadVideoFrame(src: string): Promise<ThumbResult> {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  // Mobile Safari will not decode a video that is not in the document.
  const unpark = parkMedia(video)
  video.src = src

  let codecUnsupported = false
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => {
          // 4 = MEDIA_ERR_SRC_NOT_SUPPORTED: the bytes arrived and the browser
          // still cannot decode them, which is a codec problem rather than a
          // missing file (2 = MEDIA_ERR_NETWORK). Only the first is worth a
          // warning on the card.
          codecUnsupported = video.error?.code === 4
          reject(new Error('video load failed'))
        }
      }),
      8000,
    )

    // The container parsed but carries no decodable picture: a codec this
    // browser has no decoder for (HEVC without the Windows extension, most
    // often). Worth telling the user about, unlike a file that is simply gone.
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      return { thumb: null, unsupported: true }
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 1
    const target = Math.min(duration * 0.1, 1)
    if (target > 0.05) {
      await withTimeout(
        new Promise<void>((resolve) => {
          video.onseeked = () => resolve()
          video.currentTime = target
        }),
        5000,
      ).catch(() => {
        // Some codecs never fire `seeked`; draw whatever is on screen instead.
      })
    }
    const thumb = toDataUrl(video, video.videoWidth, video.videoHeight)
    return { thumb, unsupported: thumb === null && video.videoWidth > 0 }
  } catch {
    return codecUnsupported ? { thumb: null, unsupported: true } : NONE
  } finally {
    video.removeAttribute('src')
    video.load()
    unpark()
  }
}

/** Where the bytes for this ref actually come from. */
async function sourceUrl(ref: MediaRef): Promise<{ url: string; owned: boolean } | null> {
  if (ref.configPath) {
    // Same directory layout in both backends, so a folder-written path is also
    // a valid server path — that is what lets a phone preview desktop combos.
    if (serverStore.isActive()) {
      return { url: serverStore.mediaUrl(ref.configPath), owned: false }
    }
    if (isActive()) {
      const file = await readMediaFile(ref.configPath)
      if (file) return { url: URL.createObjectURL(file), owned: true }
    }
    if (serverStore.isAvailable()) {
      return { url: serverStore.mediaUrl(ref.configPath), owned: false }
    }
  }
  if (ref.blobId) {
    const blob = await getBlob(ref.blobId)
    if (!blob) return null
    return { url: URL.createObjectURL(blob), owned: true }
  }
  if (ref.source === 'url' && ref.url) return { url: ref.url, owned: false }
  return null
}

async function generate(ref: MediaRef): Promise<ThumbResult> {
  const source = await sourceUrl(ref)
  if (!source) return NONE

  try {
    if (ref.type === 'video') return await loadVideoFrame(source.url)
    const img = await withTimeout(loadImage(source.url), 8000)
    return { thumb: toDataUrl(img, img.naturalWidth, img.naturalHeight), unsupported: false }
  } catch {
    return NONE
  } finally {
    if (source.owned) URL.revokeObjectURL(source.url)
  }
}

/** Preview for the combo card, plus whether the clip cannot be decoded here. */
export function getThumb(ref: MediaRef | null): Promise<ThumbResult> {
  const key = keyOf(ref)
  if (!key || !ref) return Promise.resolve(NONE)

  const cached = cache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)

  const running = inFlight.get(key)
  if (running) return running

  const task = enqueue(() => generate(ref))
    .catch(() => NONE)
    .then((result) => {
      cache.set(key, result)
      inFlight.delete(key)
      return result
    })
  inFlight.set(key, task)
  return task
}
