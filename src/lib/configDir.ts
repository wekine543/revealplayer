/**
 * The config folder — a real directory on disk that owns the combos.
 *
 * Why this exists: combos used to live only in IndexedDB, which means clearing
 * browser data wipes them and there is no way to hand them to another machine.
 * With a config folder the media files and a plain JSON sit together in a
 * directory the user chose, so the whole set can be copied to a USB stick,
 * opened on another device, and picked up from there.
 *
 * Built on the File System Access API. Two constraints shape the code:
 *  - It is Chromium-only, and unavailable on `file://` (SecurityError). The
 *    double-click-the-HTML mode therefore cannot use it; see isSupported().
 *  - Directory handles survive a reload only via IndexedDB, and the permission
 *    has to be re-checked on every start. Both are handled in initConfigDir().
 */
import type { ConfigFile, MaskSettings, MediaItem, MediaRef } from '../types'
import { loadLocalFile, loadUrlMedia } from './media'
import {
  clearConfigDirHandle,
  getBlob,
  loadConfigDirHandle,
  saveConfigDirHandle,
} from './db'

/** Name of the JSON inside the config folder. */
export const CONFIG_FILE_NAME = 'revealplayer.config.json'
/** Media copied into the folder lands here, referenced by relative path. */
const MEDIA_DIR = 'media'
/** Mask edits are debounced so dragging a slider does not hammer the disk. */
const MASK_SYNC_DELAY = 800

/**
 * - `loading`          — start-up check not finished yet
 * - `unsupported`      — browser or protocol cannot do this (file://, Firefox…)
 * - `needs-pick`       — no folder ever chosen (or permission denied before)
 * - `needs-permission` — folder known, but the grant expired; a click re-asks
 * - `idle`             — user skipped / disconnected; combos stay in IndexedDB
 * - `ready`            — folder open, combos come from the JSON
 */
export type ConfigStatus =
  | 'loading'
  | 'unsupported'
  | 'needs-pick'
  | 'needs-permission'
  | 'idle'
  | 'ready'

// ---- Minimal File System Access API types ----
// Declared locally rather than taken from lib.dom: the shapes vary between TS
// versions, and `showDirectoryPicker` is not typed at all.

interface FsWritable {
  write(data: Blob | string): Promise<void>
  close(): Promise<void>
}

interface FsFileHandle {
  getFile(): Promise<File>
  createWritable(): Promise<FsWritable>
}

interface FsDirHandle {
  name: string
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirHandle>
}

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: string }) => Promise<FsDirHandle>
}

// ---- Module state ----

let dirHandle: FsDirHandle | null = null
let status: ConfigStatus = 'loading'
let cache: ConfigFile | null = null
let maskTimer: ReturnType<typeof setTimeout> | null = null

/**
 * False on `file://` and on browsers without the API. Checked up front so we
 * never raise a SecurityError the user cannot act on.
 */
export function isSupported(): boolean {
  if (typeof window === 'undefined') return false
  if (window.location.protocol === 'file:') return false
  return typeof (window as PickerWindow).showDirectoryPicker === 'function'
}

export function getStatus(): ConfigStatus {
  return status
}

export function getDirName(): string | null {
  return dirHandle?.name ?? null
}

/** True when combos and mask settings should be read from / written to disk. */
export function isActive(): boolean {
  return status === 'ready' && dirHandle !== null
}

function requireHandle(): FsDirHandle {
  if (!dirHandle) throw new Error('Config folder is not connected')
  return dirHandle
}

/**
 * IndexedDB can be unavailable (private mode, blocked storage) and in some
 * cases its request simply never settles. Waiting on it forever would leave the
 * config status stuck on `loading` and the user would never get the picker, so
 * every storage round-trip is bounded.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const finish = (value: T) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    setTimeout(() => finish(fallback), ms)
    promise.then(finish, () => finish(fallback))
  })
}

const STORAGE_TIMEOUT_MS = 3000

function emptyConfig(): ConfigFile {
  return { version: 1, updatedAt: Date.now(), maskSettings: null, combos: [] }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---- Folder plumbing ----

/**
 * Resolve `media/clip.mp4` inside the folder, creating parent dirs if asked.
 *
 * Returns null — never throws — when any part of the path is missing. The
 * parent lookups are guarded too: `media/` does not exist until the first save,
 * and an unguarded `getDirectoryHandle('media', { create: false })` rejects with
 * NotFoundError, which used to abort every first save.
 */
async function getFileAt(
  dir: FsDirHandle,
  relPath: string,
  create = false,
): Promise<FsFileHandle | null> {
  const parts = relPath.split('/').filter(Boolean)
  if (parts.length === 0) return null
  let d = dir
  try {
    for (let i = 0; i < parts.length - 1; i++) {
      d = await d.getDirectoryHandle(parts[i], { create })
    }
    return await d.getFileHandle(parts[parts.length - 1], { create })
  } catch {
    return null
  }
}

