/**
 * Where combos are stored, whichever backing store is in play.
 *
 * - `server` — on the machine running the dev server. The only one that works
 *   on a phone, since it needs nothing but fetch.
 * - `config` — a folder on this device, via the File System Access API.
 * - `browser` — IndexedDB, so `file://` (which can use neither) still works.
 *
 * Callers never branch on the source — they call these functions.
 */
import type { ConfigFile, FavoriteItem, MaskSettings, MediaItem, MediaRef } from '../types'
import {
  deleteFavorite,
  getBlob,
  getFavorites as getFavoritesFromDb,
  renameFavorite,
  saveFavorite,
} from './db'
import * as configDir from './configDir'
import * as serverStore from './serverStore'
import { loadLocalFile, loadUrlMedia } from './media'

export type FavoritesSource = 'server' | 'config' | 'browser'

export function favoritesSource(): FavoritesSource {
  if (serverStore.isActive()) return 'server'
  if (configDir.isActive()) return 'config'
  return 'browser'
}

/** Wait until the server probe has settled, so the backend is not a guess. */
export async function ready(): Promise<void> {
  await serverStore.probe()
}

function sortByNewest(combos: FavoriteItem[]): FavoriteItem[] {
  return [...combos].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Mutations run one at a time.
 *
 * Both file-backed stores are read-modify-write, and two overlapping ones lose
 * an update: star a combo while another combo's A→B skew is being written back
 * and whichever read last writes a list that predates the other. It takes two
 * quick clicks to hit — which is exactly what a star invites — so they queue
 * here rather than relying on the user to be slow. Each task still reads the
 * config when its turn comes, so nothing is written from a stale snapshot.
 *
 * Reads are deliberately not serialized: they must stay responsive while a
 * write is in flight, and a read cannot lose anything.
 */
let writeQueue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task)
  // Keep the chain alive after a failure, or every later write would reject too.
  writeQueue = run.catch(() => undefined)
  return run
}

/** Read-modify-write against the config file, returning the new combo list. */
async function updateConfig(mutate: (cfg: ConfigFile) => void): Promise<FavoriteItem[]> {
  const cfg = await configDir.readConfig()
  mutate(cfg)
  await configDir.writeConfig(cfg)
  return sortByNewest(cfg.combos)
}

function toRef(m: MediaItem | null): MediaRef | null {
  if (!m) return null
  return {
    type: m.type,
    source: m.source,
    url: m.source === 'url' ? m.url : undefined,
    blobId: m.blobId,
    fileName: m.fileName,
    configPath: m.configPath,
  }
}

export async function listFavorites(): Promise<FavoriteItem[]> {
  await ready()
  if (serverStore.isActive()) {
    const cfg = await serverStore.readConfig()
    return sortByNewest(cfg.combos)
  }
  if (configDir.isActive()) {
    const cfg = await configDir.readConfig()
    return sortByNewest(cfg.combos)
  }
  return await getFavoritesFromDb()
}

export interface SaveComboArgs {
  name: string
  mediaA: MediaItem | null
  mediaB: MediaItem | null
  maskSettings: MaskSettings
  /** Intentional A→B skew, in seconds. Positive = B ahead. */
  bOffset?: number
}

/**
 * Store a new combo. Returns the whole list plus the new entry's id, which the
 * caller needs: the pair on screen is now "that combo", so later tweaks — the
 * A→B skew above all — are written back to it.
 */
export async function addFavorite(
  args: SaveComboArgs,
): Promise<{ list: FavoriteItem[]; id: string }> {
  return await serialize(() => addFavoriteNow(args))
}

async function addFavoriteNow(
  args: SaveComboArgs,
): Promise<{ list: FavoriteItem[]; id: string }> {
  const { mediaA, mediaB, maskSettings } = args
  const item: FavoriteItem = {
    id: `fav_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    name: args.name.trim() || `Combo ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    mediaA: null,
    mediaB: null,
    maskSettings: { ...maskSettings },
    bOffset: args.bOffset ?? 0,
  }

  if (serverStore.isActive()) {
    item.mediaA = await serverStore.ensureMedia(mediaA)
    item.mediaB = await serverStore.ensureMedia(mediaB)
    const cfg = await serverStore.readConfig()
    const combos = [item, ...cfg.combos]
    await serverStore.writeConfig(combos)
    return { list: sortByNewest(combos), id: item.id }
  }

  if (configDir.isActive()) {
    // Copying the files here is what makes the combo survive a cache clear and
    // follow the folder to another machine.
    item.mediaA = await configDir.ensureMediaInFolder(mediaA)
    item.mediaB = await configDir.ensureMediaInFolder(mediaB)
    const list = await updateConfig((cfg) => {
      cfg.combos.unshift(item)
    })
    return { list, id: item.id }
  }

  item.mediaA = toRef(mediaA)
  item.mediaB = toRef(mediaB)
  await saveFavorite(item)
  return { list: await listFavorites(), id: item.id }
}

/**
 * Patch a stored combo in place — currently used for the A→B offset, which is
 * written back the moment it is adjusted rather than on a separate save action.
 *
 * Only the named fields are touched, so this never disturbs the media refs the
 * combo was built from.
 */
export async function updateFavorite(
  id: string,
  patch: Partial<FavoriteItem>,
): Promise<FavoriteItem[]> {
  return await serialize(() => updateFavoriteNow(id, patch))
}

