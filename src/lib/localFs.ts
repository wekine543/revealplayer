/**
 * Client for the tiny helper that ships with the dev server (`/__rp/fs`).
 *
 * It exists only because the browser cannot reveal a folder in Explorer: the
 * File System Access API gives us a directory handle with a name but no path,
 * and no web API can launch the OS file manager. The dev server is a Node
 * process on the same machine, so it can do both.
 *
 * Everything here fails soft — the app is also used as a single HTML file with
 * no server behind it, where all of this simply reports "unavailable".
 */

const BASE = '/__rp/fs'

export interface FsEntry {
  name: string
  path: string
}

export interface FsListing {
  path: string | null
  parent: string | null
  dirs: FsEntry[]
}

/** Cached per session; probing is just one request. */
let available: boolean | null = null

export async function localFsAvailable(): Promise<boolean> {
  if (available !== null) return available
  try {
    const res = await fetch(`${BASE}/roots`)
    available = res.ok
  } catch {
    available = false
  }
  return available
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`local fs request failed: ${res.status}`)
  return (await res.json()) as T
}

export async function fsRoots(): Promise<FsEntry[]> {
  const data = await getJson<{ roots?: FsEntry[] }>(`${BASE}/roots`)
  return data.roots ?? []
}

/** `null` lists the roots (drives / home folders). */
export async function fsList(target: string | null): Promise<FsListing> {
  const query = target ? `?path=${encodeURIComponent(target)}` : ''
  const data = await getJson<Partial<FsListing>>(`${BASE}/list${query}`)
  return { path: data.path ?? null, parent: data.parent ?? null, dirs: data.dirs ?? [] }
}

/** Best-effort lookup of a folder by name. May return several or none. */
export async function fsFindDir(name: string): Promise<string[]> {
  const data = await getJson<{ matches?: string[] }>(`${BASE}/find`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return data.matches ?? []
}

/** Open `target` in Explorer / Finder. Only absolute, existing dirs work. */
export async function fsOpen(target: string): Promise<{ ok: boolean; message?: string }> {
  return await getJson<{ ok: boolean; message?: string }>(`${BASE}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target }),
  })
}

/** `C:\Users\x\Config` → `Config`. Handles both separators. */
export function baseNameOf(target: string): string {
  const parts = target.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : target
}
