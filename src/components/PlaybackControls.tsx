import { engine } from '../lib/engine'
import { useStore } from '../store/useStore'
import { formatTime } from '../lib/media'
import { QUALITY_LEVELS, type QualityId } from '../lib/quality'
import { useEffect, useRef, useCallback } from 'react'

/**
 * `webFullscreen` is the Bilibili-style CSS layout mode: the surrounding chrome
 * is gone, so this bar keeps only what is needed to drive playback — play/pause,
 * the clock, the progress bar and the way out. Volume, rate, loop, quality and
 * screenshot are hidden, and the quality picker is deliberately among them
 * because changing resolution mid-fullscreen is not a thing you reach for.
 */
export function PlaybackControls({ webFullscreen = false }: { webFullscreen?: boolean } = {}) {
  const isPlaying = useStore((s) => s.isPlaying)
  const setIsPlaying = useStore((s) => s.setIsPlaying)
  const currentTime = useStore((s) => s.currentTime)
  const duration = useStore((s) => s.duration)
  const volumeA = useStore((s) => s.volumeA)
  const volumeB = useStore((s) => s.volumeB)
  const mutedA = useStore((s) => s.mutedA)
  const mutedB = useStore((s) => s.mutedB)
  const playbackRate = useStore((s) => s.playbackRate)
  const isLooping = useStore((s) => s.isLooping)
  const setVolumeA = useStore((s) => s.setVolumeA)
  const setVolumeB = useStore((s) => s.setVolumeB)
  const setMutedA = useStore((s) => s.setMutedA)
  const setMutedB = useStore((s) => s.setMutedB)
  const setPlaybackRate = useStore((s) => s.setPlaybackRate)
  const setLooping = useStore((s) => s.setLooping)
  const mediaA = useStore((s) => s.mediaA)
  const mediaB = useStore((s) => s.mediaB)
  const quality = useStore((s) => s.quality)
  const setQuality = useStore((s) => s.setQuality)
  const viewMode = useStore((s) => s.viewMode)
  const setViewMode = useStore((s) => s.setViewMode)
  const setWebFullscreen = useStore((s) => s.setWebFullscreen)

  const hasVideo = mediaA?.type === 'video' || mediaB?.type === 'video'
  const progressRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)

  // ---- Seek helper ----
  /**
   * A drag pauses the pair and, on release, aligns them while parked and starts
   * them together.
   *
   * Why pause at all: the misalignment was traced to B loading a beat slow at the
   * start of playback. Correcting a RUNNING pair means aiming ahead of a moving
   * target by an estimated seek latency, and every attempt freezes B's picture
   * for its whole duration. Parked, A cannot run away, B gets as long as it needs
   * to finish seeking and buffering, and the alignment needs no estimate at all.
   */
  const wasPlayingRef = useRef(false)

  const beginDrag = useCallback(() => {
    wasPlayingRef.current = useStore.getState().isPlaying
    isDraggingRef.current = true
    // Park the master so the follower is not chasing it while it loads.
    engine.pause()
    engine.beginSeek()
  }, [])

  const finishDrag = useCallback(() => {
    isDraggingRef.current = false
    engine.endSeek()
    // Resume only if it was playing when the drag started — a scrub while
    // paused must stay paused.
    void engine.realignAndResume(wasPlayingRef.current)
  }, [])

  const seekTo = useCallback((clientX: number) => {
    if (!progressRef.current || duration === 0) return
    const rect = progressRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const newTime = ratio * duration
    engine.seek(newTime)
    useStore.getState().setCurrentTime(newTime)
  }, [duration])

  // ---- Play / Pause ----
  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      engine.pause()
      setIsPlaying(false)
    } else {
      engine.play()
      setIsPlaying(true)
    }
  }, [isPlaying, setIsPlaying])

  // ---- Progress bar drag (document-level for robust dragging) ----
  useEffect(() => {
    if (!isDraggingRef.current) return

    const onMove = (e: MouseEvent) => seekTo(e.clientX)
    const onUp = () => finishDrag()

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [seekTo, finishDrag])

  const handleProgressDown = (e: React.MouseEvent) => {
    e.preventDefault()
    beginDrag()
    seekTo(e.clientX)
    // Manually attach since the effect above only fires on re-render
    const onMove = (ev: MouseEvent) => seekTo(ev.clientX)
    const onUp = () => {
      finishDrag()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ---- Volume, one per slot ----
  const isVideoA = mediaA?.type === 'video'
  const isVideoB = mediaB?.type === 'video'

  const handleVolumeChange = (slot: 'A' | 'B', e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    if (slot === 'A') {
      setVolumeA(v)
      setMutedA(v === 0)
    } else {
      setVolumeB(v)
      setMutedB(v === 0)
    }
    engine.setVolume(slot, v, v === 0)
  }

  const toggleMute = (slot: 'A' | 'B') => {
    const muted = slot === 'A' ? mutedA : mutedB
    const volume = slot === 'A' ? volumeA : volumeB
    const newMuted = !muted
    if (slot === 'A') setMutedA(newMuted)
    else setMutedB(newMuted)
    engine.setVolume(slot, volume, newMuted)
  }

  // ---- Playback rate ----
  const handleRateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const rate = parseFloat(e.target.value)
    setPlaybackRate(rate)
    engine.setRate(rate)
  }

  // ---- Loop ----
  const handleQualityChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setQuality(e.target.value as QualityId)
  }

  const toggleLoop = () => {
    const newLoop = !isLooping
    setLooping(newLoop)
    engine.setLoop(newLoop)
  }

  // ---- Fullscreen ----
  const handleFullscreen = () => {
    const canvas = engine.canvas
    if (!canvas) return
    const container = canvas.parentElement
    if (!container) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      container.requestFullscreen()
    }
  }

  // ---- Screenshot ----
  const handleScreenshot = () => {
    const dataUrl = engine.captureScreenshot()
    if (!dataUrl) return
    const link = document.createElement('a')
    link.download = `revealplayer_${Date.now()}.png`
    link.href = dataUrl
    link.click()
  }

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept when typing in an input/select
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (!hasVideo) return

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          handlePlayPause()
          break
        case 'ArrowLeft':
          e.preventDefault()
          { const t = Math.max(0, useStore.getState().currentTime - 5)
            engine.seek(t) }
          break
        case 'ArrowRight':
          e.preventDefault()
          { const t = Math.min(duration, useStore.getState().currentTime + 5)
            engine.seek(t) }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasVideo, duration, handlePlayPause])

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5 sm:gap-x-3 px-3 sm:px-4 py-2.5 bg-black/40 rounded-lg border border-white/5">
      {/* Transport group — play / time / progress (own row on mobile) */}
      <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto sm:flex-1 min-w-0">
        {/* Play/Pause */}
        <button
          onClick={handlePlayPause}
          disabled={!hasVideo}
          className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-full bg-brand-500 hover:bg-brand-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-white"
          title="Play/Pause (Space)"
        >
          {isPlaying ? (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Time display */}
        <span className="text-[10px] sm:text-xs font-mono text-gray-400 tabular-nums whitespace-nowrap">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* Progress bar */}
        <div
          ref={progressRef}
          className="flex-1 h-1.5 rounded-full bg-white/10 cursor-pointer relative group touch-none"
          onMouseDown={handleProgressDown}
          onTouchStart={(e) => {
            const t = e.touches[0]
            if (!t) return
            beginDrag()
            seekTo(t.clientX)
          }}
          onTouchMove={(e) => {
            const t = e.touches[0]
            if (!t) return
            seekTo(t.clientX)
          }}
          onTouchEnd={() => finishDrag()}
          // The browser sends this instead of touchend when it takes the
          // gesture over (a second finger, a system gesture, the touch being
          // cancelled). Without it the drag never ends and the sync loop stays
          // parked. SyncManager also ends a silent drag on its own, so this is
          // the fast path, not the only one.
          onTouchCancel={() => finishDrag()}
        >
          <div
            className="absolute top-0 left-0 h-full rounded-full bg-brand-400 transition-colors group-hover:bg-brand-300"
            style={{ width: `${progress}%` }}
          />
          <div
            className="absolute top-1/2 w-3 h-3 rounded-full bg-white shadow-md -translate-y-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ left: `${progress}%` }}
          />
        </div>

        {/* View mode — mask (B revealed through A) or grid (both whole).
            Kept in the transport row rather than with the settings below so it
            survives web fullscreen: how you look at the two clips is a playback
            control, not a preference you tune once. */}
        <button
          onClick={() => {
            const next = viewMode === 'grid' ? 'mask' : 'grid'
            setViewMode(next)
            engine.setGridMode(next === 'grid')
          }}
          className={`flex-shrink-0 flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
            viewMode === 'grid'
              ? 'bg-brand-500/20 text-brand-300 hover:bg-brand-500/30'
              : 'bg-white/5 hover:bg-white/10 text-gray-300'
          }`}
          title={viewMode === 'grid' ? 'Switch to mask mode' : 'Switch to grid mode (both media)'}
        >
          {viewMode === 'grid' ? (
            // Mask: a circle cut out of a square
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth={2} />
              <circle cx="12" cy="12" r="4.5" strokeWidth={2} />
            </svg>
          ) : (
            // Grid: a frame split in two
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth={2} />
              <path strokeLinecap="round" strokeWidth={2} d="M12 3v18" />
            </svg>
          )}
          <span className="hidden sm:inline">{viewMode === 'grid' ? '遮罩' : '网格'}</span>
        </button>

        {/* Web-fullscreen exit — the only extra control this mode keeps */}
        {webFullscreen && (
          <button
            onClick={() => setWebFullscreen(false)}
            className="flex-shrink-0 flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-gray-200 transition-colors"
            title="Exit web fullscreen (Esc)"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4H4m0 0l5 5m6-5h5v5m0 0l-5-5M9 15v5H4m0 0l5-5m6 5h5v-5m0 0l-5 5" />
            </svg>
            <span className="hidden sm:inline">退出网页全屏</span>
          </button>
        )}
      </div>

      {/* Settings group — centers below the transport row on mobile.
          Hidden entirely in web fullscreen: the point of that mode is to leave
          the picture and the transport and nothing else.

          `flex-wrap` is not optional: this row grew to eight controls (two
          volume groups once A/B were split, plus quality and web fullscreen)
          and in portrait a single unwrapped line pushed the last ones — A's
          volume, fullscreen, screenshot — off the right edge where they could
          not be reached at all. */}
      <div
        className={`items-center justify-center gap-x-3 gap-y-2 w-full sm:w-auto ${
          webFullscreen ? 'hidden' : 'flex flex-wrap'
        }`}
      >
        {/* Volume — separate per slot, so the two sources can be balanced */}
        {(['A', 'B'] as const).map((slot) => {
          const isVideo = slot === 'A' ? isVideoA : isVideoB
          const volume = slot === 'A' ? volumeA : volumeB
          const muted = slot === 'A' ? mutedA : mutedB
          return (
            <div key={slot} className="flex items-center gap-1">
              <span className="text-[10px] font-bold text-gray-500 w-2 select-none">{slot}</span>
              <button
                onClick={() => toggleMute(slot)}
                disabled={!isVideo}
                className="text-gray-400 hover:text-white disabled:opacity-30 transition-colors p-1 -m-0.5"
                title={muted ? `Unmute media ${slot}` : `Mute media ${slot}`}
              >
                {muted || volume === 0 ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3l2.7-2.7-1.41-1.41L15 11.59 12.41 9 11 10.41 13.59 13 11 15.59 12.41 17 15 14.41 17.59 17l1.41-1.41L15.59 13z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.06c1.48-.73 2.5-2.25 2.5-4.03z" />
                  </svg>
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => handleVolumeChange(slot, e)}
                disabled={!isVideo}
                className="w-11 sm:w-16 h-1 accent-brand-400 disabled:opacity-30"
              />
            </div>
          )
        })}

        {/* Playback rate */}
        <select
          value={playbackRate}
          onChange={handleRateChange}
          disabled={!hasVideo}
          className="text-xs bg-black/30 text-gray-300 border border-white/10 rounded-md px-1.5 py-1.5 sm:py-1 disabled:opacity-30 focus:outline-none focus:border-brand-400 cursor-pointer"
        >
          <option value={0.5}>0.5x</option>
          <option value={0.75}>0.75x</option>
          <option value={1}>1x</option>
          <option value={1.25}>1.25x</option>
          <option value={1.5}>1.5x</option>
          <option value={2}>2x</option>
        </select>

        {/* Loop */}
        <button
          onClick={toggleLoop}
          disabled={!hasVideo}
          className={`transition-colors disabled:opacity-30 p-1.5 ${isLooping ? 'text-brand-400' : 'text-gray-400 hover:text-white'}`}
          title="Loop"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.582m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        {/* Quality — 原画 / 1080P / 720P / 480P */}
        <select
          value={quality}
          onChange={handleQualityChange}
          className="text-xs bg-black/30 text-gray-300 border border-white/10 rounded-md px-1.5 py-1.5 sm:py-1 disabled:opacity-30 focus:outline-none focus:border-brand-400 cursor-pointer"
          title="Render quality"
        >
          {QUALITY_LEVELS.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label}
            </option>
          ))}
        </select>

        {/* Web fullscreen — CSS layout mode, not the native Fullscreen API */}
        <button
          onClick={() => setWebFullscreen(true)}
          className="text-gray-400 hover:text-white transition-colors p-1.5"
          title="Web fullscreen (fill the page, no browser chrome)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16v14H4z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 9h16M4 15h16" />
          </svg>
        </button>

        {/* Fullscreen */}
        <button
          onClick={handleFullscreen}
          className="text-gray-400 hover:text-white transition-colors p-1.5"
          title="Fullscreen"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l4 4m8-4h4m0 0v4m0-4l-4 4M4 16v4m0 0h4m-4 0l4-4m8 4h4m0 0v-4m0 4l-4-4" />
          </svg>
        </button>

        {/* Screenshot */}
        <button
          onClick={handleScreenshot}
          className="text-gray-400 hover:text-white transition-colors p-1.5"
          title="Screenshot"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
