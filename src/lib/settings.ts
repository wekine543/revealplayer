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

/**
 * Bounds for the Saved Combos rail. The lower bound keeps the combo rows usable
 * (thumbnail plus a readable name); the upper keeps the player from being
 * squeezed into a letterbox on a laptop screen.
 */
export const RAIL_MIN_WIDTH = 220
/** Wide enough for the card grid to reach four columns. */
export const RAIL_MAX_WIDTH = 720
/** Matches the panel's original `lg:w-72`. */
export const DEFAULT_RAIL_WIDTH = 288

export function clampRailWidth(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_RAIL_WIDTH
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(v)))
}

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
  /**
   * Intentional A→B time offset in seconds — see lib/timeOffset.ts. Positive
   * means B runs ahead of A. Restored like any other viewing preference, and
   * overwritten whenever a combo carrying its own value is loaded.
   */
  bOffset: number
  sidebarCollapsed: boolean
  maskCollapsed: boolean
  favoritesCollapsed: boolean
  syncCollapsed: boolean
  /**
   * Width of the Saved Combos rail on desktop, in px. User-settable by dragging
   * the divider beside it, so it is persisted here rather than hardcoded; see
   * RAIL_MIN_WIDTH / RAIL_MAX_WIDTH for the bounds.
   */
  combosWidth: number
  /**
   * Set when the user turns down the config-folder prompt, so the app stops
   * asking on every launch. Combos then stay in IndexedDB until they pick a
   * folder from the sidebar.
   */
  configSkipped: boolean
  /**
   * Absolute path of the connected config folder, used to open it in the OS
   * file manager. The browser can only ever see the folder's *name*, so this is
   * resolved once (server-side search or manual pick) and then remembered.
   * Cleared whenever the folder is disconnected.
   */
  configDirPath: string | null
  /**
   * Keep combos on the machine running the dev server instead of in a
   * browser-side folder. Off by default so nobody's existing config folder is
   * silently bypassed; the sidebar offers it whenever a server is reachable.
   * This is the only backend that works on a phone.
   */
  useServerStore: boolean
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
  // No skew until the user asks for one.
  bOffset: 0,
  sidebarCollapsed: false,
  maskCollapsed: false,
  favoritesCollapsed: false,
  syncCollapsed: false,
  configSkipped: false,
  configDirPath: null,
  useServerStore: false,
  combosWidth: DEFAULT_RAIL_WIDTH,
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
      // Guard against a hand-edited or half-written value: the sync math would
      // otherwise be asked for a skew it refuses to apply.
      bOffset: typeof parsed.bOffset === 'number' && isFinite(parsed.bOffset) ? parsed.bOffset : 0,
      syncCollapsed: parsed.syncCollapsed ?? false,
      // A width from a narrower window (or a hand-edited value) must not leave
      // the rail unusable, so it goes through the same clamp as a drag.
      combosWidth: clampRailWidth(parsed.combosWidth ?? DEFAULT_RAIL_WIDTH),
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