async function writeText(relPath: string, text: string): Promise<void> {
  const handle = await getFileAt(requireHandle(), relPath, true)
  if (!handle) throw new Error(`Cannot create file: ${relPath}`)
  const writable = await handle.createWritable()
  try {
    await writable.write(text)
  } finally {
    await writable.close()
  }
}

// ---- Config file ----

export async function readConfig(): Promise<ConfigFile> {
  const handle = await getFileAt(requireHandle(), CONFIG_FILE_NAME)
  if (!handle) {
    // First use of this folder — start it off with an empty config.
    const fresh = emptyConfig()
    await writeConfig(fresh)
    return fresh
  }
  const file = await handle.getFile()
  const text = await file.text()
  let parsed: Partial<ConfigFile>
  try {
    parsed = JSON.parse(text) as Partial<ConfigFile>
  } catch {
    // A truncated or hand-edited file must not brick the app: fall back to an
    // empty config rather than throwing on every read.
    console.warn('[RevealPlayer] config file is not valid JSON — starting empty')
    return emptyConfig()
  }
  const cfg: ConfigFile = {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    maskSettings: parsed.maskSettings ?? null,
    combos: Array.isArray(parsed.combos) ? parsed.combos : [],
  }
  cache = cfg
  return cfg
}

export async function writeConfig(cfg: ConfigFile): Promise<void> {
  cfg.updatedAt = Date.now()
  await writeText(CONFIG_FILE_NAME, JSON.stringify(cfg, null, 2))
  cache = cfg
}

/** Debounced write used by the mask sliders. */
export function scheduleMaskSync(mask: MaskSettings): void {
  if (!isActive()) return
  if (maskTimer) clearTimeout(maskTimer)
  maskTimer = setTimeout(() => {
    maskTimer = null
    void (async () => {
      try {
        const cfg = cache ?? (await readConfig())
        cfg.maskSettings = { ...mask }
        await writeConfig(cfg)
      } catch (e) {
        console.warn('[RevealPlayer] could not sync mask settings:', errText(e))
      }
    })()
  }, MASK_SYNC_DELAY)
}

// ---- Media files ----

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned : 'media'
}

/** media/clip.mp4 → media/clip (2).mp4, then (3), … */
function withSuffix(relPath: string, n: number): string {
  const dot = relPath.lastIndexOf('.')
  if (dot <= relPath.lastIndexOf('/')) return `${relPath} (${n})`
  return `${relPath.slice(0, dot)} (${n})${relPath.slice(dot)}`
}

async function writeBlobOnce(dir: FsDirHandle, relPath: string, blob: Blob): Promise<void> {
  const handle = await getFileAt(dir, relPath, true)
  if (!handle) throw new Error(`Cannot create media file: ${relPath}`)
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
  } finally {
    await writable.close()
  }
}

/**
 * Put a media item's bytes into the folder and return the ref that points at
 * them.
 *
 * - Already in the folder (`configPath` set) → reused as is.
 * - Remote URL → left remote. A URL is reachable from any device already, so
 *   downloading it would only waste space.
 * - Local file → copied under `media/`.
 *
 * An existing file is only reused when its size matches, and writes never
 * overwrite: a clip that is playing right now can be locked by the OS, and
 * clobbering a file another combo still points at would silently corrupt it.
 * Collisions get a `(2)` suffix instead.
 *
 * Note this copies rather than moves: the browser never had write access to the
 * original location, so it cannot delete the source file.
 */
export async function ensureMediaInFolder(m: MediaItem | null): Promise<MediaRef | null> {
  if (!m) return null

  if (m.configPath) {
    return { type: m.type, source: 'local', fileName: m.fileName, configPath: m.configPath }
  }

  if (m.source === 'url') {
    return { type: m.type, source: 'url', url: m.url, fileName: m.fileName }
  }

  const dir = requireHandle()
  const fileName = m.fileName
    ? safeFileName(m.fileName)
    : `${m.type === 'video' ? 'video' : 'image'}_${Date.now()}.${m.type === 'video' ? 'mp4' : 'png'}`
  const basePath = `${MEDIA_DIR}/${fileName}`

  // Prefer the blob we already stored; fall back to re-reading the object URL.
  let blob: Blob | undefined
  if (m.blobId) blob = await getBlob(m.blobId)
  if (!blob) blob = await (await fetch(m.url)).blob()

  // Reuse a byte-identical copy (same name, same size) instead of storing twice.
  for (let n = 1; n <= 20; n++) {
    const relPath = n === 1 ? basePath : withSuffix(basePath, n)
    const existing = await getFileAt(dir, relPath)
    if (!existing) {
      // Windows can refuse a write while the file is open elsewhere, so a
      // failure is retried on the next free name before giving up.
      try {
        await writeBlobOnce(dir, relPath, blob)
      } catch (e) {
        if (n === 20) throw e
        console.warn(`[RevealPlayer] retrying media copy after: ${errText(e)}`)
        continue
      }
      return { type: m.type, source: 'local', fileName, configPath: relPath }
    }
    const file = await existing.getFile()
    if (file.size === blob.size) {
      return { type: m.type, source: 'local', fileName, configPath: relPath }
    }
  }

  throw new Error(`Cannot find a free name for ${fileName}`)
}

