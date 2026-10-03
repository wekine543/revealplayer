import { useCallback, useEffect, useRef, useState } from 'react'
import { CanvasView } from './components/CanvasView'
import { ConfigDirPrompt } from './components/ConfigDirPrompt'
import { MediaLoader } from './components/MediaLoader'
import { PlaybackControls } from './components/PlaybackControls'
import { MaskControls } from './components/MaskControls'
import { SyncControls } from './components/SyncControls'
import { FavoriteButton } from './components/FavoriteButton'
import { FavoriteList } from './components/FavoriteList'
import { engine } from './lib/engine'
import { qualityById } from './lib/quality'
import { getDirName, initConfigDir, readConfig } from './lib/configDir'
import * as serverStore from './lib/serverStore'
import { loadSettings } from './lib/settings'
import { useStore } from './store/useStore'
import { DEFAULT_RAIL_WIDTH } from './lib/settings'

/** Collapsible section — controlled by store for persistence */
function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
  className = '',
  bodyClassName = '',
}: {
  title: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
  /** Extra classes on the card itself, e.g. to let it fill a scrolling column. */
  className?: string
  /** Extra classes on the content area, e.g. to make that area the scroller. */
  bodyClassName?: string
}) {
  return (
    <div className={`rounded-xl bg-white/5 border border-white/5 overflow-hidden ${className}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
      >
        <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wide">{title}</h3>
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className={`px-4 pb-4 ${bodyClassName}`}>{children}</div>}
    </div>
  )
}

/**
 * The A/B pickers and the Swap button — one block, because they belong
 * together wherever they are placed. In the three-column layout it sits under
 * Sync Offset, which leaves the whole centre column to the picture; on phone
 * and portrait layouts it stays directly under the transport, where loading
 * media is the first thing anyone does.
 */
function MediaSection({ gridClass = 'grid-cols-2' }: { gridClass?: string }) {
  const swapMedia = useStore((s) => s.swapMedia)
  const mediaA = useStore((s) => s.mediaA)
  const mediaB = useStore((s) => s.mediaB)
  return (
    <>
      <div className={`grid ${gridClass} gap-2 sm:gap-3`}>
        <MediaLoader slot="A" />
        <MediaLoader slot="B" />
      </div>

      <div className="flex justify-center">
        <button
          onClick={swapMedia}
          disabled={!mediaA || !mediaB}
          className="flex items-center gap-1.5 text-xs px-4 py-1.5 sm:py-2 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m4 4H8m0 0l4-4m-4 4l4 4" />
          </svg>
          Swap A / B
        </button>
      </div>
    </>
  )
}

/**
 * The three-column layout applies at `lg` AND in landscape.
 *
 * A window taller than it is wide is a phone shape even when it is 1200px
 * across — three columns there would leave the picture a letterbox between two
 * full-height rails, so anything portrait keeps the stacked phone layout.
 */
const DESKTOP_MQ = '(min-width: 1024px) and (orientation: landscape)'

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(DESKTOP_MQ)
    const onChange = () => setIsDesktop(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}

export default function App() {
  // True on phones/tablets, where the engine caps its render resolution.
  // Read after mount so CanvasView has had a chance to initialise the engine.
  const [lowPower, setLowPower] = useState(false)
  useEffect(() => {
    setLowPower(engine.lowPowerMode)
  }, [])

  // ---- Web fullscreen ----
  // A CSS layout mode, NOT the Fullscreen API: the page stays a page, but
  // everything except the picture and the transport is removed and the layout is
  // pinned to the viewport, so no scrollbar can appear.
  const isWebFullscreen = useStore((s) => s.isWebFullscreen)
  const setWebFullscreen = useStore((s) => s.setWebFullscreen)
  const quality = useStore((s) => s.quality)
  const viewMode = useStore((s) => s.viewMode)

  useEffect(() => {
    if (!isWebFullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWebFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isWebFullscreen, setWebFullscreen])

  // Belt and braces for "no scrollbar": the layout below is already pinned with
  // `fixed inset-0`, but locking the root keeps any stray margin or focus scroll
  // from reintroducing one.
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('web-fs', isWebFullscreen)
    return () => root.classList.remove('web-fs')
  }, [isWebFullscreen])

  // ---- Config folder ----
  // Combos come from the folder's JSON when one is connected; the start-up
  // check below restores the handle and reports whether it is still usable.
  const setConfigStatus = useStore((s) => s.setConfigStatus)
  const setFavorites = useStore((s) => s.setFavorites)
  const setMaskSettings = useStore((s) => s.setMaskSettings)

  /** Pull combos and mask settings out of the active store into the state. */
  const applyConfig = useCallback(async () => {
    try {
      if (serverStore.isActive()) {
        const cfg = await serverStore.readConfig()
        setFavorites([...cfg.combos].sort((a, b) => b.createdAt - a.createdAt))
        if (cfg.maskSettings) setMaskSettings(cfg.maskSettings)
        return
      }
      const cfg = await readConfig()
      setFavorites([...cfg.combos].sort((a, b) => b.createdAt - a.createdAt))
      if (cfg.maskSettings) setMaskSettings(cfg.maskSettings)
    } catch (e) {
      console.error('[RevealPlayer] failed to apply config:', e)
    }
  }, [setFavorites, setMaskSettings])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Probe first: whether a server is reachable decides which backend the
      // rest of start-up talks to.
      await serverStore.probe()
      if (cancelled) return

      // A page served by the launcher never asks for a folder: the folder was
      // picked in the launcher itself, so the page uses it and nothing else.
      if (serverStore.isManaged()) {
        setConfigStatus('idle', serverStore.dirName(), null)
        await applyConfig()
        return
      }

      const restored = await initConfigDir()
      if (cancelled) return
      // Someone who already declined the prompt should not be asked again on
      // every launch — the sidebar still offers the folder.
      const st =
        restored === 'needs-pick' && loadSettings().configSkipped ? 'idle' : restored
      setConfigStatus(st, getDirName())
      // The folder is one way in; a live server store is another, and it is the
      // only one a phone can use.
      if (st === 'ready' || serverStore.isActive()) await applyConfig()
    })()
    return () => {
      cancelled = true
    }
  }, [setConfigStatus, applyConfig])

  // A probe that failed at start-up is retried in the background (see
  // serverStore.probe) — the request that a phone loses while its radio wakes
  // up, or that a page fired a moment before the server was ready. When one of
  // those retries lands, the combos have to arrive with it: leaving the device
  // on the empty browser store until someone thinks to reload is exactly the
  // "it does not show my combos" report this is here to prevent.
  useEffect(() => {
    return serverStore.subscribe((available) => {
      if (!available) return
      // A launcher-managed store never asks for a folder, so a prompt that
      // appeared while the server was unreachable must go away again.
      if (serverStore.isManaged()) setConfigStatus('idle', serverStore.dirName(), null)
      void applyConfig()
    })
  }, [applyConfig, setConfigStatus])

  // Persisted UI state
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed)
  const maskCollapsed = useStore((s) => s.maskCollapsed)
  const setMaskCollapsed = useStore((s) => s.setMaskCollapsed)
  const favoritesCollapsed = useStore((s) => s.favoritesCollapsed)
  const setFavoritesCollapsed = useStore((s) => s.setFavoritesCollapsed)
  const syncCollapsed = useStore((s) => s.syncCollapsed)
  const setSyncCollapsed = useStore((s) => s.setSyncCollapsed)
  const isDesktop = useIsDesktop()

  // ---- Resizable Saved Combos rail ----
  const combosWidth = useStore((s) => s.combosWidth)
  const setCombosWidth = useStore((s) => s.setCombosWidth)
  const commitWidth = (w: number) => setCombosWidth(w, true)
  const dragRef = useRef<{ x: number; width: number } | null>(null)

  const startRailDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    dragRef.current = { x: e.clientX, width: combosWidth }
    // Keeps the pointer events coming to this element even outside it, and
    // stops the drag from turning into a text selection on the way.
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.classList.add('rp-resizing')
  }

  const moveRailDrag = (e: React.PointerEvent) => {
    const start = dragRef.current
    if (!start) return
    // Dragging LEFT widens the rail: it sits on the right edge of the layout.
    setCombosWidth(start.width + (start.x - e.clientX))
  }

  const endRailDrag = (e: React.PointerEvent) => {
    const start = dragRef.current
    if (!start) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('rp-resizing')
    // Persisted once, on release: dragging should not write to storage on every
    // pointer move.
    commitWidth(start.width + (start.x - e.clientX))
  }

  const handleRailKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      commitWidth(combosWidth + step)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      commitWidth(combosWidth - step)
    } else if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault()
      commitWidth(DEFAULT_RAIL_WIDTH)
    }
  }

  // Mask and sync tuning. Built once and placed twice: a column on the window's
  // left edge from `lg` up, and part of the stacked flow below the transport on
  // mobile. The sections hold no state of their own, so the second copy is
  // markup and nothing else.
  const settingsSections = !isWebFullscreen ? (
    <>
      {/* Mask Settings — in grid mode there is no mask to tune, so
          rather than leave sliders that visibly do nothing the panel
          says where the mode switch is. */}
      <CollapsibleSection
        title="Mask Settings"
        open={!maskCollapsed}
        onToggle={() => setMaskCollapsed(!maskCollapsed)}
        className="shrink-0"
      >
        {viewMode === 'grid' ? (
          <p className="text-[11px] text-gray-500 leading-relaxed">
            遮罩参数只在遮罩模式下生效 —— 用画面下方播放条里的「遮罩」按钮切回去。
          </p>
        ) : (
          <MaskControls />
        )}
      </CollapsibleSection>

      {/* A/B time offset — how far B deliberately runs ahead of A.
          Separate from the mask on purpose: it describes the clips
          rather than how they are revealed, so it stays available in
          both view modes. */}
      <CollapsibleSection
        title="Sync Offset"
        open={!syncCollapsed}
        onToggle={() => setSyncCollapsed(!syncCollapsed)}
        className="shrink-0"
      >
        <SyncControls />
      </CollapsibleSection>
    </>
  ) : null

  return (
    <div
      className={
        isWebFullscreen
          ? 'fixed inset-0 z-50 flex flex-col bg-black overflow-hidden safe-x safe-bottom'
          : // Pinned to exactly one screen in the three-column layout: the
            // player can then grow into whatever the two side columns leave, and
            // the transport sits on the bottom edge rather than wherever the
            // content ends.
            'min-h-screen-safe lg:landscape:h-screen-safe lg:landscape:overflow-hidden flex flex-col bg-[#0a0b0f] safe-x'
      }
    >
      {/* Header — hidden in web fullscreen */}
      {!isWebFullscreen && (
      <header className="flex items-center justify-between gap-2 px-3 sm:px-5 py-2.5 sm:py-3 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          {/* Logo */}
          <div className="w-7 h-7 flex-shrink-0 rounded-md bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </div>
          <span className="text-sm sm:text-base font-bold text-white tracking-tight truncate">RevealPlayer</span>
          <span className="text-xs text-gray-600 ml-2 hidden md:inline">Media Overlay Player</span>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          <FavoriteButton />
          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="flex items-center gap-1.5 text-xs px-2.5 sm:px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
            title={sidebarCollapsed ? 'Show panel' : 'Hide panel'}
          >
            <svg className="w-4 h-4 sm:w-3.5 sm:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span className="hidden sm:inline">{sidebarCollapsed ? 'Show Panel' : 'Hide Panel'}</span>
          </button>
        </div>
      </header>
      )}

      {/* Main content — three columns in the desktop layout (settings · player
          · combos), one stacked column otherwise. In web fullscreen it becomes
          a single column that fills the viewport. */}
      <main
        className={
          isWebFullscreen
            ? 'flex-1 min-h-0 flex flex-col'
            : 'flex-1 flex flex-col lg:landscape:flex-row lg:landscape:min-h-0 lg:landscape:overflow-hidden gap-2.5 lg:landscape:gap-3 p-2.5 sm:p-4 w-full'
        }
      >
        {/* Centre: the picture and the transport. First in the DOM because it
            is what a phone should show first; `order-2` moves it between the
            two side columns in the desktop layout. */}
        <div
          className={
            isWebFullscreen
              ? 'flex-1 min-h-0 flex flex-col gap-2 p-2'
              : 'flex-1 flex flex-col gap-2.5 sm:gap-3 min-w-0 lg:landscape:order-2 lg:landscape:min-h-0'
          }
        >
          <CanvasView fill={isWebFullscreen} grow={isDesktop && !isWebFullscreen} />
          <PlaybackControls webFullscreen={isWebFullscreen} />

          {/* A/B selection + playback tuning — below the transport on phone and
              in portrait, where there is no column to put them in. Hidden in
              the three-column layout, where both move to the left column. */}
          {!isWebFullscreen && (
            <>
              <div className="flex flex-col gap-2.5 sm:gap-3 lg:landscape:hidden">
                <MediaSection />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3 items-start lg:landscape:hidden">
                {settingsSections}
              </div>
            </>
          )}
        </div>

        {/* Left column — Mask Settings, Sync Offset and the A/B pickers, flush
            with the window's left edge in the three-column layout. The sections
            are `shrink-0` so an overflowing column scrolls instead of clipping
            them (a flex item with `overflow: hidden` would otherwise shrink to
            fit and silently swallow the rest). */}
        {!sidebarCollapsed && settingsSections && (
          <div className="hidden lg:landscape:flex lg:landscape:order-1 flex-col gap-2.5 w-64 xl:w-72 flex-shrink-0 lg:landscape:overflow-y-auto">
            {settingsSections}
            <MediaSection gridClass="grid-cols-1" />
          </div>
        )}

        {/* Resizable divider — three-column layout only. When the panels are
            stacked there is nothing to resize. Drag it, or focus it and use the
            arrow keys; double-click restores the default. */}
        {!sidebarCollapsed && !isWebFullscreen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Saved Combos panel"
            tabIndex={0}
            // w-3 with matching negative margins: a 12px grab zone — enough to
            // catch, drawn as a 1px line — that adds no layout width of its own.
            className="hidden lg:landscape:flex lg:landscape:order-3 self-stretch w-3 -mx-1.5 flex-shrink-0 cursor-col-resize touch-none items-center justify-center group z-10"
            onPointerDown={startRailDrag}
            onPointerMove={moveRailDrag}
            onPointerUp={endRailDrag}
            onPointerCancel={endRailDrag}
            onDoubleClick={() => commitWidth(DEFAULT_RAIL_WIDTH)}
            onKeyDown={handleRailKey}
            title="拖拽调整宽度 · 双击复位 · 方向键微调"
          >
            <span className="relative w-1 h-full flex items-center justify-center">
              <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-white/10 group-hover:bg-brand-500/70 group-focus-visible:bg-brand-400 transition-colors" />
              {/* Little grip, so the thing reads as draggable before it is touched */}
              <span className="absolute w-1 h-8 rounded-full bg-white/15 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity" />
            </span>
          </div>
        )}

        {/* Saved Combos rail — a column beside the player in the three-column
            layout, part of the same stacked sequence below the content
            otherwise. Its width is the user's, remembered across sessions (see
            .rp-rail). */}
        {!sidebarCollapsed && !isWebFullscreen && (
          <div
            className="rp-rail flex flex-col gap-3 flex-shrink-0 lg:landscape:order-4"
            style={{ '--rp-rail-w': `${combosWidth}px` } as React.CSSProperties}
          >
            {/* In the three-column layout the card list is the scroller: the
                section fills the rail and its body takes whatever is left, so a
                long list scrolls instead of being cut off at the bottom edge.
                The header stays put above it. */}
            <CollapsibleSection
              title="Saved Combos"
              open={!favoritesCollapsed}
              onToggle={() => setFavoritesCollapsed(!favoritesCollapsed)}
              className="lg:landscape:flex-1 lg:landscape:min-h-0 lg:landscape:flex lg:landscape:flex-col"
              bodyClassName="lg:landscape:flex-1 lg:landscape:min-h-0 lg:landscape:overflow-y-auto"
            >
              <FavoriteList />
            </CollapsibleSection>
          </div>
        )}
      </main>

      {/* Config folder gate — start-up modal / unsupported-environment notice */}
      <ConfigDirPrompt onConnected={applyConfig} />

      {/* Footer — hidden in web fullscreen */}
      {!isWebFullscreen && (
      <footer className="px-3 sm:px-5 py-2 border-t border-white/5 safe-bottom">
        <p className="text-[10px] sm:text-xs text-gray-600 text-center leading-relaxed">
          <span className="hidden sm:inline">
            Move mouse over the canvas to reveal Media B through Media A · Scroll to adjust mask radius
          </span>
          <span className="sm:hidden">
            Tap &amp; drag the canvas to reveal Media B · Use the slider to adjust the mask
          </span>
        </p>
        {lowPower && (
          <p className="text-[10px] text-gray-700 text-center mt-0.5">
            Mobile power saving on · quality {qualityById(quality).label}
            {isFinite(qualityById(quality).textureLongEdge)
              ? ` · video textures capped at ${qualityById(quality).textureLongEdge}px`
              : ' · video textures at source resolution'}
          </p>
        )}
      </footer>
      )}
    </div>
  )
}
