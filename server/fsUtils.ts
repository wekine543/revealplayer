/**
 * Filesystem helpers shared by the two dev-server plugins.
 *
 * Everything here runs in Node, on the machine that also runs the browser, so
 * it can do what the page never can: read a real path, walk the disk, open a
 * folder in Explorer.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FsEntry {
  name: string
  path: string
}

/** Directories that are never worth descending into during a search. */
const WINDOWS_SKIP = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'perflogs',
  'recovery',
  'appdata',
  'winsxs',
  'drivers',
])

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function skipDir(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === 'node_modules' || lower.startsWith('.')) return true
  if (process.platform === 'win32') return WINDOWS_SKIP.has(lower)
  return false
}

export function listDirs(dir: string): FsEntry[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !skipDir(d.name))
      .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    // Unreadable drive, permission denied, drive not ready — just skip it.
    return []
  }
}

export function driveRoots(): FsEntry[] {
  if (process.platform === 'win32') {
    const out: FsEntry[] = []
    for (let code = 67; code <= 90; code++) {
      const p = `${String.fromCharCode(code)}:\\`
      if (fs.existsSync(p)) out.push({ name: p, path: p })
    }
    return out
  }
  return [{ name: '/', path: '/' }]
}

export function homeRoots(): FsEntry[] {
  const home = os.homedir()
  const out: FsEntry[] = []
  for (const name of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos']) {
    const p = path.join(home, name)
    try {
      if (fs.statSync(p).isDirectory()) out.push({ name, path: p })
    } catch {
      // Not every platform has all of these.
    }
  }
  return out
}

/**
 * Breadth-first search for a directory with this name. Bounded by time and by
 * the number of directories visited: a whole-drive walk is far too slow, and a
 * partial answer is still useful (the user can pick from the matches).
 */
export function findDir(name: string): string[] {
  const target = name.trim().toLowerCase()
  if (!target) return []

  const deadline = Date.now() + 4000
  const matches: string[] = []
  const seen = new Set<string>()
  const queue: Array<{ p: string; depth: number }> = []

  for (const root of homeRoots()) queue.push({ p: root.path, depth: 0 })
  try {
    queue.push({ p: process.cwd(), depth: 0 })
  } catch {
    // No cwd available — harmless.
  }
  for (const root of driveRoots()) queue.push({ p: root.path, depth: 0 })

  while (queue.length > 0) {
    if (Date.now() > deadline || seen.size > 6000) break
    const item = queue.shift()
    if (!item) break
    const key = item.p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    if (path.basename(item.p).toLowerCase() === target) {
      matches.push(item.p)
      continue
    }
    if (item.depth >= 3) continue
    for (const child of listDirs(item.p)) {
      queue.push({ p: child.path, depth: item.depth + 1 })
    }
  }
  return matches
}

export function openInShell(dir: string): { ok: boolean; message?: string } {
  let stats: fs.Stats
  try {
    stats = fs.statSync(dir)
  } catch {
    return { ok: false, message: '该路径不存在' }
  }
  if (!stats.isDirectory()) return { ok: false, message: '该路径不是文件夹' }

  try {
    const command =
      process.platform === 'win32'
        ? 'explorer.exe'
        : process.platform === 'darwin'
          ? 'open'
          : 'xdg-open'
    spawn(command, [dir], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
}

/** Resolve `rel` under `base`, rejecting anything that escapes it. */
export function resolveInside(base: string, rel: string): string | null {
  const target = path.resolve(base, rel)
  const root = path.resolve(base)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

/** `clip.mp4` → `clip (2).mp4`. */
export function withSuffix(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name} (${n})`
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`
}

/** Drop anything that could confuse the filesystem or break out of the dir. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned : 'media'
}
