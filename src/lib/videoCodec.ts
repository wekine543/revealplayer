/**
 * What video codec a clip actually is.
 *
 * The browser will not say. `canPlayType` only answers about formats in the
 * abstract ("maybe this file could contain H.264"), and a failure reports the
 * same "source not supported" whether the file is corrupt, missing a video
 * track, or simply in a codec this machine cannot decode. The one place that
 * states it outright is the sample-entry fourcc inside the container's `stsd`
 * box, so it is read from there.
 *
 * It matters because phones record HEVC by default, and Chrome on Windows
 * cannot decode HEVC unless the system's HEVC extension is installed — which
 * makes a whole library of phone clips look broken for no visible reason.
 */

export type VideoCodec =
  | 'avc1' | 'avc3'      // H.264
  | 'hvc1' | 'hev1'      // HEVC / H.265
  | 'av01'               // AV1
  | 'vp09' | 'vp08'      // VP9 / VP8
  | 'mp4v'               // MPEG-4 Part 2
  | 'unknown'

const FOURCCS: VideoCodec[] = ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'vp08', 'mp4v']

/** How much of each end to look at. `moov` sits at the front or the back. */
const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 4 * 1024 * 1024

function fourccAt(view: Uint8Array, offset: number): string {
  let text = ''
  for (let i = 0; i < 4; i++) text += String.fromCharCode(view[offset + i] ?? 0)
  return text
}

function indexOfAscii(haystack: Uint8Array, needle: string): number {
  const first = needle.charCodeAt(0)
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (haystack[i] !== first) continue
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer
    }
    return i
  }
  return -1
}

/** The sample entry fourcc, from `stsd`'s first entry. */
export function codecFromWindows(windows: Uint8Array[]): VideoCodec {
  for (const window of windows) {
    const stsd = indexOfAscii(window, 'stsd')
    if (stsd < 0) continue
    // stsd payload: version+flags (4) entryCount (4), then size (4) + fourcc (4).
    const fourcc = fourccAt(window, stsd + 20)
    if (FOURCCS.includes(fourcc as VideoCodec)) return fourcc as VideoCodec
    // Box layout differs (fragmented MP4), but the codec name is still nearby.
    for (const candidate of FOURCCS) {
      if (indexOfAscii(window.subarray(stsd, stsd + 4096), candidate) >= 0) return candidate
    }
  }
  return 'unknown'
}

async function fetchWindow(url: string, from: number | null, length: number): Promise<Uint8Array | null> {
  try {
    const range = from === null ? null : `bytes=${from}-${from + length - 1}`
    const res = await fetch(url, range ? { headers: { Range: range } } : undefined)
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

async function windowsOf(source: File | Blob | string): Promise<Uint8Array[]> {
  if (typeof source !== 'string') {
    const head = new Uint8Array(await source.slice(0, HEAD_BYTES).arrayBuffer())
    const tail =
      source.size > HEAD_BYTES
        ? new Uint8Array(await source.slice(Math.max(0, source.size - TAIL_BYTES)).arrayBuffer())
        : new Uint8Array()
    return [head, tail]
  }

  // A URL: ask for the two ends rather than the whole clip. The store answers
  // range requests, so this stays a couple of kilobytes on the wire.
  const head = await fetchWindow(source, 0, HEAD_BYTES)
  let size: number | null = null
  try {
    const probe = await fetch(source, { method: 'HEAD' })
    const length = probe.headers.get('Content-Length')
    if (length) size = Number(length)
  } catch {
    // No HEAD (or blocked): the head window alone is usually enough.
  }
  const tail = size !== null && size > HEAD_BYTES
    ? await fetchWindow(source, Math.max(0, size - TAIL_BYTES), TAIL_BYTES)
    : null
  return [head, tail].filter((w): w is Uint8Array => w !== null)
}

export async function probeVideoCodec(source: File | Blob | string): Promise<VideoCodec> {
  return codecFromWindows(await windowsOf(source))
}

export function codecLabel(codec: VideoCodec): string {
  switch (codec) {
    case 'avc1':
    case 'avc3':
      return 'H.264'
    case 'hvc1':
    case 'hev1':
      return 'HEVC（H.265）'
    case 'av01':
      return 'AV1'
    case 'vp09':
      return 'VP9'
    case 'vp08':
      return 'VP8'
    case 'mp4v':
      return 'MPEG-4 Part 2'
    default:
      return '未知'
  }
}

/** The MIME string to hand `canPlayType` for this codec. */
function mimeFor(codec: VideoCodec): string | null {
  switch (codec) {
    case 'avc1':
      return 'video/mp4; codecs="avc1.42E01E"'
    case 'avc3':
      return 'video/mp4; codecs="avc3.42E01E"'
    case 'hvc1':
      return 'video/mp4; codecs="hvc1.1.6.L93.B0"'
    case 'hev1':
      return 'video/mp4; codecs="hev1.1.6.L93.B0"'
    case 'av01':
      return 'video/mp4; codecs="av01.0.05M.08"'
    case 'vp09':
      return 'video/webm; codecs="vp9"'
    case 'vp08':
      return 'video/webm; codecs="vp8"'
    case 'mp4v':
      return 'video/mp4; codecs="mp4v.20.8"'
    default:
      return null
  }
}

/**
 * Whether this browser can decode the codec — asked of the browser itself, not
 * assumed. That way a machine with the Windows HEVC extension installed gets
 * the honest answer instead of a warning about a problem it does not have.
 */
export function codecPlaysHere(codec: VideoCodec): boolean {
  const mime = mimeFor(codec)
  if (!mime || typeof document === 'undefined') return true
  try {
    const probe = document.createElement('video')
    return probe.canPlayType(mime) !== ''
  } catch {
    return true
  }
}
