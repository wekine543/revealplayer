/**
 * Render quality tiers, exposed to the user.
 *
 * Two separate costs scale with resolution, and a tier has to bound both:
 *
 *   - the DRAWING BUFFER, which sets how many pixels the shader shades. Capped
 *     as width/height rather than a long edge, because "720p" has to keep
 *     meaning the same thing it did when the cap was hardcoded — a landscape
 *     frame of 1280x720.
 *   - the TEXTURE UPLOAD, which is what actually moves bytes every frame: a
 *     frame of the source resolution is uploaded to the GPU once per decoded
 *     frame, so a 4K clip is ~33 MB per frame. This is a long-edge cap, since a
 *     video frame is either landscape or portrait and the cap should follow it.
 *
 * `Infinity` means "no cap" — the tier that leaves the source alone.
 */

import { isMobileDevice } from './device'

export type QualityId = 'source' | '1080p' | '720p' | '480p'

export interface QualityLevel {
  id: QualityId
  label: string
  /** Drawing-buffer caps in CSS pixels. Infinity = uncapped. */
  bufferW: number
  bufferH: number
  /** Long-edge cap for the per-frame texture upload. Infinity = source size. */
  textureLongEdge: number
}

export const QUALITY_LEVELS: QualityLevel[] = [
  { id: 'source', label: '原画', bufferW: Infinity, bufferH: Infinity, textureLongEdge: Infinity },
  { id: '1080p', label: '1080P', bufferW: 1920, bufferH: 1080, textureLongEdge: 1920 },
  { id: '720p', label: '720P', bufferW: 1280, bufferH: 720, textureLongEdge: 1280 },
  { id: '480p', label: '480P', bufferW: 854, bufferH: 480, textureLongEdge: 854 },
]

export const DEFAULT_QUALITY_MOBILE: QualityId = '720p'
export const DEFAULT_QUALITY_DESKTOP: QualityId = 'source'

export function qualityById(id: QualityId): QualityLevel {
  return QUALITY_LEVELS.find((q) => q.id === id) ?? QUALITY_LEVELS[0]
}

/**
 * Phones and tablets get a lower default: they are the devices that actually
 * struggle, and 720p is what the hardcoded cap used to be.
 */
export function defaultQualityId(): QualityId {
  return isMobileDevice() ? DEFAULT_QUALITY_MOBILE : DEFAULT_QUALITY_DESKTOP
}
