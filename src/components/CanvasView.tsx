import { useEffect, useRef } from 'react'
import { engine } from '../lib/engine'
import { useStore } from '../store/useStore'

export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mediaA = useStore((s) => s.mediaA)
  const mediaB = useStore((s) => s.mediaB)
  const maskSettings = useStore((s) => s.maskSettings)
  const setCurrentTime = useStore((s) => s.setCurrentTime)
  const setDuration = useStore((s) => s.setDuration)
  const setIsPlaying = useStore((s) => s.setIsPlaying)

  // Init engine
  useEffect(() => {
    if (!canvasRef.current) return
    engine.init(canvasRef.current)
    engine.onTimeUpdate = (t) => setCurrentTime(t)
    engine.onVideoEnded = () => setIsPlaying(false)

    // Restore persisted settings to engine
    const state = useStore.getState()
    engine.setLoop(state.isLooping)
    engine.setRate(state.playbackRate)
    engine.updateMaskUniforms(state.maskSettings)

    const handleResize = () => engine.resize()
    window.addEventListener('resize', handleResize)

    // ResizeObserver for container changes
    const ro = new ResizeObserver(() => engine.resize())
    if (canvasRef.current) ro.observe(canvasRef.current)

    return () => {
      window.removeEventListener('resize', handleResize)
      ro.disconnect()
      engine.onTimeUpdate = null
      engine.onVideoEnded = null
      engine.dispose()
    }
  }, [setCurrentTime])

  // Sync media A changes to engine
  useEffect(() => {
    engine.setMedia('A', mediaA)
    // Apply persisted playback rate to new video element
    engine.setRate(useStore.getState().playbackRate)
    setIsPlaying(false)
  }, [mediaA, setIsPlaying])

  // Sync media B changes to engine
  useEffect(() => {
    engine.setMedia('B', mediaB)
    engine.setRate(useStore.getState().playbackRate)
    setIsPlaying(false)
  }, [mediaB, setIsPlaying])

  // Update duration when media changes
  useEffect(() => {
    if (mediaA?.duration) setDuration(mediaA.duration)
    else if (mediaB?.duration) setDuration(mediaB.duration)
    else setDuration(0)
  }, [mediaA, mediaB, setDuration])

  // Sync mask settings to engine
  useEffect(() => {
    engine.updateMaskUniforms(maskSettings)
  }, [maskSettings])

  // Mouse events
  const handleMouseMove = (e: React.MouseEvent) => {
    engine.setMouseFromEvent(e.clientX, e.clientY)
  }

  const handleMouseLeave = () => {
    engine.setMouseInactive()
  }

  // Touch support — a single finger acts as the "mouse" so the mask follows it
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    const touch = e.touches[0]
    engine.setMouseFromEvent(touch.clientX, touch.clientY)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 0) return
    // Only track a single finger; ignore pinch gestures
    if (e.touches.length > 1) {
      engine.setMouseInactive()
      return
    }
    const touch = e.touches[0]
    engine.setMouseFromEvent(touch.clientX, touch.clientY)
  }

  const handleTouchEnd = () => {
    engine.setMouseInactive()
  }

  // Wheel to adjust radius (desktop)
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.01 : 0.01
    const current = useStore.getState().maskSettings
    const newRadius = Math.max(0.02, Math.min(0.5, current.radius + delta))
    useStore.getState().setMaskSettings({ radius: newRadius })
  }

  // Detect play state changes
  useEffect(() => {
    const checkPlayState = () => {
      const state = useStore.getState()
      const vA = engine.elA instanceof HTMLVideoElement ? engine.elA : null
      const vB = engine.elB instanceof HTMLVideoElement ? engine.elB : null
      const anyPlaying = (vA && !vA.paused) || (vB && !vB.paused)
      if (anyPlaying !== state.isPlaying) {
        setIsPlaying(!!anyPlaying)
      }
    }
    const interval = setInterval(checkPlayState, 200)
    return () => clearInterval(interval)
  }, [setIsPlaying])

  // The playback area adopts media A's own aspect ratio, so a portrait clip
  // gets a portrait frame instead of sitting inside a wide letterbox.
  // Falls back to 16:9 before anything is loaded.
  const mediaAspect =
    mediaA && mediaA.width > 0 && mediaA.height > 0 ? mediaA.width / mediaA.height : 16 / 9

  return (
    <div
      className="canvas-fit relative bg-black rounded-lg sm:rounded-xl overflow-hidden shadow-2xl"
      style={{ '--ar': String(mediaAspect) } as React.CSSProperties}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full cursor-crosshair touch-none select-none"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onWheel={handleWheel}
      />
      {/* Placeholder when no media A */}
      {!mediaA && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-500 pointer-events-none px-4">
          <div className="text-center">
            <svg className="w-10 h-10 sm:w-16 sm:h-16 mx-auto mb-2 sm:mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-xs sm:text-sm">Load media A and B to begin</p>
            <p className="text-[10px] sm:text-xs mt-1 opacity-60 hidden sm:block">Move mouse on canvas to reveal B through A</p>
            <p className="text-[10px] sm:text-xs mt-1 opacity-60 sm:hidden">Touch &amp; drag on canvas to reveal B through A</p>
          </div>
        </div>
      )}
    </div>
  )
}
