/**
 * Combos kept on the machine that runs the dev server.
 *
 * This is the storage backend that works on a phone. The config folder needs
 * the File System Access API, which mobile browsers do not ship and which is
 * disabled on a plain-http LAN address anyway; this backend needs nothing but
 * fetch, so any device that can reach `http://<pc>:5174` gets the whole feature.
 *
 * The directory it writes to is chosen once (and remembered server-side), and
 * holds the same `revealplayer.config.json` + `media/` layout as a config
 * folder, so the two are interchangeable.
 */
import type { FavoriteItem, MaskSettings, MediaItem, MediaRef } from '../types'
import { getBlob } from './db'
import { loadSettings, saveSettings } from './settings'

const BASE = '/__rp/store'

export interface ServerConfig {
  dir: string | null
  combos: FavoriteItem[]
  maskSettings: MaskSettings | null
}

/** null = not probed yet. */
let available: boolean | null = null
let directory: string | null = null
/**
 * The server says it owns the storage (the launcher always does: the folder is
 * chosen in its own UI). Then the page follows it without asking anything.
 */
let managed = false
let maskTimer: ReturnType<typeof setTimeout> | null = null

let probing: Promise<boolean> | null = null

/** A request that never settles must not leave the backend undecided. */
const PROBE_TIMEOUT_MS = 5000

/**
 * Waits before each attempt of the first round. Only a few, and close together:
 * when a server is there it answers in milliseconds.
 *
 * They exist because the very first request a page makes can lose a race — the
 * tab is still downloading a ~900 KB single-file bundle, a phone's radio is
 * waking up, Wi-Fi is re-associating, the server is busy with the page itself.
 * The old code turned one such miss into a verdict for the whole session: the
 * device silently fell back to the empty browser store and stayed there until
 * someone reloaded by hand. On a phone that is indistinguishable from "my
 * combos are gone", which is exactly how it was reported.
 */
const PROBE_ATTEMPTS_MS = [0, 400, 1500]

/**
 * ...and after those, the probe keeps trying in the background, further apart,
 * for the case where the page was simply opened before the server was ready.
 */
const PROBE_RETRY_MS = [6000, 15000, 30000, 45000]
let retryIndex = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The last value handed to subscribers. The first settle is not reported —
 * callers of `probe()` are already awaiting it — so only a real change (in
 * practice: a failure that later turned into a success) wakes anyone up.
 */
let reported: boolean | null = null
const listeners = new Set<(available: boolean) => void>()

/**
 * Told whether the store is (now) usable. Fired when a probe that had failed
 * later succeeds, which is what lets the combos appear without a reload.
 */
export function subscribe(fn: (available: boolean) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function notify(): void {
  const now = available === true
  if (reported === null) {
    reported = now
    return
  }
  if (reported === now) return
  reported = now
  for (const fn of listeners) {
    try {
      fn(now)
    } catch {
      // A listener must not be able to break the probe.
    }
  }
}

/** One request. Never throws — a miss is a boolean, not an exception. */
async function askOnce(): Promise<boolean> {
  try {
    const res = await withTimeout(fetch(`${BASE}/config`, { cache: 'no-store' }), PROBE_TIMEOUT_MS)
    if (!res.ok) return false
    const data = (await res.json()) as Partial<ServerConfig> & { managed?: boolean }
    directory = data.dir ?? null
    managed = data.managed === true
    return true
  } catch {
    return false
  }
}

/**
 * Whether a server is behind this page, cached once it is known.
 *
 * Awaited before anything decides which backend to use: a page can start
 * rendering (and listing combos) before the first fetch has settled, and
 * reading the wrong backend once is enough to show an empty or stale list.
 */
export function probe(): Promise<boolean> {
  if (available === true) return Promise.resolve(true)
  if (!probing) probing = runProbe()
  return probing
}

async function runProbe(): Promise<boolean> {
  for (const wait of PROBE_ATTEMPTS_MS) {
    if (wait > 0) await delay(wait)
    if (await askOnce()) return settleProbe(true)
  }
  return settleProbe(false)
}

function settleProbe(ok: boolean): boolean {
  available = ok
  // Never final: a later probe() — a button, the list loading, the tab coming
  // back to the foreground — is allowed to try again.
  probing = null
  if (ok) {
    retryIndex = 0
    stopRetryTimer()
  } else {
    scheduleRetry()
  }
  notify()
  return ok
}

function stopRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function scheduleRetry(): void {
  if (retryTimer || retryIndex >= PROBE_RETRY_MS.length) return
  const wait = PROBE_RETRY_MS[retryIndex++] as number
  retryTimer = setTimeout(() => {
    retryTimer = null
    void probe()
  }, wait)
}

/**
 * Look again right now, from the start of the schedule. Used by the retry
 * button, and when a backgrounded page comes back to the foreground — a phone
 * that was asleep has just as likely changed networks while it was away.
 */
export function reprobe(): Promise<boolean> {
  if (available === true) return Promise.resolve(true)
  // A round already in flight is already the answer to "look again".
  if (probing) return probing
  retryIndex = 0
  stopRetryTimer()
  return probe()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && available !== true) void reprobe()
  })
}

