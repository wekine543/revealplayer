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
let maskTimer: ReturnType<typeof setTimeout> | null = null

let probing: Promise<boolean> | null = null

/**
 * One request, cached for the session.
 *
 * Awaited before anything decides which backend to use: a page can start
 * rendering (and listing combos) before the first fetch has settled, and
 * reading the wrong backend once is enough to show an empty or stale list.
 */
export function probe(): Promise<boolean> {
  if (probing) return probing
  probing = (async () => {
    try {
      const res = await fetch(`${BASE}/config`)
      if (!res.ok) {
        available = false
        return available
      }
      const data = (await res.json()) as Partial<ServerConfig>
      directory = data.dir ?? null
      available = true
    } catch {
      available = false
    }
    return available === true
  })()
  return probing
}

export function isAvailable(): boolean {
  return available === true
}

/** User-facing choice, persisted per browser. */
export function isEnabled(): boolean {
  return loadSettings().useServerStore
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
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`server store request failed: ${res.status}`)
  return (await res.json()) as T
}

export async function readConfig(): Promise<ServerConfig> {
  const data = await getJson<Partial<ServerConfig>>(`${BASE}/config`)
  directory = data.dir ?? directory
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
