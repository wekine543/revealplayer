import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import {
  disconnectConfigDir,
  getDirName,
  isSupported as folderSupported,
  pickConfigDir,
  reconnectConfigDir,
} from '../lib/configDir'
import { baseNameOf, fsFindDir, fsOpen, localFsAvailable } from '../lib/localFs'
import * as serverStore from '../lib/serverStore'
import { loadSettings, saveSettings } from '../lib/settings'
import { FolderPathDialog } from './FolderPathDialog'

/**
 * Where combos are going, and the controls to move them:
 *
 *  - **服务端存储** — files live on the machine running the dev server. Works
 *    from a phone over plain http, because it needs no browser filesystem API.
 *    A device that reached the app over the LAN uses it by default and sees the
 *    exact same directory the PC does; there it is shown read-only.
 *  - **配置文件夹** — a folder on this device (File System Access API, so
 *    Chromium desktop only).
 *  - **浏览器本地** — IndexedDB. Always available, lost when data is cleared.
 *
 * The name in the row opens that place in Explorer, which needs a real path —
 * resolved once by the dev server and then remembered.
 */
export function ConfigDirBar({ onChanged }: { onChanged: () => void }) {
  const status = useStore((s) => s.configStatus)
  const busy = useStore((s) => s.configBusy)
  const dirName = useStore((s) => s.configDirName)
  const setConfigStatus = useStore((s) => s.setConfigStatus)
  const setConfigBusy = useStore((s) => s.setConfigBusy)

  const [dirPath, setDirPath] = useState<string | null>(
    () => loadSettings().configDirPath ?? null,
  )
  // The server probe is async, so the row re-renders once it settles.
  const [, setProbed] = useState(false)
  const [picking, setPicking] = useState<'locate' | 'server-dir' | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  /**
   * The page was served over http(s), so a server is behind it somewhere. If
   * the store has not answered, that is a request that got lost — not a server
   * that is absent — and worth one deliberate retry from the user.
   */
  const servedOverHttp =
    typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)

  const retryServer = async () => {
    setOpenError(null)
    setRetrying(true)
    const ok = await serverStore.reprobe()
    setRetrying(false)
    if (ok) onChanged()
    else setOpenError('还是连不上服务端。请确认这台电脑上的服务正在运行，并且本设备和它在同一个网络里。')
  }

  useEffect(() => {
    let alive = true
    void serverStore.probe().then(() => {
      if (alive) setProbed(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const rememberPath = (path: string) => {
    setDirPath(path)
    saveSettings({ configDirPath: path })
  }

  // A remembered path that no longer matches the connected folder (moved,
  // renamed, or a different folder was picked) is useless — look it up again.
  useEffect(() => {
    if (status !== 'ready' || !dirName) return
    if (dirPath && baseNameOf(dirPath).toLowerCase() === dirName.toLowerCase()) return
    let alive = true
    void (async () => {
      if (!(await localFsAvailable())) return
      const found = await fsFindDir(dirName).catch(() => [])
      if (!alive || found.length !== 1) return
      rememberPath(found[0] as string)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, dirName, dirPath])

  const serverOn = serverStore.isActive()
  const serverUsable = serverStore.isAvailable()
  // A launcher-hosted page is told where its folder is and follows it without
  // asking; a remote device reads the same folder over the LAN. Either way, the
  // controls that would repoint the store belong to the machine that owns it.
  const managed = serverStore.isManaged()
  const serverShared = managed || serverStore.isAutoEnabled()
  const kind = serverOn ? 'server' : status === 'ready' ? 'folder' : 'browser'

  if (status === 'loading') return null

  const connectFolder = async () => {
    setConfigBusy(true)
    const res =
      status === 'needs-permission' ? await reconnectConfigDir() : await pickConfigDir()
    setConfigBusy(false)
    if (res.ok) {
      saveSettings({ configSkipped: false, useServerStore: false })
      setConfigStatus('ready', getDirName(), null)
      // The old path belongs to the old folder.
      setDirPath(null)
      saveSettings({ configDirPath: null })
      onChanged()
    } else if (res.message && res.message !== 'cancelled') {
      setConfigStatus(status, getDirName(), res.message)
      onChanged()
    }
  }

  const useBrowser = async () => {
    serverStore.setEnabled(false)
    await disconnectConfigDir()
    // Stay quiet on the next launch; this row still offers a way back in.
    saveSettings({ configSkipped: true, configDirPath: null })
    setDirPath(null)
    setConfigStatus('idle', null, null)
    onChanged()
  }

  /** Cycle: server → folder → browser → server (skipping what is unusable). */
  const switchStorage = async () => {
    setOpenError(null)
    if (kind === 'server') {
      serverStore.setEnabled(false)
      if (folderSupported()) {
        if (status !== 'ready') await connectFolder()
        else onChanged()
      } else {
        await useBrowser()
      }
      return
    }
    if (kind === 'folder') {
      await useBrowser()
      return
    }
    // → server
    if (serverStore.getDir()) {
      serverStore.setEnabled(true)
      onChanged()
      return
    }
    setPicking('server-dir')
  }

  /** Open the current storage location in Explorer. */
  const openFolder = async () => {
    setOpenError(null)
    if (kind === 'server') {
      const res = await serverStore.openDir()
      if (!res.ok) setOpenError(res.message ?? '打开失败')
      return
    }
    if (dirPath) {
      const res = await fsOpen(dirPath).catch(() => ({ ok: false, message: '无法调用本地服务' }))
      if (res.ok) return
      if (res.message === '该路径不存在') {
        setDirPath(null)
        saveSettings({ configDirPath: null })
      } else {
        setOpenError(res.message ?? '打开失败')
        return
      }
    }
    if (!(await localFsAvailable())) {
      setOpenError('需要用 RevealPlayer.bat 启动（localhost）才能打开本地文件夹')
      return
    }
    setPicking('locate')
  }

  const dialog =
    picking === 'server-dir' ? (
      <FolderPathDialog
        title="选择服务端存储目录"
        hint="组合和媒体会存在这台电脑的这个目录里，手机通过局域网访问时读写的就是它。可以直接输入一个还不存在的路径，会自动创建。"
        confirmLabel="用这个目录"
        onPick={async (path) => {
          setPicking(null)
          try {
            await serverStore.setDir(path)
            serverStore.setEnabled(true)
            onChanged()
          } catch (e) {
            setOpenError(e instanceof Error ? e.message : String(e))
          }
        }}
        onClose={() => setPicking(null)}
      />
    ) : picking === 'locate' ? (
      <FolderPathDialog
        title="定位配置文件夹"
        hint="浏览器只能拿到文件夹名，拿不到路径。选一次真实位置并记住，之后点击文件夹名就能直接用资源管理器打开。"
        searchName={dirName}
        onPick={(path) => {
          setPicking(null)
          rememberPath(path)
          void fsOpen(path)
        }}
        onClose={() => setPicking(null)}
      />
    ) : null

  const errorLine = openError ? (
    <p className="mt-1 text-[11px] text-red-400 leading-relaxed">{openError}</p>
  ) : null

  if (kind === 'server') {
    // Reading the folder the server owns. It is shown, not editable: the place
    // to change it is the launcher window (or the PC, for a remote device) —
    // from here the alternatives are a folder this device cannot open or an
    // IndexedDB that would look empty.
    if (serverShared) {
      return (
        <div className="mb-2">
          <div className="flex items-center gap-1.5 rounded-md bg-green-500/10 border border-green-500/20 px-2 py-1.5">
            <svg className="w-3.5 h-3.5 flex-shrink-0 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5z" />
            </svg>
            <span
              className="flex-1 min-w-0 text-[11px] text-green-300 truncate"
              title={managed
                ? '保存的组合和视频就在这个文件夹里。要换位置，在启动器窗口的「收藏保存位置」里改。'
                : '这台设备通过局域网访问，收藏读写的是服务端所在电脑上的这个目录，和电脑上看到的是同一份'}
            >
              {managed ? '收藏文件夹' : '服务端存储（共享）'} · {serverStore.dirName() ?? '未选择'}
            </span>
          </div>
          {errorLine}
        </div>
      )
    }
    return (
      <div className="mb-2">
        <div className="flex items-center gap-1.5 rounded-md bg-green-500/10 border border-green-500/20 px-2 py-1.5">
          <svg className="w-3.5 h-3.5 flex-shrink-0 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5z" />
          </svg>
          <button
            onClick={openFolder}
            className="flex-1 min-w-0 text-left text-[11px] text-green-300 hover:text-white hover:underline truncate"
            title="在资源管理器中打开这个目录"
          >
            服务端存储 · {serverStore.dirName() ?? '未选择'}
          </button>
          <button
            onClick={() => setPicking('server-dir')}
            className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-gray-400"
            title="换一个目录"
          >
            更改
          </button>
          <button
            onClick={switchStorage}
            disabled={busy}
            className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-gray-400 disabled:opacity-50"
            title="改用配置文件夹或浏览器本地"
          >
            {busy ? '…' : '切换'}
          </button>
        </div>
        {errorLine}
        {dialog}
      </div>
    )
  }

  if (kind === 'folder') {
    return (
      <div className="mb-2">
        <div className="flex items-center gap-1.5 rounded-md bg-green-500/10 border border-green-500/20 px-2 py-1.5">
          <svg className="w-3.5 h-3.5 flex-shrink-0 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5z" />
          </svg>
          <button
            onClick={openFolder}
            className="flex-1 min-w-0 text-left text-[11px] text-green-300 hover:text-white hover:underline truncate"
            title={dirPath ? `在资源管理器中打开：${dirPath}` : '点击定位并打开该文件夹'}
          >
            {dirName ?? '配置文件夹'}
          </button>
          <button
            onClick={connectFolder}
            disabled={busy}
            className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-gray-400 disabled:opacity-50"
            title="换一个配置文件夹"
          >
            {busy ? '…' : '更改'}
          </button>
          <button
            onClick={switchStorage}
            disabled={busy}
            className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-gray-400 disabled:opacity-50"
            title="改用浏览器本地存储"
          >
            切换
          </button>
        </div>
        {errorLine}
        {dialog}
      </div>
    )
  }

  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 px-2 py-1.5">
        <svg className="w-3.5 h-3.5 flex-shrink-0 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <span className="flex-1 min-w-0 text-[11px] text-amber-200/90 truncate">
          保存在浏览器本地，清缓存会丢失
        </span>
        {serverUsable && (
          <button
            onClick={switchStorage}
            className="text-[11px] px-1.5 py-0.5 rounded bg-brand-500/20 hover:bg-brand-500/30 text-brand-200"
            title="存到运行服务的那台电脑上，手机也能读写"
          >
            服务端存储
          </button>
        )}
        {!serverUsable && servedOverHttp && (
          <button
            onClick={retryServer}
            disabled={retrying}
            className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-gray-300 disabled:opacity-50"
            title="连接那台电脑上的服务，读取它保存的收藏"
          >
            {retrying ? '…' : '连接服务端'}
          </button>
        )}
        {folderSupported() && (
          <button
            onClick={connectFolder}
            disabled={busy}
            className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-gray-300 disabled:opacity-50"
          >
            {busy ? '…' : '选择文件夹'}
          </button>
        )}
      </div>
      {errorLine}
      {dialog}
    </div>
  )
}
