export type MediaType = 'video' | 'image'
export type MediaSource = 'url' | 'local'

/**
 * How the two media are shown.
 * - `mask`: B is revealed through A inside a circular mask (the original mode).
 * - `grid`: both are shown whole, in two cells.
 */
export type ViewMode = 'mask' | 'grid'

export interface MediaItem {
  type: MediaType
  source: MediaSource
  url: string          // object URL or remote URL
  blobId?: string      // IndexedDB blob ID for local files
  fileName?: string
  width: number
  height: number
  duration?: number     // for video
}

export interface MediaRef {
  type: MediaType
  source: MediaSource
  url?: string
  blobId?: string
  fileName?: string
}

export interface MaskSettings {
  radius: number
  feather: number
  borderEnabled: boolean
  borderWidth: number
  borderColor: string
  borderOpacity: number
}

export interface FavoriteItem {
  id: string
  name: string
  createdAt: number
  mediaA: MediaRef | null
  mediaB: MediaRef | null
  maskSettings: MaskSettings
}