export function isAvailable(): boolean {
  return available === true
}

/**
 * True when the server owns the storage — the launcher, whose settings screen
 * is where the folder is chosen. The page then uses that folder directly: it is
 * the same folder the user just picked over there, so asking again (or falling
 * back to a browser-side store) would only look broken.
 */
export function isManaged(): boolean {
  return managed
}

/**
 * True when the page was not opened on the machine running the server — a
 * phone, a tablet, another PC on the LAN.
 *
 * Read off the address the page was reached at rather than asked of the server:
 * it is the same thing the user sees in the URL bar, needs no round-trip, and
 * works before the probe settles. Loopback names and addresses (plus a
 * protocol-relative host, i.e. `file://`) all mean "this machine".
 */
export function isRemoteClient(): boolean {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return !(
    host === '' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0'
  )
}

/**
 * User-facing choice, persisted per browser.
 *
 * When it has never been made, the answer depends on *where the page is open*:
 * a device that reached the app over the LAN reads the directory the server
 * owns — sharing it is the whole point of the LAN mode, and a phone has no
 * other backend it could use — whereas the machine running the server assumes
 * nothing, so a config folder someone already connected stays in charge.
 *
 * A server with no directory chosen yet counts as unusable: there would be
 * nothing to share, and treating it as active would leave a remote device
 * staring at an empty list with no way to fill it.
 */
export function isEnabled(): boolean {
  // A server that owns the storage is not a preference to be second-guessed:
  // the folder was picked in the launcher, and either backend the page could
  // fall back to (a folder handle it does not have, an empty IndexedDB) would
  // just show a different, emptier list.
  if (managed) return true

  const choice = loadSettings().useServerStore
  if (typeof choice === 'boolean') return choice
  return isAvailable() && getDir() !== null && isRemoteClient()
}

/**
 * True when the store is on because this device is remote rather than by the
 * user's choice — the UI says so, and does not offer controls that would only
 * repoint the server's directory from another device.
 */
export function isAutoEnabled(): boolean {
  return typeof loadSettings().useServerStore !== 'boolean' && isEnabled()
}

export function isActive(): boolean {
  return isAvailable() && isEnabled()
}

export function getDir(): string | null {
  return directory
}

/**
 * URL the server serves a media file at, given the `media/clip.mp4` path a
 * config folder would have written.
 *
 * Both backends lay their directory out the same way, so a combo saved by the
 * desktop config folder stays playable through the server — which is exactly
 * what lets a phone open those combos, since a phone cannot use the File
 * System Access API at all.
 */
