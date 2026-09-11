import { useState } from 'react'
import { useStore } from '../store/useStore'
import { saveFavorite, getFavorites } from '../lib/db'
import type { FavoriteItem, MediaRef } from '../types'

export function FavoriteButton() {
  const [showInput, setShowInput] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const mediaA = useStore((s) => s.mediaA)
  const mediaB = useStore((s) => s.mediaB)
  const maskSettings = useStore((s) => s.maskSettings)
  const setFavorites = useStore((s) => s.setFavorites)

  const canSave = mediaA !== null || mediaB !== null

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      const toRef = (m: typeof mediaA): MediaRef | null => {
        if (!m) return null
        return {
          type: m.type,
          source: m.source,
          url: m.source === 'url' ? m.url : undefined,
          blobId: m.blobId,
          fileName: m.fileName,
        }
      }

      const item: FavoriteItem = {
        id: `fav_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: name.trim() || `Combo ${new Date().toLocaleString()}`,
        createdAt: Date.now(),
        mediaA: toRef(mediaA),
        mediaB: toRef(mediaB),
        maskSettings: { ...maskSettings },
      }

      await saveFavorite(item)
      const favs = await getFavorites()
      setFavorites(favs)
      setShowInput(false)
      setName('')
    } catch (e) {
      console.error('Failed to save favorite:', e)
    } finally {
      setSaving(false)
    }
  }

  const handleShowInput = () => {
    // Default name to media A's filename (without extension)
    const defaultName = mediaA?.fileName
      ? mediaA.fileName.replace(/\.[^.]+$/, '')
      : `Combo ${new Date().toLocaleString()}`
    setName(defaultName)
    setShowInput(true)
  }

  if (!showInput) {
    return (
      <button
        onClick={handleShowInput}
        disabled={!canSave}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-brand-500/20 hover:bg-brand-500/30 text-brand-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
        </svg>
        Save Combo
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave()
          if (e.key === 'Escape') { setShowInput(false); setName('') }
        }}
        placeholder="Name this combo..."
        className="text-xs px-2 py-1.5 rounded-md bg-black/30 border border-white/10 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-brand-400 w-44"
        autoFocus
      />
      <button
        onClick={handleSave}
        disabled={saving}
        className="text-xs px-2 py-1.5 rounded-md bg-brand-500 hover:bg-brand-600 text-white disabled:opacity-50 transition-colors"
      >
        {saving ? '...' : 'Save'}
      </button>
      <button
        onClick={() => { setShowInput(false); setName('') }}
        className="text-xs px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-400 transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}
