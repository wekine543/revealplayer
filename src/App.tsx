import { useState } from 'react'
import { CanvasView } from './components/CanvasView'
import { MediaLoader } from './components/MediaLoader'
import { PlaybackControls } from './components/PlaybackControls'
import { MaskControls } from './components/MaskControls'
import { FavoriteButton } from './components/FavoriteButton'
import { FavoriteList } from './components/FavoriteList'
import { useStore } from './store/useStore'

/** Collapsible section wrapper */
function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl bg-white/5 border border-white/5 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
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
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const swapMedia = useStore((s) => s.swapMedia)
  const mediaA = useStore((s) => s.mediaA)
  const mediaB = useStore((s) => s.mediaB)

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0b0f]">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          {/* Logo */}
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </div>
          <span className="text-base font-bold text-white tracking-tight">RevealPlayer</span>
          <span className="text-xs text-gray-600 ml-2 hidden sm:inline">Media Overlay Player</span>
        </div>

        <div className="flex items-center gap-2">
          <FavoriteButton />
          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
            title={sidebarOpen ? 'Hide panel' : 'Show panel'}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            {sidebarOpen ? 'Hide Panel' : 'Show Panel'}
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex gap-4 p-4 max-w-7xl mx-auto w-full">
        {/* Left: Canvas + Controls */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          <CanvasView />
          <PlaybackControls />

          {/* Media loaders side by side */}
          <div className="grid grid-cols-2 gap-3">
            <MediaLoader slot="A" />
            <MediaLoader slot="B" />
          </div>

          {/* Swap button */}
          <div className="flex justify-center">
            <button
              onClick={swapMedia}
              disabled={!mediaA || !mediaB}
              className="flex items-center gap-1.5 text-xs px-4 py-2 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m4 4H8m0 0l4-4m-4 4l4 4" />
              </svg>
              Swap A / B
            </button>
          </div>
        </div>

        {/* Right: Collapsible sidebar */}
        {sidebarOpen && (
          <div className="w-64 flex flex-col gap-3 flex-shrink-0">
            {/* Mask Controls — collapsible */}
            <CollapsibleSection title="Mask Settings">
              <MaskControls />
            </CollapsibleSection>

            {/* Favorites — collapsible */}
            <CollapsibleSection title="Saved Combos" defaultOpen={true}>
              <FavoriteList />
            </CollapsibleSection>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="px-5 py-2 border-t border-white/5">
        <p className="text-xs text-gray-600 text-center">
          Move mouse over the canvas to reveal Media B through Media A · Scroll to adjust mask radius
        </p>
      </footer>
    </div>
  )
}