async function updateFavoriteNow(
  id: string,
  patch: Partial<FavoriteItem>,
): Promise<FavoriteItem[]> {
  if (serverStore.isActive()) {
    const cfg = await serverStore.readConfig()
    const combos = cfg.combos.map((c) => (c.id === id ? { ...c, ...patch } : c))
    await serverStore.writeConfig(combos)
    return sortByNewest(combos)
  }
  if (configDir.isActive()) {
    return await updateConfig((cfg) => {
      const target = cfg.combos.find((c) => c.id === id)
      if (target) Object.assign(target, patch)
    })
  }
  const all = await getFavoritesFromDb()
  const item = all.find((c) => c.id === id)
  if (item) await saveFavorite({ ...item, ...patch })
  return await listFavorites()
}

/** The skew recorded for a combo, treating an absent field as level. */
export function comboOffset(fav: FavoriteItem): number {
  return typeof fav.bOffset === 'number' && isFinite(fav.bOffset) ? fav.bOffset : 0
}

/** The star on a combo, treating an absent field as unstarred. */
export function isStarred(fav: FavoriteItem): boolean {
  return fav.starred === true
}

/**
 * Set (or clear) the star on one combo. Goes through the same patch path as the
 * A→B skew, so it works against whichever backend is live — including the
 * server store, which is what lets a phone star a combo and have the desktop
 * see it.
 */
export async function setStarred(id: string, starred: boolean): Promise<FavoriteItem[]> {
  return await updateFavorite(id, { starred })
}

export async function removeFavorite(id: string): Promise<FavoriteItem[]> {
  return await serialize(() => removeFavoriteNow(id))
}

async function removeFavoriteNow(id: string): Promise<FavoriteItem[]> {
  if (serverStore.isActive()) {
    const cfg = await serverStore.readConfig()
    const combos = cfg.combos.filter((c) => c.id !== id)
    await serverStore.writeConfig(combos)
    return sortByNewest(combos)
  }
  if (configDir.isActive()) {
    return await updateConfig((cfg) => {
      cfg.combos = cfg.combos.filter((c) => c.id !== id)
    })
  }
  await deleteFavorite(id)
  return await listFavorites()
}

export async function renameFavoriteEntry(id: string, name: string): Promise<FavoriteItem[]> {
  return await serialize(() => renameFavoriteEntryNow(id, name))
}

async function renameFavoriteEntryNow(id: string, name: string): Promise<FavoriteItem[]> {
  if (serverStore.isActive()) {
    const cfg = await serverStore.readConfig()
    const combos = cfg.combos.map((c) => (c.id === id ? { ...c, name } : c))
    await serverStore.writeConfig(combos)
    return sortByNewest(combos)
  }
  if (configDir.isActive()) {
    return await updateConfig((cfg) => {
      const target = cfg.combos.find((c) => c.id === id)
      if (target) target.name = name
    })
  }
  await renameFavorite(id, name)
  return await listFavorites()
}

/**
 * Turn a stored ref back into something the engine can play.
 *
 * `configPath` (`media/clip.mp4`) is deliberately resolved against whichever
 * backend is live rather than only against the config folder that wrote it:
 * the server store keeps the same layout, so a phone — which cannot use the
 * File System Access API at all — can still play a combo saved on the desktop.
 * The folder is tried as a fallback, so either direction works.
 */
export async function loadFavoriteMedia(ref: MediaRef | null): Promise<MediaItem | null> {
  if (!ref) return null
  await ready()

  const failures: string[] = []

  // In this order: the live backend first, then whatever else might still hold
  // the bytes. A combo can outlive the storage it was written through.
  const attempts: Array<() => Promise<MediaItem | null>> = []

  if (ref.source === 'url' && ref.url) {
    attempts.push(async () => await loadUrlMedia(ref.url as string))
  }

  if (ref.configPath) {
    const rel = ref.configPath
    if (serverStore.isActive()) {
      attempts.push(async () => await loadUrlMedia(serverStore.mediaUrl(rel)))
    }
    if (configDir.isActive()) {
      attempts.push(async () => await configDir.loadMediaFromConfig({ ...ref, configPath: rel }))
    }
    // Neither backend is connected, but the ref still names a file the server
    // may be able to serve — worth one try before giving up.
    if (!serverStore.isActive() && serverStore.isAvailable()) {
      attempts.push(async () => await loadUrlMedia(serverStore.mediaUrl(rel)))
    }
  }

  if (ref.blobId) {
    attempts.push(async () => {
      const blob = await getBlob(ref.blobId as string)
      if (!blob) throw new Error('this device does not have the file anymore')
      const file = new File([blob], ref.fileName ?? 'unknown', { type: blob.type })
      return await loadLocalFile(file)
    })
  }

  for (const attempt of attempts) {
    try {
      const item = await attempt()
      if (item) return item
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      failures.push(message)
      console.warn('[RevealPlayer] combo media source failed:', message)
    }
  }

  if (failures.length > 0) {
    throw new Error(`无法加载「${ref.fileName ?? '媒体'}」：${failures[0]}`)
  }

  console.warn(
    '[RevealPlayer] combo media cannot be reached — no storage that holds it is connected',
    ref,
  )
  return null
}
