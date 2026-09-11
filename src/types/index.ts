export type MediaType = 'video' | 'image'
export type MediaSource = 'url' | 'local'

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
