import { useEffect, useState, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { getFavorites, deleteFavorite, renameFavorite, getBlob } from '../lib/db'
import { loadUrlMedia, loadLocalFile } from '../lib/media'
import type { FavoriteItem, MediaItem, MediaRef } from '../types'

export function FavoriteList() {
  const favorites = useStore((s) => s.favorites)
  const setFavorites = useStore((s) => s.setFavorites)
  const setMediaA = useStore((s) => s.setMediaA)
  const setMediaB = useStore((s) => s.setMediaB)
  const setMaskSettings = useStore((s) => s.setMaskSettings)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [search, setSearch] = useState('')

  // Load favorites on mount
  useEffect(() => {
    getFavorites().then(setFavorites).catch(console.error)
  }, [setFavorites])

  // Filter favorites by search
  const filtered = useMemo(() => {
    if (!search.trim()) return favorites
    const q = search.toLowerCase()
    return favorites.filter((f) => f.name.toLowerCase().includes(q))
  }, [favorites, search])

  const loadFavorite = async (fav: FavoriteItem) => {
    try {
      const loadMediaRef = async (ref: MediaRef | null): Promise<MediaItem | null> => {
        if (!ref) return null

        if (ref.source === 'url' && ref.url) {
          return await loadUrlMedia(ref.url)
        }

        if (ref.source === 'local' && ref.blobId) {
          const blob = await getBlob(ref.blobId)
          if (!blob) {
            console.warn(`Blob not found for ID: ${ref.blobId}`)
            return null
          }
          const file = new File([blob], ref.fileName ?? 'unknown', { type: blob.type })
          return await loadLocalFile(file)
        }

        return null
      }

      const mediaA = await loadMediaRef(fav.mediaA)
      const mediaB = await loadMediaRef(fav.mediaB)

      setMediaA(mediaA)
      setMediaB(mediaB)
      setMaskSettings(fav.maskSettings)
    } catch (e) {
      console.error('Failed to load favorite:', e)
    }
  }

  const handleDelete = async (id: string) => {
    await deleteFavorite(id)
    const favs = await getFavorites()
    setFavorites(favs)
  }

  const handleRename = async (id: string) => {
    if (!editName.trim()) {
      setEditingId(null)
      return
    }
    await renameFavorite(id, editName.trim())
    const favs = await getFavorites()
    setFavorites(favs)
    setEditingId(null)
    setEditName('')
  }

  if (favorites.length === 0) {
    return (
      <p className="text-xs text-gray-600 py-4 text-center">
        No saved combos yet. Load media and save a combination to see it here.
      </p>
    )
  }

  return (
    <div className="space-y-2">
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

      {/* List */}
      <div className="space-y-1.5 max-h-64 overflow-y-auto rp-scrollbar">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-600 py-2 text-center">No matches found.</p>
        ) : (
          filtered.map((fav) => (
            <div
              key={fav.id}
              className="flex items-center gap-2 p-2 rounded-md bg-white/5 hover:bg-white/10 transition-colors group"
            >
              {/* Thumbnail or icon */}
              <div className="flex-shrink-0 w-8 h-8 rounded-md bg-black/30 flex items-center justify-center overflow-hidden">
                {fav.mediaA ? (
                  <span className="text-xs font-bold text-brand-400">{fav.mediaA.type === 'video' ? 'V' : 'I'}</span>
                ) : (
                  <span className="text-xs text-gray-600">-</span>
                )}
              </div>

              {/* Name */}
              {editingId === fav.id ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(fav.id)
                    if (e.key === 'Escape') { setEditingId(null); setEditName('') }
                  }}
                  className="flex-1 text-xs px-1.5 py-1 rounded bg-black/30 border border-brand-400 text-gray-200 focus:outline-none"
                  autoFocus
                />
              ) : (
                <button
                  onClick={() => loadFavorite(fav)}
                  className="flex-1 text-left text-xs text-gray-300 hover:text-white truncate"
                  title={fav.name}
                >
                  {fav.name}
                </button>
              )}

              {/* Actions — always visible on touch devices, hover-reveal on desktop */}
              <div className="flex items-center gap-0.5 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => { setEditingId(fav.id); setEditName(fav.name) }}
                  className="text-gray-500 hover:text-blue-400 p-2 lg:p-1"
                  title="Rename"
                >
                  <svg className="w-4 h-4 lg:w-3 lg:h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleDelete(fav.id)}
                  className="text-gray-500 hover:text-red-400 p-2 lg:p-1"
                  title="Delete"
                >
                  <svg className="w-4 h-4 lg:w-3 lg:h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Count */}
      <p className="text-xs text-gray-600 text-right">
        {filtered.length === favorites.length
          ? `${favorites.length} combo${favorites.length !== 1 ? 's' : ''}`
          : `${filtered.length} / ${favorites.length}`}
      </p>
    </div>
  )
}
