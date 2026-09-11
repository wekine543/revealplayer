/**
 * Persistence layer — saves user preferences to localStorage and restores
 * them on the next session.
 *
 * Persisted fields: maskSettings, isLooping, volume, isMuted, playbackRate,
 * sidebarCollapsed, maskCollapsed, favoritesCollapsed.
 */
import type { MaskSettings } from '../types'

const STORAGE_KEY = 'revealplayer_settings'

export interface PersistedSettings {
  maskSettings: MaskSettings
  isLooping: boolean
  volume: number
  isMuted: boolean
  playbackRate: number
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
  volume: 1,
  isMuted: true,
  playbackRate: 1,
  sidebarCollapsed: false,
  maskCollapsed: false,
  favoritesCollapsed: false,
}

export function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>
    // Deep-merge maskSettings so new fields added in updates get defaults
    return {
      ...defaults,
      ...parsed,
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
