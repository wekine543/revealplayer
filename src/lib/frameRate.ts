import { parkMedia } from './media'

/**
 * Real frame rate for a video, measured rather than read from a header.
 *
 * There is no portable `video.frameRate`: MP4/WebM keep it in container
 * metadata that the DOM never exposes, and `getVideoPlaybackQuality()` only
 * reports counts. So the clip is played muted for a moment and the presented
 * frames are counted against the media clock — which is also the rate the
 * viewer actually sees, including any drop the browser is doing.
 *
 * The probe is cheap (a few hundred milliseconds of playback) and cached per
 * URL, so re-mounting a panel or rendering the same picker twice never plays
 * it twice.
 */

/** Metadata passed to a requestVideoFrameCallback handler (Safari omits fields). */
interface FrameMeta {
  mediaTime?: number
  presentedFrames?: number
}

interface RvFCVideo {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/** Media-time span we want before trusting the result. */
const MIN_SPAN = 0.5
/** ...and the number of presented frames: two samples alone are too noisy. */
const MIN_FRAMES = 3
/** Hard ceiling, so a slow decode cannot keep a probe running forever. */
const MAX_WALL_MS = 2500
/** Anything past this is a measurement artefact, not a frame rate. */
const MAX_PLAUSIBLE = 240

/**
 * Rates video actually ships in. A measured value within a hair of one of
 * these is shown as the nominal rate: 29.97 measured as 29.94 should read
 * 29.97, not whatever the counter happened to produce.
 */
const STANDARD_RATES = [
  23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 90, 100, 119.88, 120,
]

const cache = new Map<string, Promise<number | null>>()

/**
 * Measure the frame rate of `url`, or null when it cannot be determined
 * (no requestVideoFrameCallback, decode failure, or a clip too short to
 * sample). Repeated calls for the same URL share one measurement.
 */
export function probeFrameRate(url: string): Promise<number | null> {
  let pending = cache.get(url)
  if (!pending) {
    pending = measure(url)
    cache.set(url, pending)
  }
  return pending
}

/** `29.97` -> `"29.97"`, `30` -> `"30"`. */
export function formatFrameRate(fps: number): string {
  const r = Math.round(fps * 100) / 100
  return Number.isInteger(r) ? String(r) : r.toFixed(2)
}

function snap(fps: number): number {
  for (const std of STANDARD_RATES) {
    if (Math.abs(fps - std) <= 0.08) return std
  }
  return Math.round(fps * 100) / 100
}

function rateOf(frames: number, span: number): number | null {
  if (!isFinite(span) || span <= 0.05 || frames <= 0) return null
  const fps = frames / span
  if (!isFinite(fps) || fps <= 0 || fps > MAX_PLAUSIBLE) return null
  return snap(fps)
}

/** Resolve on `event`, or after `ms` — whichever comes first. */
function once(el: HTMLVideoElement, event: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      el.removeEventListener(event, onEvent)
      clearTimeout(timer)
      resolve(ok)
    }
    const onEvent = () => finish(true)
    const timer = setTimeout(() => finish(false), ms)
    el.addEventListener(event, onEvent)
  })
}

function measure(url: string): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'

    const rvfc = (video as HTMLVideoElement & RvFCVideo).requestVideoFrameCallback
    if (typeof rvfc !== 'function') {
      // No frame callbacks (Firefox, older Safari): better to show nothing
      // than a number guessed from the container.
      resolve(null)
      return
    }
    const request = rvfc.bind(video) as (cb: (now: number, meta: FrameMeta) => void) => number
    const cancel = (video as HTMLVideoElement & RvFCVideo).cancelVideoFrameCallback?.bind(video)

    const unpark = parkMedia(video)

    let settled = false
    let handle = 0
    let timer = 0
    const samples: { t: number; f: number }[] = []

    const bestEffort = (): number | null => {
      if (samples.length < 2) return null
      const first = samples[0]
      const last = samples[samples.length - 1]
      return rateOf(last.f - first.f, last.t - first.t)
    }

    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      if (handle && cancel) cancel(handle)
      clearTimeout(timer)
      try {
        video.pause()
      } catch {
        /* already stopped */
      }
      video.removeAttribute('src')
      unpark()
      resolve(value)
    }

    const onFrame = (_now: number, meta: FrameMeta) => {
      if (settled) return
      const index = samples.length
      // `presentedFrames` is the browser's own counter where available;
      // otherwise the callback index stands in for it. Either way the span
      // between the first and last sample covers (frames) intervals.
      const t = typeof meta?.mediaTime === 'number' ? meta.mediaTime : 0
      const f =
        typeof meta?.presentedFrames === 'number' && meta.presentedFrames > 0
          ? meta.presentedFrames
          : index
      samples.push({ t, f })

      const first = samples[0]
      const value = rateOf(f - first.f, t - first.t)
      const enough = value !== null && f - first.f >= MIN_FRAMES && t - first.t >= MIN_SPAN
      if (enough) {
        finish(value)
        return
      }
      handle = request(onFrame)
    }

    const start = () => {
      // The metadata watchdog is superseded by the sampling one.
      clearTimeout(timer)
      timer = setTimeout(() => finish(bestEffort()), MAX_WALL_MS)
      video.addEventListener('ended', () => finish(bestEffort()))
      video.addEventListener('error', () => finish(null))
      video.play().then(
        () => {
          if (settled) return
          handle = request(onFrame)
        },
        () => finish(null),
      )
    }

    video.addEventListener('loadedmetadata', () => {
      // Skip past the first frame: decoders often present the opening frames
      // late, which would drag the measured rate down.
      const target = isFinite(video.duration) && video.duration > 2 ? Math.min(video.duration * 0.1, 2) : 0
      if (target > 0) {
        video.currentTime = target
        void once(video, 'seeked', 1500).then(start)
      } else {
        start()
      }
    })
    video.addEventListener('error', () => finish(null))

    video.src = url
    video.load()
    // Nothing may ever answer (unsupported codec, offline source).
    timer = setTimeout(() => finish(null), MAX_WALL_MS + 2000)
  })
}
