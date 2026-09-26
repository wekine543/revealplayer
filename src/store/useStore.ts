import { create } from 'zustand'
import type { MediaItem, MaskSettings, FavoriteItem, ViewMode } from '../types'
import { loadSettings, saveSettings, clampRailWidth } from '../lib/settings'
import { scheduleMaskSync, type ConfigStatus } from '../lib/configDir'
import { scheduleMaskSync as scheduleServerMaskSync } from '../lib/serverStore'
import { clampOffset } from '../lib/timeOffset'
import { comboOffset, updateFavorite } from '../lib/favorites'
import type { QualityId } from '../lib/quality'

// Load persisted settings once at module level (before store creation)
const persisted = loadSettings()

/**
 * Combos are written back with a delay so dragging the offset slider does not
 * rewrite the combo file on every hundredth of a second.
 */
const COMBO_WRITE_DELAY = 600
let comboTimer: ReturnType<typeof setTimeout> | null = null
let comboTarget: { id: string; patch: Partial<FavoriteItem> } | null = null

function flushComboWrite(apply: (list: FavoriteItem[]) => void) {
  if (!comboTarget) return
  const { id, patch } = comboTarget
  comboTarget = null
  void updateFavorite(id, patch)
    .then((list) => {
      // The combo may have been switched (or deleted) while this was pending.
      if (useStore.getState().activeFavoriteId === id) apply(list)
    })
    .catch((e: unknown) => {
      console.warn('[RevealPlayer] could not write combo update:', e)
    })
}

/** Queue a debounced field patch on the combo currently loaded. */
function scheduleComboWrite(id: string, patch: Partial<FavoriteItem>) {
  comboTarget = { id, patch: { ...(comboTarget?.id === id ? comboTarget.patch : {}), ...patch } }
  if (comboTimer) clearTimeout(comboTimer)
  comboTimer = setTimeout(() => {
    comboTimer = null
    flushComboWrite((list) => useStore.setState({ favorites: list }))
  }, COMBO_WRITE_DELAY)
}

interface AppState {
  // Media
  mediaA: MediaItem | null
  mediaB: MediaItem | null

  // Playback
  isPlaying: boolean
  currentTime: number
  duration: number
  /** Per-slot volume — A and B can be balanced independently. */
  volumeA: number
  volumeB: number
  mutedA: boolean
  mutedB: boolean
  playbackRate: number
  isLooping: boolean
  /**
   * Intentional A→B skew in seconds — positive means B runs ahead of A.
   * Persisted, because deciding it takes a good look and it usually applies to
   * the whole pair rather than to one sitting.
   */
  bOffset: number

  /** Render quality tier (原画 / 1080P / 720P / 480P) */
  quality: QualityId
  /**
   * `mask` reveals B through A; `grid` shows both whole. Persisted — it is a
   * viewing preference, and someone comparing two clips will want to stay in
   * grid mode across sessions.
   */
  viewMode: ViewMode
  /**
   * Bilibili-style web fullscreen: a CSS layout mode that hides everything but
   * the canvas, transport and an exit button. Deliberately NOT persisted — it is
   * a transient view state, not a preference.
   */
  isWebFullscreen: boolean

  // Mask
  maskSettings: MaskSettings

  // Mouse
  mouseActive: boolean
  mousePos: { x: number; y: number }

  // Favorites
  favorites: FavoriteItem[]
  /**
   * The combo currently loaded into A/B, when there is one. Loading new media
   * (or swapping) clears it — the pair on screen is then nobody's combo, and a
   * write-back would attach the skew to whichever entry was loaded last.
   */
  activeFavoriteId: string | null

  // Config folder
  /**
   * Whether combos come from a real folder on disk. `loading` until the
   * start-up check finishes.
   */
  configStatus: ConfigStatus
  /** Folder name, for display — the handle itself stays in IndexedDB. */
  configDirName: string | null
  /** Why the last connect attempt failed, if it did. */
  configError: string | null
  /** True while a picker / permission round-trip is in flight. */
  configBusy: boolean

  // UI state
  sidebarCollapsed: boolean
  maskCollapsed: boolean
  favoritesCollapsed: boolean
  syncCollapsed: boolean
  /** Width of the Saved Combos rail on desktop, in px. Dragged by the user. */
  combosWidth: number

  // Actions
  setMediaA: (m: MediaItem | null) => void
  setMediaB: (m: MediaItem | null) => void
  swapMedia: () => void
  setIsPlaying: (v: boolean) => void
  setCurrentTime: (v: number) => void
  setDuration: (v: number) => void
  setVolumeA: (v: number) => void
  setVolumeB: (v: number) => void
  setMutedA: (v: boolean) => void
  setMutedB: (v: boolean) => void
  setPlaybackRate: (v: number) => void
  setLooping: (v: boolean) => void
  setBOffset: (v: number) => void
  setQuality: (v: QualityId) => void
  setViewMode: (v: ViewMode) => void
  setWebFullscreen: (v: boolean) => void
  setMaskSettings: (partial: Partial<MaskSettings>) => void
  setMouseActive: (v: boolean) => void
  setMousePos: (pos: { x: number; y: number }) => void
  setFavorites: (favs: FavoriteItem[]) => void
  setActiveFavorite: (id: string | null) => void
  loadComboSettings: (fav: FavoriteItem) => void
  setConfigStatus: (s: ConfigStatus, dirName?: string | null, error?: string | null) => void
  setConfigBusy: (v: boolean) => void
  setSidebarCollapsed: (v: boolean) => void
  setMaskCollapsed: (v: boolean) => void
  setFavoritesCollapsed: (v: boolean) => void
  setSyncCollapsed: (v: boolean) => void
  setCombosWidth: (v: number, persist?: boolean) => void
}

