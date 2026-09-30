import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { engine } from '../lib/engine'
import { useStore, useSkipHeadWait } from '../store/useStore'
import { FALLBACK_ASPECT, gridLayout } from '../lib/grid'
import { toggleNativeFullscreen } from '../lib/fullscreen'

/**
 * How close together two taps have to be to count as a double tap on touch
 * devices (ms). Desktop uses the browser's own `dblclick` and ignores this.
 */
const DOUBLE_TAP_MS = 300

/**
 * How far the second tap may drift from the first (px). Fingers are not mice —
 * without this a tap that slides even slightly would not register.
 */
const DOUBLE_TAP_SLOP_PX = 40

/**
 * `fill` releases the aspect-ratio cap so the canvas covers its container
 * instead of sizing itself to a fraction of the viewport height. Web fullscreen
 * uses it: the picture is then letterboxed inside the canvas by the shader, the
 * same way a video player fills a screen.
 *
 * `grow` is the gentler version used by the desktop three-column layout: the
 * picture keeps its own aspect ratio but is sized against the space the column
 * actually has, so it fills the stage instead of stopping at a viewport
 * fraction. The ratio is enforced here rather than in CSS because neither axis
 * is a known length — the stage is whatever the flex row leaves over.
 */
export function CanvasView({ fill = false, grow = false }: { fill?: boolean; grow?: boolean } = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // The stage the picture is measured against when `grow` is on. It is a
  // separate element because the picture box cannot size itself from a
  // container whose height it is also responsible for.
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null)
  // Last tap time/position, for touch double-tap detection.
  const lastTapRef = useRef(0)
  const lastTapPosRef = useRef({ x: 0, y: 0 })
  const mediaA = useStore((s) => s.mediaA)
  const mediaB = useStore((s) => s.mediaB)
  const maskSettings = useStore((s) => s.maskSettings)
  const quality = useStore((s) => s.quality)
  const volumeA = useStore((s) => s.volumeA)
  const volumeB = useStore((s) => s.volumeB)
  const mutedA = useStore((s) => s.mutedA)
  const mutedB = useStore((s) => s.mutedB)
  const setCurrentTime = useStore((s) => s.setCurrentTime)
  const setDuration = useStore((s) => s.setDuration)
  const setIsPlaying = useStore((s) => s.setIsPlaying)
  const viewMode = useStore((s) => s.viewMode)
  const bOffset = useStore((s) => s.bOffset)
  const skipHeadWait = useSkipHeadWait()

  // Init engine
  useEffect(() => {
    if (!canvasRef.current) return
    // The persisted tier has to be applied BEFORE init: init is what logs the
    // quality tier and builds the renderer, and if it runs first it reports (and
    // briefly renders at) the device default instead of the user's choice.
    // setQuality is safe before init — it only sets the field, because resize()
    // bails out while there is no renderer.
    engine.setQuality(useStore.getState().quality)
    engine.init(canvasRef.current)
    engine.onTimeUpdate = (t) => setCurrentTime(t)
    engine.onVideoEnded = () => setIsPlaying(false)

    // Restore the rest of the persisted settings.
    const state = useStore.getState()
    engine.setLoop(state.isLooping)
    engine.setRate(state.playbackRate)
    engine.setSyncOffset(state.bOffset)
    engine.setSkipHeadWait(skipHeadWait)
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

  // Measure the stage. Layout effect rather than effect: the very first paint
  // already has to use the real size, or the picture would flash at full width
  // for a frame before snapping to the fitted box.
  useLayoutEffect(() => {
    if (!grow) {
      setStage(null)
      return
    }
    const el = stageRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setStage((prev) =>
        prev && Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
          ? prev
          : { w: r.width, h: r.height },
      )
    }
    measure()
    // The stage resizes with the window, with the side columns and with the
    // combos divider, none of which is a window resize event.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [grow])

  // Sync media A changes to engine
  useEffect(() => {
    engine.setMedia('A', mediaA)
    // A newly created element ignores the store, so the persisted per-slot
    // settings have to be pushed onto it again.
    const st = useStore.getState()
    engine.setRate(st.playbackRate)
    engine.setVolume('A', st.volumeA, st.mutedA)
    setIsPlaying(false)
  }, [mediaA, setIsPlaying])

  // Sync media B changes to engine
  useEffect(() => {
    engine.setMedia('B', mediaB)
    const st = useStore.getState()
    engine.setRate(st.playbackRate)
    engine.setVolume('B', st.volumeB, st.mutedB)
    setIsPlaying(false)
  }, [mediaB, setIsPlaying])

  // Grid mode changes what the renderer draws and what it uploads, so it lives
  // on the engine rather than in React state alone.
  useEffect(() => {
    engine.setGridMode(viewMode === 'grid')
  }, [viewMode])

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

  // Quality changes re-apply the caps and rebuild the texture path. Harmless on
  // mount: setQuality is a no-op when the tier has not actually changed.
  useEffect(() => {
    engine.setQuality(quality)
  }, [quality])

  useEffect(() => { engine.setVolume('A', volumeA, mutedA) }, [volumeA, mutedA])
  useEffect(() => { engine.setVolume('B', volumeB, mutedB) }, [volumeB, mutedB])

  // The A→B skew lives on the sync manager, so changing it is instant: no
  // reload of either slot is needed and playback does not restart.
  useEffect(() => { engine.setSyncOffset(bOffset) }, [bOffset])

  // How that skew is established from the head (skip vs wait) is read at the
  // next start, so pushing it here is enough — no reload either.
  useEffect(() => { engine.setSkipHeadWait(skipHeadWait) }, [skipHeadWait])

  // There is no mask to steer in grid mode, so tracking the pointer would only
  // force redraws for nothing.
  const isGrid = viewMode === 'grid'

  // Mouse events
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isGrid) return
    engine.setMouseFromEvent(e.clientX, e.clientY)
  }

  const handleMouseLeave = () => {
    if (isGrid) return
    engine.setMouseInactive()
  }

  // Touch support — a single finger acts as the "mouse" so the mask follows it
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    const touch = e.touches[0]

    // Double tap = toggle native fullscreen, the touch equivalent of dblclick.
    // Checked before the grid guard on purpose: fullscreen has nothing to do
    // with the mask, so it should work in grid mode too.
    const now = Date.now()
    const dx = touch.clientX - lastTapPosRef.current.x
    const dy = touch.clientY - lastTapPosRef.current.y
    if (now - lastTapRef.current < DOUBLE_TAP_MS && Math.hypot(dx, dy) < DOUBLE_TAP_SLOP_PX) {
      lastTapRef.current = 0
      toggleNativeFullscreen(containerRef.current)
    } else {
      lastTapRef.current = now
      lastTapPosRef.current = { x: touch.clientX, y: touch.clientY }
    }

    if (isGrid) return
    engine.setMouseFromEvent(touch.clientX, touch.clientY)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isGrid || e.touches.length === 0) return
    // Only track a single finger; ignore pinch gestures
    if (e.touches.length > 1) {
      engine.setMouseInactive()
      return
    }
    const touch = e.touches[0]
    engine.setMouseFromEvent(touch.clientX, touch.clientY)
  }

  const handleTouchEnd = () => {
    if (isGrid) return
    engine.setMouseInactive()
  }

  // Wheel to adjust radius (desktop)
  const handleWheel = (e: React.WheelEvent) => {
    if (isGrid) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.01 : 0.01
    const current = useStore.getState().maskSettings
    const newRadius = Math.max(0.02, Math.min(0.5, current.radius + delta))
    useStore.getState().setMaskSettings({ radius: newRadius })
  }

  // Double click toggles native fullscreen — in on the way in, off on the way
  // out. The same gesture reads as "make this bigger" and "put it back", so one
  // handler covers both states.
  const handleDoubleClick = () => {
    toggleNativeFullscreen(containerRef.current)
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

  // The playback area adopts the picture's own aspect ratio, so a portrait clip
  // gets a portrait frame instead of sitting inside a wide letterbox: media A's
  // in mask mode, and the two cells joined together in grid mode. Falls back to
  // 16:9 before anything is loaded.
  const aspectOf = (m: typeof mediaA) =>
    m && m.width > 0 && m.height > 0 ? m.width / m.height : null
  const mediaAspect = isGrid
    ? gridLayout(aspectOf(mediaA), aspectOf(mediaB)).aspect
    : aspectOf(mediaA) ?? FALLBACK_ASPECT
  const ar = mediaAspect > 0 ? mediaAspect : FALLBACK_ASPECT

  // Largest box with the media's own ratio that fits the stage: height-bound on
  // a wide shallow stage, width-bound on a narrow tall one. Left undefined until
  // the stage has been measured, which lets the CSS ratio carry the first paint.
  let box: { width: number; height: number } | undefined
  if (grow && stage && stage.w > 0 && stage.h > 0) {
    const w = Math.min(stage.w, stage.h * ar)
    box = { width: Math.floor(w), height: Math.floor(w / ar) }
  }

  const frame = (
    <div
      ref={containerRef}
      className={`canvas-fit relative bg-black overflow-hidden shadow-2xl ${
        fill ? 'canvas-fill' : grow ? 'canvas-grow rounded-lg sm:rounded-xl' : 'rounded-lg sm:rounded-xl'
      }`}
      style={{ '--ar': String(ar), ...(box ?? {}) } as React.CSSProperties}
      onDoubleClick={handleDoubleClick}
    >
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 w-full h-full touch-none select-none ${
          isGrid ? '' : 'cursor-crosshair'
        }`}
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
            {isGrid ? (
              <p className="text-[10px] sm:text-xs mt-1 opacity-60">Both media play side by side</p>
            ) : (
              <>
                <p className="text-[10px] sm:text-xs mt-1 opacity-60 hidden sm:block">Move mouse on canvas to reveal B through A</p>
                <p className="text-[10px] sm:text-xs mt-1 opacity-60 sm:hidden">Touch &amp; drag on canvas to reveal B through A</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )

  // The stage wrapper is ALWAYS rendered, and `grow` only switches its class.
  // Letting the wrapper appear/disappear would make React reuse the outer div
  // for the stage and build a fresh canvas inside — the engine would keep the
  // old, now-detached element and every resize would land nowhere (the picture
  // would stay black). `display: contents` keeps the non-grow layouts exactly
  // as they were before the wrapper existed.
  return (
    <div ref={stageRef} className={grow ? 'rp-stage' : 'contents'}>
      {frame}
    </div>
  )
}
