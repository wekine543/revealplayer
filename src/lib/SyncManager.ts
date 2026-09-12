/**
 * SyncManager — keeps two video elements frame-synchronized.
 * A is the master clock; B follows it.
 *
 * The hard part is *how* B follows. Seeking a video is asynchronous and slow:
 * the decoder has to restart from the previous keyframe, and until it finishes
 * `currentTime` still reads the OLD position — measured in Chrome, right after
 * `v.currentTime = x` a read-back gives the previous value while
 * `v.seeking === true`. So a loop that compares on every animation frame sees
 * "still out of sync" on the very next frame, issues another seek, and Chrome
 * aborts the seek in flight to start the new one. The result is a seek storm:
 * B never completes a single seek and freezes, with an occasional visible jump
 * when one does slip through. It triggers exactly where a real offset exists —
 * the first frames of playback, and after the user drags the progress bar.
 *
 * The rules below exist to break that feedback loop:
 *
 *   1. Never compare or correct while either element is seeking, and stay quiet
 *      for a moment after the seek lands (its position is still settling).
 *   2. Prefer a `playbackRate` nudge. Only seek when the offset is large enough
 *      to be worth a decoder restart, never twice for the same target, and never
 *      more than a few times inside a rolling window.
 *   3. Align exactly once at the moments where an offset is known to exist:
 *      playback start, and the end of a user seek.
 */

/** Inside this offset, leave B alone — it is below a frame at any sane rate. */
const MICRO = 0.005
/** Above this, a rate nudge is too slow to be worth it; seek instead. */
const SEEK_AT = 0.12
/** Strongest playbackRate correction for soft sync (±4%). */
const MAX_ADJUST = 0.04
/** Soft-sync gain: correction = offset * GAIN, clamped to ±MAX_ADJUST. */
const RATE_GAIN = 0.33
/** Minimum gap between two hard syncs, so a seek gets time to land. */
const HARD_COOLDOWN_MS = 350
/** Quiet period after any seek before corrections resume. */
const SETTLE_MS = 120
/** Ceiling for the measured seek latency, so one cold seek cannot skew it. */
const MAX_SEEK_LATENCY_MS = 400
/** Hard seeks allowed inside SEEK_WINDOW_MS; beyond that, rate nudges only. */
const SEEK_BUDGET = 4
const SEEK_WINDOW_MS = 2000
/** Store writes for the progress bar: 10/s is plenty and avoids 60 re-renders. */
const TIME_UPDATE_MS = 100
/** Do not seek during startup alignment for less than this. */
const ALIGN_EPSILON = 0.02
/** How long to wait for both elements to have a decodable frame before aligning. */
const READY_TIMEOUT_MS = 1500

interface Watcher {
  el: HTMLVideoElement
  type: string
  fn: EventListener
}

export class SyncManager {
  private rafId: number | null = null
  private videoA: HTMLVideoElement | null = null
  private videoB: HTMLVideoElement | null = null
  private onTimeUpdate: ((time: number) => void) | null = null

  /** No corrections before this timestamp (a seek is in flight or just landed). */
  private suppressUntil = 0
  private lastHardSeekAt = -Infinity
  /** Timestamps of recent hard seeks, pruned to SEEK_WINDOW_MS. */
  private seekStamps: number[] = []
  /** Target of the last hard seek, so the same one is never repeated. */
  private lastSeekTarget = NaN
  /**
   * Measured time for a seek to complete. A keeps advancing while B's decoder
   * restarts, so aiming at A's *current* position always lands B behind by
   * exactly this much — which is why the target is lead by it (see correct()).
   * Zero means "not measured yet".
   */
  private seekLatencyMs = 0
  private seekIssuedAt = 0
  /** Set from the elements' `waiting`/`stalled` events, cleared on `playing`. */
  private starvedA = false
  private starvedB = false
  private lastTimeUpdateAt = 0
  private watchers: Watcher[] = []

