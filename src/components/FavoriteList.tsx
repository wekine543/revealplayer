import { useEffect, useState, useMemo } from 'react'
import { useStore } from '../store/useStore'
import {
  listFavorites,
  loadFavoriteMedia,
  removeFavorite,
  renameFavoriteEntry,
  favoritesSource,
  comboOffset,
} from '../lib/favorites'
import { formatOffset } from '../lib/timeOffset'
import { ConfigDirBar } from './ConfigDirBar'
import { ComboThumb } from './ComboThumb'
import type { FavoriteItem } from '../types'

export function FavoriteList() {
  const favorites = useStore((s) => s.favorites)
  const setFavorites = useStore((s) => s.setFavorites)
  const setMediaA = useStore((s) => s.setMediaA)
  const setMediaB = useStore((s) => s.setMediaB)
  const loadComboSettings = useStore((s) => s.loadComboSettings)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [search, setSearch] = useState('')
  const [loadingId, setLoadingId] = useState<string | null>(null)
  // Surfaced in the panel rather than only in the console: on a phone there is
  // no devtools to open, and a silent failure just looks like a dead button.
  const [loadError, setLoadError] = useState<string | null>(null)

  // Load favorites on mount, and again whenever the backing store changes
  // (config folder connected, swapped or disconnected).
  const reload = () => {
    listFavorites().then(setFavorites).catch(console.error)
  }
  useEffect(() => {
    reload()
  }, [setFavorites])

  // Filter favorites by search
  const filtered = useMemo(() => {
    if (!search.trim()) return favorites
    const q = search.toLowerCase()
    return favorites.filter((f) => f.name.toLowerCase().includes(q))
  }, [favorites, search])

  const loadFavorite = async (fav: FavoriteItem) => {
    setLoadError(null)
    setLoadingId(fav.id)
    try {
      const mediaA = await loadFavoriteMedia(fav.mediaA)
      const mediaB = await loadFavoriteMedia(fav.mediaB)

      if (!mediaA && !mediaB) {
        setLoadError(
          `「${fav.name}」的媒体文件都取不到。服务端存储需要在电脑上运行 RevealPlayer-LAN.bat，且手机要连同一个 Wi-Fi。`,
        )
      }
      setMediaA(mediaA)
      setMediaB(mediaB)
      // Both the mask and the A→B skew travel with the combo. Called after the
      // media setters on purpose: those clear `activeFavoriteId` by design,
      // because media dropped into A/B is nobody's combo until this says whose.
      loadComboSettings(fav)
    } catch (e) {
      console.error('Failed to load favorite:', e)
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingId(null)
    }
  }

  const handleDelete = async (id: string) => {
    setFavorites(await removeFavorite(id))
  }

  const handleRename = async (id: string) => {
    if (!editName.trim()) {
      setEditingId(null)
      return
    }
    setFavorites(await renameFavoriteEntry(id, editName.trim()))
    setEditingId(null)
    setEditName('')
  }

  if (favorites.length === 0) {
    return (
      <div className="space-y-2">
        <ConfigDirBar onChanged={reload} />
        <p className="text-xs text-gray-600 py-4 text-center">
          {favoritesSource() === 'browser'
            ? 'No saved combos yet. Load media and save a combination to see it here.'
            : '这里还没有组合。加载媒体后点 Save Combo 保存。'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <ConfigDirBar onChanged={reload} />

      {/* Search box */}
      <div className="relative mb-2">
        <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search combos..."
          className="w-full text-xs pl-7 pr-2 py-1.5 rounded-md bg-black/30 border border-white/10 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-brand-400"
        />
      </div>

      {/* Card grid — the picture is its own block, the name sits below it.
          The wrapper establishes the container query: the grid inside is not
          allowed to query itself, so the rules live on the parent. */}
      <div className="rp-combos-container">
      {/* Height: capped in the stacked layouts, where the list is one more block
          in a scrolling page; unbounded in the three-column layout, where the
          panel body above it is the scroller. */}
      <div className="rp-combo-grid max-h-[340px] lg:landscape:max-h-none min-h-[140px] overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-600 py-2 text-center">No matches found.</p>
        ) : (
          filtered.map((fav) => (
            <div key={fav.id} className="rp-combo-card group">
              {/* Loading the combo: picture first, name underneath. */}
              <button
                onClick={() => loadFavorite(fav)}
                className="w-full text-left"
                title={`${fav.name}\nA · ${fav.mediaA?.fileName ?? '无'}`}
              >
                <div className="relative">
                  <ComboThumb media={fav.mediaA} />
                  {/* The skew travels with the combo, so mark the ones that
                      carry one — an unmarked card is level, not missing it. */}
                  {comboOffset(fav) !== 0 && (
                    <span className="absolute left-1 top-1 rounded bg-black/70 px-1 py-px text-[9px] font-mono text-brand-300">
                      B {formatOffset(comboOffset(fav))}
                    </span>
                  )}
                  {loadingId === fav.id && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-[10px] text-gray-200">
                      加载中…
                    </span>
                  )}
                </div>

                <div className="mt-1.5">
                  <p className="rp-clamp-2 text-[11px] leading-snug text-gray-300 group-hover:text-white break-words">
                    {fav.name}
                  </p>
                </div>
              </button>

              {/* Actions — an overlay rather than a column of icons: always
                  visible on touch, hover-revealed from `lg` up. */}
              {editingId === fav.id ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(fav.id)
                    if (e.key === 'Escape') { setEditingId(null); setEditName('') }
                  }}
                  className="mt-1.5 w-full text-[11px] px-1.5 py-1 rounded bg-black/40 border border-brand-400 text-gray-200 focus:outline-none"
                  autoFocus
                />
              ) : (
                <div className="absolute right-1 top-1 flex flex-col gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => { setEditingId(fav.id); setEditName(fav.name) }}
                    className="p-1 rounded bg-black/70 text-gray-300 hover:text-blue-300"
                    title="Rename"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(fav.id)}
                    className="p-1 rounded bg-black/70 text-gray-300 hover:text-red-400"
                    title="Delete"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      </div>

      {loadError && (
        <p className="text-[11px] text-red-400 leading-relaxed bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1.5 break-words">
          {loadError}
        </p>
      )}

      {/* Count */}
      <p className="text-xs text-gray-600 text-right">
        {filtered.length === favorites.length
          ? `${favorites.length} combo${favorites.length !== 1 ? 's' : ''}`
          : `${filtered.length} / ${favorites.length}`}
      </p>
    </div>
  )
}
