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
    setIsPlaying(false)
  }, [mediaA, setIsPlaying])

  // Sync media B changes to engine
  useEffect(() => {
    engine.setMedia('B', mediaB)
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

  // Touch support
  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 0) return
    const touch = e.touches[0]
    engine.setMouseFromEvent(touch.clientX, touch.clientY)
  }

  const handleTouchEnd = () => {
    engine.setMouseInactive()
  }

  // Wheel to adjust radius
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

  return (
    <div className="relative w-full bg-black rounded-xl overflow-hidden shadow-2xl" style={{ aspectRatio: '16 / 9' }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onWheel={handleWheel}
      />
      {/* Placeholder when no media A */}
      {!mediaA && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-500 pointer-events-none">
          <div className="text-center">
            <svg className="w-16 h-16 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-sm">Load media A and B to begin</p>
            <p className="text-xs mt-1 opacity-60">Move mouse on canvas to reveal B through A</p>
          </div>
        </div>
      )}
    </div>
  )
}
