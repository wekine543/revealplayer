import { create } from 'zustand'
import type { MediaItem, MaskSettings, FavoriteItem } from '../types'
import { loadSettings, saveSettings } from '../lib/settings'

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
  volume: number
  isMuted: boolean
  playbackRate: number
  isLooping: boolean

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
  setVolume: (v: number) => void
  setMuted: (v: boolean) => void
  setPlaybackRate: (v: number) => void
  setLooping: (v: boolean) => void
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
  volume: persisted.volume,
  isMuted: persisted.isMuted,
  playbackRate: persisted.playbackRate,
  isLooping: persisted.isLooping,

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

  setVolume: (v) => {
    set({ volume: v })
    saveSettings({ volume: v })
  },

  setMuted: (v) => {
    set({ isMuted: v })
    saveSettings({ isMuted: v })
  },

  setPlaybackRate: (v) => {
    set({ playbackRate: v })
    saveSettings({ playbackRate: v })
  },

  setLooping: (v) => {
    set({ isLooping: v })
    saveSettings({ isLooping: v })
  },

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
