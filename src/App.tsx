import { useEffect, useState } from 'react'
import { CanvasView } from './components/CanvasView'
import { MediaLoader } from './components/MediaLoader'
import { PlaybackControls } from './components/PlaybackControls'
import { MaskControls } from './components/MaskControls'
import { FavoriteButton } from './components/FavoriteButton'
import { FavoriteList } from './components/FavoriteList'
import { engine } from './lib/engine'
import { useStore } from './store/useStore'

/** Collapsible section — controlled by store for persistence */
function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl bg-white/5 border border-white/5 overflow-hidden">
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
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

export default function App() {
  const swapMedia = useStore((s) => s.swapMedia)
  const mediaA = useStore((s) => s.mediaA)
  const mediaB = useStore((s) => s.mediaB)

  // True on phones/tablets, where the engine caps its render resolution.
  // Read after mount so CanvasView has had a chance to initialise the engine.
  const [lowPower, setLowPower] = useState(false)
  useEffect(() => {
    setLowPower(engine.lowPowerMode)
  }, [])

  // Persisted UI state
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed)
  const maskCollapsed = useStore((s) => s.maskCollapsed)
  const setMaskCollapsed = useStore((s) => s.setMaskCollapsed)
  const favoritesCollapsed = useStore((s) => s.favoritesCollapsed)
  const setFavoritesCollapsed = useStore((s) => s.setFavoritesCollapsed)

  return (
    <div className="min-h-screen-safe flex flex-col bg-[#0a0b0f] safe-x">
      {/* Header */}
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

      {/* Main content — stacks vertically on mobile, side-by-side on desktop */}
      <main className="flex-1 flex flex-col lg:flex-row gap-2.5 lg:gap-4 p-2.5 sm:p-4 max-w-7xl mx-auto w-full">
        {/* Primary: Canvas + Controls */}
        <div className="flex-1 flex flex-col gap-2.5 sm:gap-3 min-w-0">
          <CanvasView />
          <PlaybackControls />

          {/* Media loaders — kept on one row at every width so they take as
              little vertical space as possible and the canvas gets the rest */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <MediaLoader slot="A" />
            <MediaLoader slot="B" />
          </div>

          {/* Swap button */}
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
        </div>

        {/* Secondary: Collapsible sidebar — full width below content on mobile */}
        {!sidebarCollapsed && (
          <div className="w-full lg:w-64 flex flex-col gap-3 flex-shrink-0">
            {/* Mask Controls — collapsible */}
            <CollapsibleSection
              title="Mask Settings"
              open={!maskCollapsed}
              onToggle={() => setMaskCollapsed(!maskCollapsed)}
            >
              <MaskControls />
            </CollapsibleSection>

            {/* Favorites — collapsible */}
            <CollapsibleSection
              title="Saved Combos"
              open={!favoritesCollapsed}
              onToggle={() => setFavoritesCollapsed(!favoritesCollapsed)}
            >
              <FavoriteList />
            </CollapsibleSection>
          </div>
        )}
      </main>

      {/* Footer */}
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
            Mobile power saving on · render capped to 1.5× DPR / 720p
          </p>
        )}
      </footer>
    </div>
  )
}
