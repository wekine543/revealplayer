import { useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { loadLocalFile, loadUrlMedia } from '../lib/media'
import { saveBlob } from '../lib/db'

interface MediaLoaderProps {
  slot: 'A' | 'B'
}

export function MediaLoader({ slot }: MediaLoaderProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState('')
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  const media = useStore((s) => (slot === 'A' ? s.mediaA : s.mediaB))
  const setMedia = useStore((s) => (slot === 'A' ? s.setMediaA : s.setMediaB))

  const handleFile = async (file: File) => {
    setError('')
    setLoading(true)
    try {
      const mediaItem = await loadLocalFile(file)

      // Save blob to IndexedDB for local files
      if (mediaItem.source === 'local') {
        const res = await fetch(mediaItem.url)
        const blob = await res.blob()
        mediaItem.blobId = await saveBlob(blob)
      }

      setMedia(mediaItem)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load file')
    } finally {
      setLoading(false)
    }
  }

  const handleUrl = async () => {
    if (!urlInput.trim()) return
    setError('')
    setLoading(true)
    try {
      const mediaItem = await loadUrlMedia(urlInput.trim())
      setMedia(mediaItem)
      setUrlInput('')
      setShowUrlInput(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load URL')
    } finally {
      setLoading(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) await handleFile(file)
  }

  const removeMedia = () => {
    if (media?.source === 'local' && media.url) {
      URL.revokeObjectURL(media.url)
    }
    setMedia(null)
    setError('')
  }

  const labelColor = slot === 'A' ? 'text-brand-400' : 'text-teal-400'
  const borderColor = slot === 'A' ? 'border-brand-500/40' : 'border-teal-500/40'
  const bgColor = slot === 'A' ? 'bg-brand-500/10' : 'bg-teal-500/10'

  return (
    <div
      className={`relative rounded-lg border-2 border-dashed p-3 transition-colors ${isDragging ? 'border-brand-400 bg-brand-500/20' : `${borderColor} ${bgColor}`}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileRef}
        type="file"
        accept="video/*,image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ''
        }}
      />

      <div className="flex items-center justify-between mb-2">
        <span className={`text-sm font-bold ${labelColor}`}>Media {slot}</span>
        {media && (
          <button
            onClick={removeMedia}
            className="text-xs text-gray-500 hover:text-red-400 transition-colors"
          >
            Remove
          </button>
        )}
      </div>

      {media ? (
        <div className="space-y-2">
          {/* Thumbnail */}
          <div className="relative w-full h-24 rounded-md overflow-hidden bg-black/30 flex items-center justify-center">
            {media.type === 'video' ? (
              <video
                src={media.url}
                className="max-h-full max-w-full object-contain"
                muted
                playsInline
              />
            ) : (
              <img
                src={media.url}
                alt={media.fileName ?? `Media ${slot}`}
                className="max-h-full max-w-full object-contain"
              />
            )}
            <span className="absolute top-1 right-1 text-xs px-1.5 py-0.5 rounded bg-black/60 text-white">
              {media.type}
            </span>
          </div>
          <p className="text-xs text-gray-400 truncate" title={media.fileName ?? media.url}>
            {media.fileName ?? media.url}
          </p>
          <p className="text-xs text-gray-500">
            {media.width} x {media.height}
            {media.duration ? ` · ${media.duration.toFixed(1)}s` : ''}
          </p>
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full text-xs py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
          >
            Replace
          </button>
        </div>
      ) : loading ? (
        <div className="h-24 flex items-center justify-center">
          <div className="animate-spin w-6 h-6 border-2 border-brand-400 border-t-transparent rounded-full" />
        </div>
      ) : showUrlInput ? (
        <div className="space-y-2">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleUrl()}
            placeholder="https://..."
            className="w-full text-sm px-2 py-1.5 rounded-md bg-black/30 border border-white/10 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-brand-400"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={handleUrl}
              className="flex-1 text-xs py-1.5 rounded-md bg-brand-500/20 hover:bg-brand-500/30 text-brand-300 transition-colors"
            >
              Load
            </button>
            <button
              onClick={() => {
                setShowUrlInput(false)
                setUrlInput('')
                setError('')
              }}
              className="flex-1 text-xs py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-400 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="h-24 flex flex-col items-center justify-center gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="text-xs px-3 py-2 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
          >
            Browse File
          </button>
          <button
            onClick={() => setShowUrlInput(true)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            or enter URL
          </button>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400 mt-2 px-1">{error}</p>
      )}

      {!media && !loading && !showUrlInput && (
        <p className="text-xs text-gray-600 text-center mt-1">
          Drag & drop or click
        </p>
      )}
    </div>
  )
}
