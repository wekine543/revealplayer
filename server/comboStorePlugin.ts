/**
 * Server-side combo storage.
 *
 * Why: the config-folder feature needs the File System Access API, which mobile
 * browsers do not offer (and which is blocked on a plain-http LAN address even
 * where it exists). Storing combos on the dev server instead removes that
 * dependency entirely — the phone just talks to the PC over http and gets the
 * full feature set, with the files living in a real directory on the PC.
 *
 * The on-disk format is deliberately identical to the config folder's:
 * `revealplayer.config.json` next to a `media/` directory. A store directory
 * can be copied away and picked up as a config folder, and vice versa.
 *
 * Dev server only (`apply: 'serve'`).
 */
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Plugin } from 'vite'
import {
  openInShell,
  parseJson,
  readBody,
  resolveInside,
  safeFileName,
  send,
  withSuffix,
} from './fsUtils.ts'

const PREFIX = '/__rp/store'
const CONFIG_NAME = 'revealplayer.config.json'
const MEDIA_DIR = 'media'
/** Where the chosen store directory is remembered (project root). */
const POINTER_NAME = '.revealplayer-store.json'

interface ComboFile {
  version: number
  updatedAt: number
  maskSettings: unknown | null
  combos: unknown[]
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

let projectRoot = process.cwd()
let storeDir: string | null = null
let loaded = false

function emptyConfig(): ComboFile {
  return { version: 1, updatedAt: 0, maskSettings: null, combos: [] }
}

function defaultDir(): string {
  return path.join(projectRoot, 'revealplayer-store')
}

/** The pointer is only read once; after that the dir lives in memory. */
function loadPointer(): void {
  if (loaded) return
  loaded = true
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(projectRoot, POINTER_NAME), 'utf8'),
    ) as { dir?: string }
    if (parsed.dir && fs.statSync(parsed.dir).isDirectory()) storeDir = parsed.dir
  } catch {
    // No pointer yet — the client will pick a directory.
  }
}

function savePointer(dir: string): void {
  try {
    fs.writeFileSync(path.join(projectRoot, POINTER_NAME), JSON.stringify({ dir }, null, 2))
  } catch (e) {
    console.warn('[RevealPlayer] could not remember store directory:', e)
  }
}

function readConfigFile(): ComboFile {
  if (!storeDir) return emptyConfig()
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(storeDir, CONFIG_NAME), 'utf8'),
    ) as Partial<ComboFile>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      maskSettings: parsed.maskSettings ?? null,
      combos: Array.isArray(parsed.combos) ? parsed.combos : [],
    }
  } catch {
    // Missing or hand-broken file: start empty rather than failing every read.
    return emptyConfig()
  }
}

function writeConfigFile(cfg: ComboFile): void {
  if (!storeDir) throw new Error('no store directory')
  cfg.updatedAt = Date.now()
  fs.writeFileSync(path.join(storeDir, CONFIG_NAME), JSON.stringify(cfg, null, 2))
}

function payload() {
  const cfg = readConfigFile()
  return { ok: true, dir: storeDir, combos: cfg.combos, maskSettings: cfg.maskSettings }
}

/**
 * Pick a name under `media/`, reusing a byte-identical file and never
 * overwriting one that differs — another combo may still point at it.
 */
function allocateMediaFile(dir: string, fileName: string, size: number) {
  const mediaDir = path.join(dir, MEDIA_DIR)
  fs.mkdirSync(mediaDir, { recursive: true })
  const base = safeFileName(fileName)
  for (let n = 1; n <= 20; n++) {
    const name = n === 1 ? base : withSuffix(base, n)
    const target = path.join(mediaDir, name)
    if (!fs.existsSync(target)) return { target, name }
    if (fs.statSync(target).size === size) return { target, name, reuse: true }
  }
  throw new Error(`Cannot find a free name for ${fileName}`)
}

