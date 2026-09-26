/**
 * Dev-only helper for two things the browser cannot do on its own:
 *
 *  1. Reveal a folder in the OS file manager.
 *  2. Turn a folder *name* into a real path on disk.
 *
 * (2) is needed because a File System Access API directory handle deliberately
 * exposes no path — only a name. So the path is discovered by searching a few
 * likely roots, or picked by hand once, and then remembered.
 *
 * Only mounted by the dev server (`apply: 'serve'`), i.e. when the app is
 * launched through RevealPlayer.bat. The built single-file HTML has no server
 * behind it and reports the helper as unavailable.
 */
import path from 'node:path'
import type { Plugin } from 'vite'
import {
  driveRoots,
  findDir,
  homeRoots,
  listDirs,
  openInShell,
  parseJson,
  readBody,
  send,
} from './fsUtils.ts'

const PREFIX = '/__rp/fs'

export function localFsPlugin(): Plugin {
  return {
    name: 'revealplayer-local-fs',
    // Serve only: the built single-file HTML has no server to talk to.
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(PREFIX, (req, res, next) => {
        void (async () => {
          const url = req.url ?? ''
          try {
            if (req.method === 'GET' && url.startsWith('/roots')) {
              return send(res, 200, { ok: true, roots: [...homeRoots(), ...driveRoots()] })
            }

            if (req.method === 'GET' && url.startsWith('/list')) {
              const target = new URL(url, 'http://localhost').searchParams.get('path')
              if (!target) {
                return send(res, 200, {
                  ok: true,
                  path: null,
                  parent: null,
                  dirs: [...homeRoots(), ...driveRoots()],
                })
              }
              const parent = path.dirname(target)
              return send(res, 200, {
                ok: true,
                path: target,
                parent: parent === target ? null : parent,
                dirs: listDirs(target),
              })
            }

            if (req.method === 'POST' && url.startsWith('/find')) {
              const body = parseJson<{ name?: string }>(await readBody(req))
              return send(res, 200, { ok: true, matches: findDir(body?.name ?? '') })
            }

            if (req.method === 'POST' && url.startsWith('/open')) {
              const body = parseJson<{ path?: string }>(await readBody(req))
              if (!body?.path) return send(res, 400, { ok: false, message: 'missing path' })
              return send(res, 200, openInShell(body.path))
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
