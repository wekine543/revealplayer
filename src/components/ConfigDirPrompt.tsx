import { useState } from 'react'
import { useStore } from '../store/useStore'
import { getDirName, pickConfigDir, reconnectConfigDir } from '../lib/configDir'
import { saveSettings } from '../lib/settings'

/**
 * Start-up gate for the config folder.
 *
 * Shown when no folder has been chosen, or when the browser dropped the grant
 * and needs one click to hand it back. Picking is always behind a button:
 * `showDirectoryPicker()` throws unless it runs inside a user gesture, so it can
 * never be called straight from an effect.
 */
export function ConfigDirPrompt({ onConnected }: { onConnected: () => void }) {
  const status = useStore((s) => s.configStatus)
  const busy = useStore((s) => s.configBusy)
  const error = useStore((s) => s.configError)
  const setConfigStatus = useStore((s) => s.setConfigStatus)
  const setConfigBusy = useStore((s) => s.setConfigBusy)
  const [dismissed, setDismissed] = useState(false)

  const connect = async () => {
    setConfigBusy(true)
    const res =
      status === 'needs-permission' ? await reconnectConfigDir() : await pickConfigDir()
    setConfigBusy(false)

    if (res.ok) {
      // Any later launch should offer the folder again rather than stay quiet.
      saveSettings({ configSkipped: false })
      setConfigStatus('ready', getDirName(), null)
      setDismissed(false)
      onConnected()
    } else if (res.message && res.message !== 'cancelled') {
      setConfigStatus(status, getDirName(), res.message)
    }
  }

  const skip = () => {
    // Remembered, otherwise the prompt would come back on every launch.
    saveSettings({ configSkipped: true })
    setDismissed(true)
    setConfigStatus('idle', getDirName(), null)
  }

  // Nothing to gate on while the start-up check runs, once a folder is live, or
  // where the browser cannot offer one at all (`file://`, Firefox) — that case
  // is not worth a banner: combos simply stay in IndexedDB and the sidebar
  // still says so.
  if (status !== 'needs-pick' && status !== 'needs-permission') return null
  if (dismissed) return null

  const reconnecting = status === 'needs-permission'
  const known = getDirName()

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4">
      <div className="w-full max-w-md rounded-2xl bg-[#15161c] border border-white/10 p-5 shadow-2xl">
        <h2 className="text-base font-bold text-white">
          {reconnecting ? '需要重新授权配置文件夹' : '先选一个配置文件夹'}
        </h2>
        <p className="mt-2 text-xs text-gray-400 leading-relaxed">
          收藏的组合和对应的媒体文件都会存到这个文件夹里 —— 一个
          <code className="mx-1 px-1 rounded bg-white/10 text-gray-300">revealplayer.config.json</code>
          加上
          <code className="mx-1 px-1 rounded bg-white/10 text-gray-300">media/</code>
          里的素材。整个文件夹拷到别的机器就能直接用，清浏览器缓存也不会丢。
        </p>
        {reconnecting && (
          <p className="mt-2 text-xs text-brand-300 leading-relaxed">
            浏览器每个会话都要确认一次访问权限。上次使用的是「{known ?? '配置文件夹'}」。
          </p>
        )}

        {error && (
          <p className="mt-2 text-xs text-red-400 leading-relaxed">{error}</p>
        )}

        <div className="mt-4 flex flex-col gap-2">
          <button
            onClick={connect}
            disabled={busy}
            className="w-full text-sm py-2.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white disabled:opacity-50 transition-colors"
          >
            {busy ? '正在连接…' : reconnecting ? '重新授权' : '选择文件夹'}
          </button>
          <button
            onClick={skip}
            disabled={busy}
            className="w-full text-xs py-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 disabled:opacity-50 transition-colors"
          >
            暂时跳过（收藏仍保存在浏览器本地）
          </button>
        </div>

        <p className="mt-3 text-[11px] text-gray-600 leading-relaxed">
          需要 Chrome / Edge，并通过 localhost 打开（双击 HTML 的 file:// 模式不支持读写本地文件夹）。
        </p>
      </div>
    </div>
  )
}
