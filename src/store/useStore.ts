import { create } from 'zustand'
import type { MediaItem, MaskSettings, FavoriteItem } from '../types'

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
}

const defaultMask: MaskSettings = {
  radius: 0.15,        // UV-space (0-1)
  feather: 0.02,       // UV-space
  borderEnabled: true,
  borderWidth: 0.003,  // UV-space
  borderColor: '#ffffff',
  borderOpacity: 0.8,
}

export const useStore = create<AppState>((set) => ({
  mediaA: null,
  mediaB: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  isMuted: true,
  playbackRate: 1,
  isLooping: false,

  maskSettings: { ...defaultMask },

  mouseActive: false,
  mousePos: { x: 0.5, y: 0.5 },

  favorites: [],

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
  setVolume: (v) => set({ volume: v }),
  setMuted: (v) => set({ isMuted: v }),
  setPlaybackRate: (v) => set({ playbackRate: v }),
  setLooping: (v) => set({ isLooping: v }),

  setMaskSettings: (partial) =>
    set((state) => ({
      maskSettings: { ...state.maskSettings, ...partial },
    })),

  setMouseActive: (v) => set({ mouseActive: v }),
  setMousePos: (pos) => set({ mousePos: pos }),

  setFavorites: (favs) => set({ favorites: favs }),
}))