export function mediaUrl(relPath: string): string {
  let rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (rel.toLowerCase().startsWith('media/')) rel = rel.slice('media/'.length)
  const encoded = rel
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${BASE}/media/${encoded}`
}

export function dirName(): string | null {
  if (!directory) return null
  const parts = directory.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : directory
}

export function setEnabled(on: boolean): void {
  saveSettings({ useServerStore: on })
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  // The store is the one thing here that changes under the page's feet — a
  // phone may be looking at a list the PC just edited. Never let a response
  // come back out of the HTTP cache.
  const res = await fetch(url, { cache: 'no-store', ...init })
  if (!res.ok) throw new Error(`server store request failed: ${res.status}`)
  return (await res.json()) as T
}

export async function readConfig(): Promise<ServerConfig> {
  const data = await getJson<Partial<ServerConfig> & { managed?: boolean }>(`${BASE}/config`)
  directory = data.dir ?? directory
  if (data.managed === true) managed = true
  return {
    dir: data.dir ?? null,
    combos: (data.combos as FavoriteItem[]) ?? [],
    maskSettings: (data.maskSettings as MaskSettings | null) ?? null,
  }
}

/**
 * Partial update: a field left out is left alone on disk, so syncing the mask
 * never has to resend (and risk clobbering) the combo list.
 */
export async function writeConfig(
  combos?: FavoriteItem[] | null,
  mask?: MaskSettings | null,
): Promise<void> {
  const body: Record<string, unknown> = {}
  if (combos) body.combos = combos
  if (mask !== undefined) body.maskSettings = mask
  await getJson(`${BASE}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Choose (and create if needed) the directory combos are written to. */
export async function setDir(target: string): Promise<ServerConfig> {
  const data = await getJson<Partial<ServerConfig>>(`${BASE}/dir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target, create: true }),
  })
  directory = data.dir ?? target
  return {
    dir: directory,
    combos: (data.combos as FavoriteItem[]) ?? [],
    maskSettings: (data.maskSettings as MaskSettings | null) ?? null,
  }
}

/** Reveal the store directory (or any path) in Explorer / Finder. */
export async function openDir(target?: string): Promise<{ ok: boolean; message?: string }> {
  return await getJson<{ ok: boolean; message?: string }>(`${BASE}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target ?? directory ?? undefined }),
  })
}

/**
 * Upload the bytes behind a media item and return the ref that points at them.
 * Remote URLs are left alone — they already work from any device.
 */
export async function ensureMedia(m: MediaItem | null): Promise<MediaRef | null> {
  if (!m) return null
  if (m.source === 'url') {
    return { type: m.type, source: 'url', url: m.url, fileName: m.fileName }
  }

  let blob: Blob | undefined
  if (m.blobId) blob = await getBlob(m.blobId)
  if (!blob) blob = await (await fetch(m.url)).blob()

  const name = m.fileName ?? `${m.type === 'video' ? 'video' : 'image'}.bin`
  const data = await getJson<{ url: string; name?: string }>(
    `${BASE}/media?name=${encodeURIComponent(name)}&size=${blob.size}`,
    { method: 'POST', body: blob },
  )
  // `configPath` is recorded so the ref reads the same as one written by the
  // config folder — the two directories are interchangeable, and this is what
  // lets a phone (no File System Access API) play a desktop-saved combo.
  const stored = data.name ?? name
  const relPath = `media/${stored.replace(/\\/g, '/').replace(/^\/?media\//, '')}`
  return {
    type: m.type,
    source: 'url',
    url: data.url,
    fileName: stored,
    configPath: relPath,
  }
}

/** Debounced mirror of the mask settings, same idea as the config folder. */
export function scheduleMaskSync(mask: MaskSettings): void {
  if (!isActive()) return
  if (maskTimer) clearTimeout(maskTimer)
  maskTimer = setTimeout(() => {
    maskTimer = null
    void writeConfig(null, mask).catch((e: unknown) => {
      console.warn('[RevealPlayer] could not sync mask settings to server:', e)
    })
  }, 800)
}
