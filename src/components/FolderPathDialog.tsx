import { useEffect, useState } from 'react'
import { fsFindDir, fsList, type FsListing } from '../lib/localFs'

/**
 * One-time setup for "click the folder name to open it in Explorer".
 *
 * The browser only knows the folder's name, never its path, so the path is
 * discovered here: the dev server searches a few likely roots and lists what it
 * finds, and if that is not enough the user can browse or paste a path. The
 * choice is remembered, after which clicking the name opens the folder directly.
 */
export function FolderPathDialog({
  title,
  hint,
  searchName = null,
  confirmLabel = '打开这个文件夹',
  onPick,
  onClose,
}: {
  title: string
  hint: string
  /** When set, the server searches for a folder with this name up front. */
  searchName?: string | null
  confirmLabel?: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [matches, setMatches] = useState<string[]>([])
  const [searching, setSearching] = useState(true)
  const [current, setCurrent] = useState<string | null>(null)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [manual, setManual] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = async (target: string | null) => {
    try {
      setListing(await fsList(target))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const found = searchName ? await fsFindDir(searchName).catch(() => []) : []
      if (!alive) return
      setMatches(found)
      setSearching(false)
      if (found.length === 0) await load(null)
    })()
    return () => {
      alive = false
    }
    // Runs once per open; `load` is stable enough for this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchName])

  const enter = async (target: string) => {
    setCurrent(target)
    setManual(target)
    await load(target)
  }

  const selected = manual.trim() || current || ''

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 px-4">
      <div className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl bg-[#15161c] border border-white/10 shadow-2xl">
        <div className="p-5 pb-3">
          <h2 className="text-sm font-bold text-white">{title}</h2>
          <p className="mt-1.5 text-[11px] text-gray-400 leading-relaxed">{hint}</p>
        </div>

        <div className="px-5 pb-4 flex-1 min-h-0 overflow-y-auto rp-scrollbar space-y-3">
          {/* Auto-detected candidates */}
          {searching ? (
            <p className="text-[11px] text-gray-500">正在查找…</p>
          ) : matches.length > 0 ? (
            <div>
              <p className="text-[11px] text-gray-500 mb-1.5">找到 {matches.length} 个同名文件夹：</p>
              <div className="space-y-1">
                {matches.map((p) => (
                  <button
                    key={p}
                    onClick={() => setManual(p)}
                    className={`w-full text-left text-[11px] px-2 py-1.5 rounded truncate transition-colors ${
                      manual === p
                        ? 'bg-brand-500/20 text-brand-200 border border-brand-400/40'
                        : 'bg-white/5 hover:bg-white/10 text-gray-300'
                    }`}
                    title={p}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Manual path */}
          <div>
            <p className="text-[11px] text-gray-500 mb-1.5">或手动浏览 / 输入路径：</p>
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="D:\RevealConfig"
              className="w-full text-[11px] px-2 py-1.5 rounded-md bg-black/30 border border-white/10 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-400"
            />
          </div>

          {/* Browser */}
          {listing && (
            <div className="rounded-md border border-white/10 bg-black/20">
              <div className="flex items-center gap-1 px-2 py-1.5 border-b border-white/5">
                {current && (
                  <button
                    onClick={() => {
                      setCurrent(null)
                      setManual('')
                      void load(null)
                    }}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-gray-400"
                  >
                    ← 上层
                  </button>
                )}
                <span className="flex-1 min-w-0 text-[11px] text-gray-500 truncate">
                  {current ?? '根目录'}
                </span>
              </div>
              <div className="max-h-52 overflow-y-auto rp-scrollbar p-1">
                {listing.dirs.length === 0 ? (
                  <p className="text-[11px] text-gray-600 py-2 text-center">没有子文件夹</p>
                ) : (
                  listing.dirs.map((d) => (
                    <button
                      key={d.path}
                      onClick={() => void enter(d.path)}
                      className="w-full flex items-center gap-1.5 text-left text-[11px] px-2 py-1 rounded hover:bg-white/10 text-gray-300"
                    >
                      <svg className="w-3 h-3 flex-shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5z" />
                      </svg>
                      <span className="truncate">{d.name}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {error && <p className="text-[11px] text-red-400">{error}</p>}
        </div>

        <div className="p-4 pt-3 border-t border-white/5 flex gap-2">
          <button
            onClick={() => selected && onPick(selected)}
            disabled={!selected}
            className="flex-1 text-xs py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {confirmLabel}
          </button>
          <button
            onClick={onClose}
            className="text-xs px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 transition-colors"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
