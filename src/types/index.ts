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
  /**
   * Path relative to the config folder, e.g. `media/clip.mp4`. Set when the
   * file lives in (or has been copied into) the config folder, which is what
   * makes a combo portable: the JSON plus this folder is the whole combo.
   */
  configPath?: string
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
  /** See MediaItem.configPath — relative path inside the config folder. */
  configPath?: string
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
  /**
   * Intentional A→B time offset, in seconds. Positive = B is ahead of A ("B is
   * faster"). Optional so combos saved before this existed still load — no
   * field reads as level.
   */
  bOffset?: number
}

/**
 * `revealplayer.config.json` — the file that travels with the media.
 *
 * combos is a FavoriteItem list on purpose: saving a combo and storing a combo
 * are the same shape, so nothing has to be translated on the way in or out.
 */
export interface ConfigFile {
  version: number
  updatedAt: number
  /** Last mask settings used. Null until the user changes them once. */
  maskSettings: MaskSettings | null
  combos: FavoriteItem[]
}