/**
 * Read raw bytes out of the folder. Used for combo thumbnails, which need the
 * file itself rather than a decoded MediaItem.
 */
export async function readMediaFile(relPath: string): Promise<File | null> {
  const handle = await getFileAt(requireHandle(), relPath)
  if (!handle) return null
  return await handle.getFile()
}

/** Read a file back out of the folder and turn it into a playable item. */
export async function loadMediaFromConfig(ref: MediaRef): Promise<MediaItem | null> {
  if (ref.configPath) {
    const handle = await getFileAt(requireHandle(), ref.configPath)
    if (!handle) {
      console.warn(`[RevealPlayer] media missing in config folder: ${ref.configPath}`)
      return null
    }
    const file = await handle.getFile()
    const item = await loadLocalFile(file)
    // Remember where it came from, so re-saving the combo does not copy it twice.
    item.configPath = ref.configPath
    return item
  }
  if (ref.source === 'url' && ref.url) return await loadUrlMedia(ref.url)
  return null
}

// ---- Connection lifecycle ----

/** Ask the user to choose (or re-choose) the folder. Must run on a user gesture. */
export async function pickConfigDir(): Promise<{ ok: boolean; message?: string }> {
  if (!isSupported()) {
    status = 'unsupported'
    return { ok: false, message: 'unsupported' }
  }
  try {
    const picker = (window as PickerWindow).showDirectoryPicker
    if (!picker) {
      status = 'unsupported'
      return { ok: false, message: 'unsupported' }
    }
    // `id` makes the browser reopen the same folder by default next time.
    const handle = await picker.call(window, { id: 'revealplayer-config', mode: 'readwrite' })
    const permission = await handle.requestPermission({ mode: 'readwrite' })
    if (permission !== 'granted') {
      status = 'needs-permission'
      return { ok: false, message: '需要授权才能读写该文件夹' }
    }
    dirHandle = handle
    await saveConfigDirHandle(handle)
    await readConfig()
    status = 'ready'
    return { ok: true }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, message: 'cancelled' }
    }
    return { ok: false, message: errText(e) }
  }
}

/** Re-ask for a folder we already know, after the browser dropped the grant. */
export async function reconnectConfigDir(): Promise<{ ok: boolean; message?: string }> {
  if (!dirHandle) return pickConfigDir()
  try {
    const permission = await dirHandle.requestPermission({ mode: 'readwrite' })
    if (permission !== 'granted') {
      status = 'needs-permission'
      return { ok: false, message: '需要授权才能读写该文件夹' }
    }
    await readConfig()
    status = 'ready'
    return { ok: true }
  } catch (e) {
    return { ok: false, message: errText(e) }
  }
}

/**
 * Start-up check: restore the handle and see whether it is still usable.
 * Never prompts by itself — the browser only allows that from a gesture, so the
 * UI shows a button when the result is `needs-pick` / `needs-permission`.
 */
export async function initConfigDir(): Promise<ConfigStatus> {
  if (!isSupported()) {
    status = 'unsupported'
    return status
  }
  const stored = await withTimeout(
    loadConfigDirHandle().catch((e: unknown) => {
      console.warn('[RevealPlayer] cannot read stored config folder:', errText(e))
      return undefined
    }),
    STORAGE_TIMEOUT_MS,
    undefined,
  )
  if (!stored) {
    status = 'needs-pick'
    return status
  }
  const handle = stored as FsDirHandle
  dirHandle = handle
  try {
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    if (permission !== 'granted') {
      status = 'needs-permission'
      return status
    }
    await readConfig()
    status = 'ready'
  } catch (e) {
    console.warn('[RevealPlayer] config folder became unreadable:', errText(e))
    status = 'needs-pick'
  }
  return status
}

/** Forget the folder entirely, including the stored handle. */
export async function disconnectConfigDir(): Promise<void> {
  status = 'idle'
  cache = null
  dirHandle = null
  try {
    await clearConfigDirHandle()
  } catch (e) {
    console.warn('[RevealPlayer] could not forget the config folder:', errText(e))
  }
}
