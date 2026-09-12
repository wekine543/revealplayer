/**
 * Persistence layer — saves user preferences to localStorage and restores
 * them on the next session.
 *
 * Persisted fields: maskSettings, isLooping, volumeA/volumeB, mutedA/mutedB,
 * playbackRate, quality, sidebarCollapsed, maskCollapsed, favoritesCollapsed.
 */
import type { MaskSettings, ViewMode } from '../types'
import { defaultQualityId, type QualityId } from './quality'

const STORAGE_KEY = 'revealplayer_settings'

export interface PersistedSettings {
  maskSettings: MaskSettings
  isLooping: boolean
  /** Volume is per slot — the two sources often need different levels. */
  volumeA: number
  volumeB: number
  mutedA: boolean
  mutedB: boolean
  /** Legacy single-track values, kept only to migrate settings saved by an
   *  older build. Never read by the app. */
  volume?: number
  isMuted?: boolean
  playbackRate: number
  /** Render quality tier — user-selectable, restored on the next visit. */
  quality: QualityId
  /** Mask (B revealed through A) or grid (both shown whole). */
  viewMode: ViewMode
  sidebarCollapsed: boolean
  maskCollapsed: boolean
  favoritesCollapsed: boolean
}

const defaults: PersistedSettings = {
  maskSettings: {
    radius: 0.15,
    feather: 0.02,
    borderEnabled: true,
    borderWidth: 0.003,
    borderColor: '#ffffff',
    borderOpacity: 0.8,
  },
  isLooping: false,
  volumeA: 1,
  volumeB: 1,
  mutedA: true,
  mutedB: true,
  playbackRate: 1,
  // Placeholder: the real default depends on the device, so loadSettings()
  // resolves it rather than baking one in here.
  quality: 'source',
  // The reveal mask is what the app is named for, so it stays the default.
  viewMode: 'mask',
  sidebarCollapsed: false,
  maskCollapsed: false,
  favoritesCollapsed: false,
}

/** True on phone/tablet-sized viewports */
function isMobileViewport(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(max-width: 1023px)').matches
}

export function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      // First run — collapse the side panel by default on small screens
      // so the canvas gets maximum room.
      return { ...defaults, quality: defaultQualityId(), sidebarCollapsed: isMobileViewport() }
    }
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>
    // Deep-merge maskSettings so new fields added in updates get defaults
    return {
      ...defaults,
      ...parsed,
      // A settings file written before this field existed has no quality, and
      // an unknown id must not leave the engine on a tier that does not exist.
      quality: parsed.quality ?? defaultQualityId(),
      // An unknown value must not leave the app in a mode it cannot render.
      viewMode: parsed.viewMode === 'grid' ? 'grid' : 'mask',
      // Someone upgrading from the single-track build had one volume and one
      // mute flag; use them for both slots rather than resetting to defaults.
      volumeA: parsed.volumeA ?? parsed.volume ?? defaults.volumeA,
      volumeB: parsed.volumeB ?? parsed.volume ?? defaults.volumeB,
      mutedA: parsed.mutedA ?? parsed.isMuted ?? defaults.mutedA,
      mutedB: parsed.mutedB ?? parsed.isMuted ?? defaults.mutedB,
      maskSettings: { ...defaults.maskSettings, ...(parsed.maskSettings ?? {}) },
    }
  } catch {
    return defaults
  }
}

export function saveSettings(settings: Partial<PersistedSettings>): void {
  try {
    const current = loadSettings()
    const merged = { ...current, ...settings }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {
    // localStorage might be unavailable (private mode, etc.) — silently ignore
  }
}
