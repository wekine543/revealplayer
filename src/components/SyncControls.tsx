import { useStore, useSkipHeadWait } from '../store/useStore'
import {
  OFFSET_MIN,
  OFFSET_MAX,
  OFFSET_STEP,
  SKIP_WAIT_THRESHOLD,
  formatOffset,
} from '../lib/timeOffset'

/** Nudge buttons: a whole tenth and a single hundredth, both ways. */
const NUDGES = [-0.1, -0.01, 0.01, 0.1]

/**
 * The A→B time offset.
 *
 * The slider spans the whole ±3s range but its steps are hundredths, so on a
 * narrow panel a single pixel covers more than one step — hence the nudge
 * buttons and the number field, which are how you actually land on 0.05.
 */
export function SyncControls() {
  const bOffset = useStore((s) => s.bOffset)
  const setBOffset = useStore((s) => s.setBOffset)
  const skipExplicit = useStore((s) => s.skipWait)
  const setSkipWait = useStore((s) => s.setSkipWait)
  const mediaA = useStore((s) => s.mediaA)
  const mediaB = useStore((s) => s.mediaB)
  const skipWait = useSkipHeadWait()

  const bothVideo = mediaA?.type === 'video' && mediaB?.type === 'video'
  const skew = Math.abs(bOffset)
  // From the head the two start together, so the one that is supposed to be
  // further along begins there and the other begins at 0.
  const leadSlot = bOffset > 0 ? 'B' : 'A'
  const otherSlot = bOffset > 0 ? 'A' : 'B'

  return (
    <div className="space-y-3">
      {/* Readout */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">B 相对 A</span>
        <span
          className={`font-mono text-sm tabular-nums ${
            Math.abs(bOffset) < OFFSET_STEP / 2 ? 'text-gray-300' : 'text-brand-300'
          }`}
        >
          {formatOffset(bOffset)}
        </span>
      </div>

      {/* Coarse slider */}
      <input
        type="range"
        min={OFFSET_MIN}
        max={OFFSET_MAX}
        step={OFFSET_STEP}
        value={bOffset}
        onChange={(e) => setBOffset(parseFloat(e.target.value))}
        className="w-full accent-brand-400"
        aria-label="B time offset"
      />

      {/* Fine steps + typed entry */}
      <div className="flex items-center gap-1.5">
        {NUDGES.map((step) => (
          <button
            key={step}
            onClick={() => setBOffset(bOffset + step)}
            className="flex-1 text-[11px] sm:text-xs py-1.5 sm:py-1 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 transition-colors tabular-nums"
            title={`${step > 0 ? '+' : ''}${step.toFixed(2)}s`}
          >
            {step > 0 ? `+${step}` : step}
          </button>
        ))}
        <input
          type="number"
          min={OFFSET_MIN}
          max={OFFSET_MAX}
          step={OFFSET_STEP}
          value={bOffset}
          onChange={(e) => setBOffset(parseFloat(e.target.value))}
          className="w-16 text-xs px-1.5 py-1 rounded-md bg-black/30 border border-white/10 text-gray-200 focus:outline-none focus:border-brand-400 tabular-nums"
          aria-label="B offset in seconds"
        />
      </div>

      <button
        onClick={() => setBOffset(0)}
        disabled={Math.abs(bOffset) < OFFSET_STEP / 2}
        className="w-full text-xs py-1.5 sm:py-1 rounded-md bg-white/5 hover:bg-white/10 text-gray-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        归零
      </button>

      {/* Starting from the head: wait it out, or start already apart. Only
          meaningful once there is a skew worth sitting through. */}
      {skew > 0 && (
        <label
          className={`flex items-start gap-2 cursor-pointer select-none ${skew < SKIP_WAIT_THRESHOLD ? 'opacity-60' : ''}`}
          title={
            skipExplicit === null
              ? `默认按时间差决定：超过 ${SKIP_WAIT_THRESHOLD}s 就跳过等待`
              : '已手动设置，不再随时间差变化'
          }
        >
          <input
            type="checkbox"
            checked={skipWait}
            onChange={(e) => setSkipWait(e.target.checked)}
            className="mt-0.5 accent-brand-400 flex-shrink-0"
          />
          <span className="text-[11px] text-gray-600 leading-relaxed">
            跳过开头等待：让 {leadSlot} 从第 {skew.toFixed(2)}s 开始，{otherSlot} 从第 0s 开始。
            <br />
            关掉则原本较慢的一路会先原地等待这段时间。
          </span>
        </label>
      )}

      {bothVideo ? (
        <p className="text-[11px] text-gray-600 leading-relaxed">正值 = B 更快（B 的画面领先 A）。</p>
      ) : (
        <p className="text-[11px] text-amber-400/80 leading-relaxed">
          时间差只在 A、B 都是视频时生效 —— 现在至少有一路是图片。
        </p>
      )}
    </div>
  )
}
