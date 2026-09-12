import { create } from 'zustand'
import type { MediaItem, MaskSettings, FavoriteItem, ViewMode } from '../types'
import { loadSettings, saveSettings } from '../lib/settings'
import type { QualityId } from '../lib/quality'

// Load persisted settings once at module level (before store creation)
const persisted = loadSettings()

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

  // UI state
  sidebarCollapsed: boolean
  maskCollapsed: boolean
  favoritesCollapsed: boolean

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
  setQuality: (v: QualityId) => void
  setViewMode: (v: ViewMode) => void
  setWebFullscreen: (v: boolean) => void
  setMaskSettings: (partial: Partial<MaskSettings>) => void
  setMouseActive: (v: boolean) => void
  setMousePos: (pos: { x: number; y: number }) => void
  setFavorites: (favs: FavoriteItem[]) => void
  setSidebarCollapsed: (v: boolean) => void
  setMaskCollapsed: (v: boolean) => void
  setFavoritesCollapsed: (v: boolean) => void
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
  quality: persisted.quality,
  viewMode: persisted.viewMode,
  isWebFullscreen: false,

  maskSettings: { ...persisted.maskSettings },

  mouseActive: false,
  mousePos: { x: 0.5, y: 0.5 },

  favorites: [],

  // UI state from persistence
  sidebarCollapsed: persisted.sidebarCollapsed,
  maskCollapsed: persisted.maskCollapsed,
  favoritesCollapsed: persisted.favoritesCollapsed,

  setMediaA: (m) => set({ mediaA: m }),
  setMediaB: (m) => set({ mediaB: m }),

  swapMedia: () =>
    set((state) => ({
      mediaA: state.mediaB,
      mediaB: state.mediaA,
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
      return { maskSettings: newMask }
    }),

  setMouseActive: (v) => set({ mouseActive: v }),
  setMousePos: (pos) => set({ mousePos: pos }),

  setFavorites: (favs) => set({ favorites: favs }),

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
}))