/** Byte-range aware, otherwise seeking in a long clip does not work. */
function serveFile(req: IncomingMessage, res: ServerResponse, file: string, type: string): void {
  const stat = fs.statSync(file)
  res.setHeader('Content-Type', type)
  res.setHeader('Accept-Ranges', 'bytes')

  const raw = req.headers.range
  const range = typeof raw === 'string' ? raw : undefined
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null

  if (match) {
    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
    if (start >= stat.size || start > end) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${stat.size}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
    res.setHeader('Content-Length', end - start + 1)
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Length', stat.size)
  fs.createReadStream(file).pipe(res)
}

export function comboStorePlugin(): Plugin {
  return {
    name: 'revealplayer-combo-store',
    apply: 'serve',
    configResolved(config) {
      projectRoot = config.root
    },
    configureServer(server) {
      server.middlewares.use(PREFIX, (req, res, next) => {
        void (async () => {
          const url = req.url ?? ''
          try {
            loadPointer()

            // ---- media download ----
            // HEAD is answered too: media with no usable extension is probed
            // with a HEAD request to sniff its type, and mobile Safari does the
            // same before it starts decoding.
            if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith('/media/')) {
              if (!storeDir) return send(res, 404, { ok: false, message: 'no store directory' })
              const rel = decodeURIComponent(url.slice('/media/'.length))
              const file = resolveInside(path.join(storeDir, MEDIA_DIR), rel)
              if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                return send(res, 404, { ok: false, message: 'media not found' })
              }
              const ext = path.extname(file).toLowerCase()
              if (req.method === 'HEAD') {
                const stat = fs.statSync(file)
                res.statusCode = 200
                res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
                res.setHeader('Accept-Ranges', 'bytes')
                res.setHeader('Content-Length', stat.size)
                res.end()
                return
              }
              return serveFile(req, res, file, MIME[ext] ?? 'application/octet-stream')
            }

            // ---- config ----
            if (req.method === 'GET' && url.startsWith('/config')) {
              return send(res, 200, payload())
            }

            if (req.method === 'PUT' && url.startsWith('/config')) {
              const body = parseJson<{ combos?: unknown[]; maskSettings?: unknown }>(
                await readBody(req),
              )
              if (!storeDir) return send(res, 400, { ok: false, message: 'no store directory' })
              const cfg = readConfigFile()
              if (Array.isArray(body?.combos)) cfg.combos = body.combos
              if (body?.maskSettings !== undefined) cfg.maskSettings = body.maskSettings
              writeConfigFile(cfg)
              return send(res, 200, { ok: true, updatedAt: cfg.updatedAt })
            }

            // ---- choose / create the store directory ----
            if (req.method === 'POST' && url.startsWith('/dir')) {
              const body = parseJson<{ path?: string; create?: boolean }>(await readBody(req))
              const target = body?.path
              if (!target) return send(res, 400, { ok: false, message: 'missing path' })
              if (!fs.existsSync(target)) {
                if (!body?.create) return send(res, 404, { ok: false, message: '该路径不存在' })
                fs.mkdirSync(target, { recursive: true })
              }
              if (!fs.statSync(target).isDirectory()) {
                return send(res, 400, { ok: false, message: '该路径不是文件夹' })
              }
              storeDir = target
              savePointer(target)
              return send(res, 200, payload())
            }

            // ---- media upload (raw body, streamed straight to disk) ----
            if (req.method === 'POST' && url.startsWith('/media')) {
              if (!storeDir) return send(res, 400, { ok: false, message: 'no store directory' })
              const query = new URL(url, 'http://localhost').searchParams
              const fileName = query.get('name') ?? 'media'
              const size = Number(query.get('size') ?? '0')
              const { target, name, reuse } = allocateMediaFile(storeDir, fileName, size)

              if (reuse) {
                // Drain the request so the connection is not left hanging.
                req.resume()
                return send(res, 200, {
                  ok: true,
                  url: `${PREFIX}/media/${encodeURIComponent(name)}`,
                  reused: true,
                })
              }

              await new Promise<void>((resolve, reject) => {
                const stream = fs.createWriteStream(target)
                stream.on('finish', () => resolve())
                stream.on('error', reject)
                req.on('error', reject)
                req.pipe(stream)
              })
              return send(res, 200, {
                ok: true,
                url: `${PREFIX}/media/${encodeURIComponent(name)}`,
                name,
                reused: false,
              })
            }

            // ---- reveal the store directory in Explorer ----
            if (req.method === 'POST' && url.startsWith('/open')) {
              const body = parseJson<{ path?: string }>(await readBody(req))
              const target = body?.path ?? storeDir ?? defaultDir()
              return send(res, 200, openInShell(target))
            }
          } catch (e) {
            return send(res, 500, { ok: false, message: String(e) })
          }
          next()
        })()
      })
    },
  }
}
