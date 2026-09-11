import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { saveFavorite, getFavorites } from '../lib/db'
import type { FavoriteItem, MediaRef } from '../types'

export function FavoriteButton() {
  const [showInput, setShowInput] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const mediaA = useStore((s) => s.mediaA)
  const mediaB = useStore((s) => s.mediaB)
  const maskSettings = useStore((s) => s.maskSettings)
  const setFavorites = useStore((s) => s.setFavorites)

  const canSave = mediaA !== null || mediaB !== null

  // Close the popup when tapping/clicking outside of it
  useEffect(() => {
    if (!showInput) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowInput(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [showInput])

  const handleShowInput = () => {
    // Default name to media A's filename (without extension)
    const defaultName = mediaA?.fileName
      ? mediaA.fileName.replace(/\.[^.]+$/, '')
      : `Combo ${new Date().toLocaleString()}`
    setName(defaultName)
    setShowInput(true)
  }

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
      // Brief confirmation flash
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      console.error('Failed to save favorite:', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger button */}
      <button
        onClick={handleShowInput}
        disabled={!canSave}
        className={`flex items-center gap-1.5 text-xs px-2.5 sm:px-3 py-1.5 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
          saved
            ? 'bg-green-500/20 text-green-300'
            : 'bg-brand-500/20 hover:bg-brand-500/30 text-brand-300'
        }`}
      >
        {saved ? (
          <svg className="w-4 h-4 sm:w-3.5 sm:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-4 h-4 sm:w-3.5 sm:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        )}
        <span className="hidden sm:inline">{saved ? 'Saved!' : 'Save Combo'}</span>
      </button>

      {/* Floating popup — anchored to the button so it never squeezes the header */}
      {showInput && (
        <div className="absolute right-0 top-full mt-2 z-50 w-64 max-w-[calc(100vw-1.5rem)] rounded-xl bg-[#16171d] border border-white/10 p-3 shadow-2xl">
          <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
            Combo name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
              if (e.key === 'Escape') { setShowInput(false); setName('') }
            }}
            placeholder="Name this combo..."
            className="w-full text-sm px-2.5 py-2 sm:py-1.5 rounded-md bg-black/40 border border-white/10 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-brand-400"
            autoFocus
          />
          <div className="flex gap-2 mt-2.5">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 text-xs py-2 sm:py-1.5 rounded-md bg-brand-500 hover:bg-brand-600 text-white disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setShowInput(false); setName('') }}
              className="flex-1 text-xs py-2 sm:py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-400 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