  start(
    videoA: HTMLVideoElement,
    videoB: HTMLVideoElement,
    onTimeUpdate?: (time: number) => void,
  ) {
    this.detachWatchers()
    this.videoA = videoA
    this.videoB = videoB
    this.onTimeUpdate = onTimeUpdate ?? null

    this.suppressUntil = performance.now() + SETTLE_MS
    this.lastHardSeekAt = -Infinity
    this.seekStamps = []
    this.lastSeekTarget = NaN
    this.seekIssuedAt = 0
    this.starvedA = false
    this.starvedB = false
    this.lastTimeUpdateAt = 0

    this.attachWatchers(videoA, true)
    this.attachWatchers(videoB, false)

    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.loop()
  }

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.detachWatchers()
    this.videoA = null
    this.videoB = null
    this.onTimeUpdate = null
  }

  // ---- Element event wiring ----

  /**
   * Track whether an element is starved of data. A video that is out of data
   * has a frozen clock, so its `currentTime` stops advancing; comparing against
   * it would report a "drift" that is really just buffering, and any correction
   * would have to be undone once the data arrives.
   */
  private attachWatchers(el: HTMLVideoElement, isA: boolean) {
    const starve = () => {
      if (isA) this.starvedA = true
      else this.starvedB = true
    }
    const resume = () => {
      if (isA) this.starvedA = false
      else this.starvedB = false
      // Data just arrived — let the pipeline settle before judging the offset.
      this.suppressUntil = performance.now() + SETTLE_MS
    }
    const pairs: Array<[string, EventListener]> = [
      ['waiting', starve],
      ['stalled', starve],
      ['playing', resume],
    ]

    // Only B is ever seeked by the sync loop, so measure the latency there.
    if (!isA) {
      const onSeeked = () => {
        if (this.seekIssuedAt <= 0) return // a seek we did not issue
        const measured = Math.min(performance.now() - this.seekIssuedAt, MAX_SEEK_LATENCY_MS)
        this.seekIssuedAt = 0
        this.seekLatencyMs =
          this.seekLatencyMs === 0 ? measured : this.seekLatencyMs * 0.5 + measured * 0.5
      }
      pairs.push(['seeked', onSeeked])
    }

    for (const [type, fn] of pairs) {
      el.addEventListener(type, fn)
      this.watchers.push({ el, type, fn })
    }
  }

  private detachWatchers() {
    for (const w of this.watchers) w.el.removeEventListener(w.type, w.fn)
    this.watchers = []
  }

  // ---- Main loop ----

  private loop = () => {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) {
      this.rafId = null
      return
    }

    const now = performance.now()
    const seeking = a.seeking || b.seeking

    if (seeking) {
      // currentTime is stale on a seeking element, so anything computed now is
      // noise. Hold off, and keep holding off for a moment after it lands.
      this.suppressUntil = now + SETTLE_MS
    } else {
      if (now - this.lastTimeUpdateAt >= TIME_UPDATE_MS) {
        this.lastTimeUpdateAt = now
        this.onTimeUpdate?.(a.currentTime)
      }
      if (!a.paused && !b.paused && now >= this.suppressUntil) {
        this.correct(now)
      }
    }

    this.rafId = requestAnimationFrame(this.loop)
  }

  /** Compare B against A and apply the cheapest correction that will work. */
  private correct(now: number) {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return

    // A starved element has no reliable clock to compare against.
    if (this.starvedA || this.starvedB || a.readyState < 2 || b.readyState < 2) return

    const diff = a.currentTime - b.currentTime // > 0 → B is behind
    const absDiff = Math.abs(diff)
    const baseRate = a.playbackRate

    if (absDiff <= MICRO) {
      this.applyRateB(baseRate)
      return
    }

    if (absDiff <= SEEK_AT) {
      // Soft sync: proportional, so a 10 ms error does not get the same kick as
      // a 110 ms one — that is what makes a fixed ±2% toggle ring.
      const adjust = Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, diff * RATE_GAIN))
      this.applyRateB(baseRate * (1 + adjust))
      return
    }

    // Large offset. A rate nudge would need seconds to close it, so seek — but
    // only if the budget allows, and never to a target we just used.
    if (this.canHardSeek(now) && !(Math.abs(a.currentTime - this.lastSeekTarget) <= MICRO)) {
      const target = this.seekTargetFor(a, baseRate)
      this.lastSeekTarget = target
      this.lastHardSeekAt = now
      this.seekStamps.push(now)
      this.seekIssuedAt = now
      this.suppressUntil = now + SETTLE_MS
      b.currentTime = target
      this.applyRateB(baseRate)
      return
    }

    // Out of seek budget: fall back to the strongest nudge available so the
    // offset still closes, just more slowly.
    this.applyRateB(baseRate * (1 + (diff > 0 ? MAX_ADJUST : -MAX_ADJUST)))
  }

  /** Rolling-window rate limit on hard seeks. */
  private canHardSeek(now: number) {
    if (now - this.lastHardSeekAt < HARD_COOLDOWN_MS) return false
    const cutoff = now - SEEK_WINDOW_MS
    while (this.seekStamps.length > 0 && this.seekStamps[0] < cutoff) this.seekStamps.shift()
    return this.seekStamps.length < SEEK_BUDGET
  }

  /**
   * Where B should land.
   *
   * Aiming at A's current position is the obvious choice and the wrong one: the
   * decoder needs `seekLatencyMs` to get there, and A keeps playing throughout,
   * so B lands exactly that far behind — the offset that triggered the seek is
   * still there when the seek completes. Leading the target by the measured
   * latency lands B where A will actually be.
   */
  private seekTargetFor(a: HTMLVideoElement, baseRate: number) {
    const lead = (this.seekLatencyMs / 1000) * baseRate
    let target = a.currentTime + lead
    if (isFinite(a.duration) && a.duration > 0) target = Math.min(target, a.duration - 0.05)
    return Math.max(0, target)
  }

  /** Assign B's rate only when it actually changes — no per-frame writes. */
  private applyRateB(rate: number) {
    const b = this.videoB
    if (!b) return
    if (Math.abs(b.playbackRate - rate) < 1e-4) return
    b.playbackRate = rate
  }

  // ---- Public controls ----

  // Called while the user scrubs — both videos jump to the same position, and
  // the loop stays out of the way until they land. Re-aligning on every
  // intermediate pointer position is what used to fight the drag.
  seek(time: number) {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return
    this.suppressUntil = performance.now() + SETTLE_MS
    a.currentTime = time
    b.currentTime = time
  }

  // Unified play. Start both in the same task — awaiting them one after the
  // other guarantees a startup offset, because B only begins once A's play()
  // promise settles. Then align exactly once, after both have a decodable frame.
  async play() {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return

    await Promise.all([
      a.play().catch(() => undefined), // autoplay block
      b.play().catch(() => undefined),
    ])
    await this.waitUntilReady()
    this.alignNow()
  }

  pause() {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return
    a.pause()
    b.pause()
    // The throttled loop may not have reported the final position yet.
    this.lastTimeUpdateAt = performance.now()
    this.onTimeUpdate?.(a.currentTime)
  }

  setRate(rate: number) {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return
    a.playbackRate = rate
    b.playbackRate = rate
  }

  // ---- Alignment helpers ----

  /** Resolve once both elements can decode at their current position. */
  private waitUntilReady(timeoutMs = READY_TIMEOUT_MS) {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return Promise.resolve()
    const ready = (v: HTMLVideoElement) => v.readyState >= 2 && !v.seeking
    if (ready(a) && ready(b)) return Promise.resolve()

    return new Promise<void>((resolve) => {
      const events = ['loadeddata', 'canplay', 'playing', 'seeked']
      const done = () => {
        clearTimeout(timer)
        for (const e of events) {
          a.removeEventListener(e, check)
          b.removeEventListener(e, check)
        }
        resolve()
      }
      const check = () => {
        if (ready(a) && ready(b)) done()
      }
      const timer = setTimeout(done, timeoutMs)
      for (const e of events) {
        a.addEventListener(e, check)
        b.addEventListener(e, check)
      }
    })
  }

  /**
   * One-shot alignment: put B where A is, then let the loop take over. Used at
   * playback start, where a known offset exists and a single seek is correct.
   */
  private alignNow() {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return
    const now = performance.now()
    const diff = a.currentTime - b.currentTime

    if (Math.abs(diff) > ALIGN_EPSILON && !a.seeking && !b.seeking) {
      b.currentTime = a.currentTime
      this.lastSeekTarget = a.currentTime
      this.lastHardSeekAt = now
      this.seekStamps.push(now)
      this.seekIssuedAt = now
    }
    this.applyRateB(a.playbackRate)
    this.suppressUntil = now + SETTLE_MS
  }
}
