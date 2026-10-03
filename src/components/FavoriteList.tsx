import { useCallback, useEffect, useState, useMemo } from 'react'
import { useStore } from '../store/useStore'
import {
  listFavorites,
  loadFavoriteMedia,
  removeFavorite,
  renameFavoriteEntry,
  favoritesSource,
  comboOffset,
  isStarred,
  setStarred,
} from '../lib/favorites'
import { formatOffset } from '../lib/timeOffset'
import { ConfigDirBar } from './ConfigDirBar'
import { ComboThumb } from './ComboThumb'
import type { FavoriteItem } from '../types'

export function FavoriteList() {
  const favorites = useStore((s) => s.favorites)
  const setFavorites = useStore((s) => s.setFavorites)
  const setMediaA = useStore((s) => s.setMediaA)
  const setMediaB = useStore((s) => s.setMediaB)
  const loadComboSettings = useStore((s) => s.loadComboSettings)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [search, setSearch] = useState('')
  /**
   * "Only the starred ones". Kept in the component rather than persisted: it is
   * a way of looking at the list right now, and a remembered filter would make
   * the panel come back mysteriously short on the next visit.
   */
  const [starredOnly, setStarredOnly] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  // Surfaced in the panel rather than only in the console: on a phone there is
  // no devtools to open, and a silent failure just looks like a dead button.
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The list itself could not be read — different from "there are none". */
  const [listError, setListError] = useState<string | null>(null)

  // Load favorites on mount, and again whenever the backing store changes
  // (config folder connected, swapped or disconnected).
  /**
   * A failed list read must not be shown as "you have no combos": that reads
   * as data loss, and the usual cause is one request that did not get through.
   * The error and a way back are put in the panel instead.
   */
  const reload = useCallback(() => {
    setListError(null)
    listFavorites()
      .then(setFavorites)
      .catch((e: unknown) => {
        console.error('[RevealPlayer] could not list combos:', e)
        setListError(e instanceof Error ? e.message : String(e))
      })
  }, [setFavorites])
  useEffect(() => {
    reload()
  }, [reload])

  // Filter favorites by search, and by the star when that filter is on.
  const filtered = useMemo(() => {
    let list = favorites
    if (starredOnly) list = list.filter(isStarred)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q))
    return list
  }, [favorites, search, starredOnly])

  const starCount = useMemo(() => favorites.filter(isStarred).length, [favorites])

  /**
   * The star flips in place first and is written afterwards, because on a phone
   * the round-trip to the server store is long enough that waiting for it makes
   * the tap feel dropped. The write's own list replaces it once it lands.
   */
  const toggleStar = (fav: FavoriteItem) => {
    const next = !isStarred(fav)
    setFavorites(
      useStore.getState().favorites.map((f) => (f.id === fav.id ? { ...f, starred: next } : f)),
    )
    setStarred(fav.id, next).then(setFavorites, (e: unknown) => {
      console.warn('[RevealPlayer] could not save the star:', e)
      reload()
    })
  }

  const loadFavorite = async (fav: FavoriteItem) => {
    setLoadError(null)
    setLoadingId(fav.id)
    try {
      const mediaA = await loadFavoriteMedia(fav.mediaA)
      const mediaB = await loadFavoriteMedia(fav.mediaB)

      if (!mediaA && !mediaB) {
        setLoadError(
          `「${fav.name}」的媒体文件都取不到。服务端存储需要在电脑上运行 RevealPlayer-LAN.bat，且手机要连同一个 Wi-Fi。`,
        )
      }
      setMediaA(mediaA)
      setMediaB(mediaB)
      // Both the mask and the A→B skew travel with the combo. Called after the
      // media setters on purpose: those clear `activeFavoriteId` by design,
      // because media dropped into A/B is nobody's combo until this says whose.
      loadComboSettings(fav)
    } catch (e) {
      console.error('Failed to load favorite:', e)
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingId(null)
    }
  }

  const handleDelete = async (id: string) => {
    setFavorites(await removeFavorite(id))
  }

  const handleRename = async (id: string) => {
    if (!editName.trim()) {
      setEditingId(null)
      return
    }
    setFavorites(await renameFavoriteEntry(id, editName.trim()))
    setEditingId(null)
    setEditName('')
  }

  if (favorites.length === 0) {
    return (
      <div className="space-y-2">
        <ConfigDirBar onChanged={reload} />
        {listError ? (
          <div className="py-3 space-y-2 text-center">
            <p className="text-xs text-red-400 leading-relaxed">读取收藏失败：{listError}</p>
            <button
              onClick={reload}
              className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
            >
              重试
            </button>
          </div>
        ) : (
          <p className="text-xs text-gray-600 py-4 text-center">
            {favoritesSource() === 'browser'
              ? 'No saved combos yet. Load media and save a combination to see it here.'
              : '这里还没有组合。加载媒体后点 Save Combo 保存。'}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <ConfigDirBar onChanged={reload} />

      {/* Search box, with the star filter beside it. The star is the point of
          the mark: getting back to a handful of combos in one click rather than
          scrolling a long list. */}
      <div className="flex items-center gap-1.5 mb-2">
        <div className="relative flex-1 min-w-0">
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search combos..."
            className="w-full text-xs pl-7 pr-2 py-1.5 rounded-md bg-black/30 border border-white/10 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-brand-400"
          />
        </div>
        <button
          onClick={() => setStarredOnly((v) => !v)}
          aria-pressed={starredOnly}
          title={starredOnly ? '显示全部组合' : '只看加星标的组合'}
          className={`flex items-center gap-1 px-2 py-1.5 rounded-md border text-xs tabular-nums transition-colors ${
            starredOnly
              ? 'bg-amber-400/20 border-amber-400/40 text-amber-300'
              : 'bg-black/30 border-white/10 text-gray-400 hover:text-amber-300 hover:border-amber-400/30'
          }`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={starredOnly ? 'currentColor' : 'none'} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11.48 3.5a.56.56 0 011.04 0l2.13 5.11 5.52.44a.56.56 0 01.32.99l-4.2 3.6 1.28 5.39a.56.56 0 01-.84.61L12 16.8l-4.73 2.84a.56.56 0 01-.84-.61l1.28-5.39-4.2-3.6a.56.56 0 01.32-.99l5.52-.44z" />
          </svg>
          {starCount}
        </button>
      </div>

      {/* Card grid — the picture is its own block, the name sits below it.
          The wrapper establishes the container query: the grid inside is not
          allowed to query itself, so the rules live on the parent. */}
      <div className="rp-combos-container">
      {/* Height: capped in the stacked layouts, where the list is one more block
          in a scrolling page; unbounded in the three-column layout, where the
          panel body above it is the scroller. */}
      <div className="rp-combo-grid max-h-[340px] lg:landscape:max-h-none min-h-[140px] overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-600 py-2 text-center">
            {starredOnly && starCount === 0
              ? '还没有加星标的组合 —— 点卡片右上角的星标标出常用的几个。'
              : 'No matches found.'}
          </p>
        ) : (
          filtered.map((fav) => (
            <div key={fav.id} className="rp-combo-card group">
              {/* Loading the combo: picture first, name underneath. */}
              <button
                onClick={() => loadFavorite(fav)}
                className="w-full text-left"
                title={`${fav.name}\nA · ${fav.mediaA?.fileName ?? '无'}`}
              >
                <div className="relative">
                  <ComboThumb media={fav.mediaA} />
                  {/* The skew travels with the combo, so mark the ones that
                      carry one — an unmarked card is level, not missing it. */}
                  {comboOffset(fav) !== 0 && (
                    <span className="absolute left-1 top-1 rounded bg-black/70 px-1 py-px text-[9px] font-mono text-brand-300">
                      B {formatOffset(comboOffset(fav))}
                    </span>
                  )}
                  {loadingId === fav.id && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-[10px] text-gray-200">
                      加载中…
                    </span>
                  )}
                </div>

                <div className="mt-1.5">
                  <p className="rp-clamp-2 text-[11px] leading-snug text-gray-300 group-hover:text-white break-words">
                    {fav.name}
                  </p>
                </div>
              </button>

              {/* Actions — an overlay rather than a column of icons: always
                  visible on touch, hover-revealed from `lg` up. */}
              {editingId === fav.id ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(fav.id)
                    if (e.key === 'Escape') { setEditingId(null); setEditName('') }
                  }}
                  className="mt-1.5 w-full text-[11px] px-1.5 py-1 rounded bg-black/40 border border-brand-400 text-gray-200 focus:outline-none"
                  autoFocus
                />
              ) : (
                <div className="absolute right-1 top-1 flex flex-col gap-1">
                  {/* The star stays visible at every width and on touch — unlike
                      rename and delete beside it. It is the control *and* the
                      only sign of which combos are marked, so hiding it behind
                      a hover would hide the state with it. */}
                  <button
                    onClick={() => toggleStar(fav)}
                    aria-pressed={isStarred(fav)}
                    className={`p-1 rounded bg-black/70 transition-colors ${
                      isStarred(fav) ? 'text-amber-300' : 'text-gray-300 hover:text-amber-300'
                    }`}
                    title={isStarred(fav) ? '取消星标' : '加星标'}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill={isStarred(fav) ? 'currentColor' : 'none'}
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11.48 3.5a.56.56 0 011.04 0l2.13 5.11 5.52.44a.56.56 0 01.32.99l-4.2 3.6 1.28 5.39a.56.56 0 01-.84.61L12 16.8l-4.73 2.84a.56.56 0 01-.84-.61l1.28-5.39-4.2-3.6a.56.56 0 01.32-.99l5.52-.44z" />
                    </svg>
                  </button>
                  {/* Rename and delete stay hover-revealed from `lg` up, where
                      there is a pointer to reveal them with. */}
                  <div className="flex flex-col gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => { setEditingId(fav.id); setEditName(fav.name) }}
                      className="p-1 rounded bg-black/70 text-gray-300 hover:text-blue-300"
                      title="Rename"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(fav.id)}
                      className="p-1 rounded bg-black/70 text-gray-300 hover:text-red-400"
                      title="Delete"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      </div>

      {loadError && (
        <p className="text-[11px] text-red-400 leading-relaxed bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1.5 break-words">
          {loadError}
        </p>
      )}

      {/* Count */}
      <p className="text-xs text-gray-600 text-right">
        {filtered.length === favorites.length
          ? `${favorites.length} combo${favorites.length !== 1 ? 's' : ''}`
          : `${filtered.length} / ${favorites.length}`}
      </p>
    </div>
  )
}