export const useStore = create<AppState>((set) => ({
  mediaA: null,
  mediaB: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  // Restore from persisted settings
  volumeA: persisted.volumeA,
  volumeB: persisted.volumeB,
  mutedA: persisted.mutedA,
  mutedB: persisted.mutedB,
  playbackRate: persisted.playbackRate,
  isLooping: persisted.isLooping,
  bOffset: persisted.bOffset,
  quality: persisted.quality,
  viewMode: persisted.viewMode,
  isWebFullscreen: false,

  maskSettings: { ...persisted.maskSettings },

  mouseActive: false,
  mousePos: { x: 0.5, y: 0.5 },

  favorites: [],

  activeFavoriteId: null,

  configStatus: 'loading',
  configDirName: null,
  configError: null,
  configBusy: false,

  // UI state from persistence
  sidebarCollapsed: persisted.sidebarCollapsed,
  maskCollapsed: persisted.maskCollapsed,
  favoritesCollapsed: persisted.favoritesCollapsed,
  syncCollapsed: persisted.syncCollapsed,
  combosWidth: persisted.combosWidth,

  // Any deliberate change of what A/B hold ends the association with the combo
  // they came from.
  setMediaA: (m) => set({ mediaA: m, activeFavoriteId: null }),
  setMediaB: (m) => set({ mediaB: m, activeFavoriteId: null }),

  swapMedia: () =>
    set((state) => ({
      mediaA: state.mediaB,
      mediaB: state.mediaA,
      activeFavoriteId: null,
    })),

  setIsPlaying: (v) => set({ isPlaying: v }),
  setCurrentTime: (v) => set({ currentTime: v }),
  setDuration: (v) => set({ duration: v }),

  setVolumeA: (v) => {
    set({ volumeA: v })
    saveSettings({ volumeA: v })
  },

  setVolumeB: (v) => {
    set({ volumeB: v })
    saveSettings({ volumeB: v })
  },

  setMutedA: (v) => {
    set({ mutedA: v })
    saveSettings({ mutedA: v })
  },

  setMutedB: (v) => {
    set({ mutedB: v })
    saveSettings({ mutedB: v })
  },

  setPlaybackRate: (v) => {
    set({ playbackRate: v })
    saveSettings({ playbackRate: v })
  },

  setLooping: (v) => {
    set({ isLooping: v })
    saveSettings({ isLooping: v })
  },

  /**
   * Move the A→B skew. The engine applies it (see CanvasView, which mirrors
   * it exactly like volume does) and, when a combo is loaded, it is written
   * straight back — there is no separate save step, so tuning the value and
   * keeping it are the same action.
   */
  setBOffset: (v) => {
    const value = clampOffset(v)
    set({ bOffset: value })
    saveSettings({ bOffset: value })
    const active = useStore.getState().activeFavoriteId
    if (active) scheduleComboWrite(active, { bOffset: value })
  },

  setQuality: (v) => {
    set({ quality: v })
    saveSettings({ quality: v })
  },

  setViewMode: (v) => {
    set({ viewMode: v })
    saveSettings({ viewMode: v })
  },

  setWebFullscreen: (v) => set({ isWebFullscreen: v }),

  setMaskSettings: (partial) =>
    set((state) => {
      const newMask = { ...state.maskSettings, ...partial }
      saveSettings({ maskSettings: newMask })
      // Mirror into the active external store, so a config folder (or the
      // server-side store) is a complete snapshot of how the player was left.
      // Both are debounced, and each no-ops when it is not the active backend.
      scheduleMaskSync(newMask)
      scheduleServerMaskSync(newMask)
      return { maskSettings: newMask }
    }),

  setMouseActive: (v) => set({ mouseActive: v }),
  setMousePos: (pos) => set({ mousePos: pos }),

  setFavorites: (favs) => set({ favorites: favs }),

  setActiveFavorite: (id) => set({ activeFavoriteId: id }),

  /**
   * Restore everything a combo carries: its mask, and the skew that was tuned
   * for that particular pair. Older combos have no `bOffset`, which reads as
   * level.
   */
  loadComboSettings: (fav) => {
    // Mask goes through its own setter so it is persisted and mirrored to the
    // active store exactly as a manual edit would be.
    useStore.getState().setMaskSettings(fav.maskSettings)
    const value = clampOffset(comboOffset(fav))
    saveSettings({ bOffset: value })
    set({ bOffset: value, activeFavoriteId: fav.id })
  },

  setConfigStatus: (s, dirName = null, error = null) =>
    set({ configStatus: s, configDirName: dirName, configError: error }),

  setConfigBusy: (v) => set({ configBusy: v }),

  setSidebarCollapsed: (v) => {
    set({ sidebarCollapsed: v })
    saveSettings({ sidebarCollapsed: v })
  },

  setMaskCollapsed: (v) => {
    set({ maskCollapsed: v })
    saveSettings({ maskCollapsed: v })
  },

  setFavoritesCollapsed: (v) => {
    set({ favoritesCollapsed: v })
    saveSettings({ favoritesCollapsed: v })
  },

  setSyncCollapsed: (v) => {
    set({ syncCollapsed: v })
    saveSettings({ syncCollapsed: v })
  },

  /**
   * Resize the Saved Combos rail. `persist` is false while a drag is in
   * progress — writing to storage on every pointer move would be dozens of
   * writes for one gesture — and true when the gesture ends.
   */
  setCombosWidth: (v, persist = false) => {
    const next = clampRailWidth(v)
    if (useStore.getState().combosWidth === next && persist === false) return
    set({ combosWidth: next })
    if (persist) saveSettings({ combosWidth: next })
  },
}))
