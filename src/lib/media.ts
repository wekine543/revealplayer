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

/**
 * Create an HTMLVideoElement (hidden) for a given URL.
 */
export function createVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'

    video.addEventListener('loadedmetadata', () => {
      resolve(video)
    })
    video.addEventListener('error', () => {
      reject(new Error(`Failed to load video: ${url}`))
    })

    video.src = url
  })
}

/**
 * Create an HTMLImageElement for a given URL.
 */
export function createImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.addEventListener('load', () => resolve(img))
    img.addEventListener('error', () => {
      reject(new Error(`Failed to load image: ${url}`))
    })

    img.src = url
  })
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
  // Guess type from URL extension
  let type = getMediaType(url.split('?')[0])
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
