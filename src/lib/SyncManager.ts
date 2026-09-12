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
 * when one does slip through.
 *
 * Three rules break that loop and make the pair re-lock quickly:
 *
 *   1. ONE seek at a time. A requested seek is only considered landed once the
 *      clock has visibly moved past the request (see seekSettled); until then
 *      the loop does nothing at all.
 *   2. AIM AHEAD by a learned amount. A keeps playing while B's decoder
 *      restarts, so aiming at A's *current* position always lands B behind by
 *      exactly the seek latency — the offset that triggered the seek is still
 *      there when it completes, and the loop seeks again. The lead is not
 *      measured from `seeked` (that timing is polluted whenever a seek is
 *      superseded, and a fixed ceiling then locks in a permanent shortfall);
 *      it is learned from the error at each landing, which converges in one or
 *      two seeks and needs no latency model at all.
 *   3. CLOSE THE REMAINDER with a rate nudge. The soft-sync law is
 *      proportional, so the time it needs is set by RATE_GAIN alone and does
 *      not improve for small offsets. A gain of 0.33 with a 4% cap closed a
 *      200ms offset at 40ms/s — five seconds of visible misalignment, which is
 *      exactly what users complained about. 2.0 with a 12% cap closes the same
 *      offset in under 200ms. Both tracks are muted, so the rate change costs
 *      no pitch and 12% is only visible if you look for it.
 */

/** Inside this offset, leave B alone — below one frame at any sane rate. */
const MICRO = 0.005
/**
 * Above this, a rate nudge is too slow to be worth it; seek instead.
 *
 * A seek costs a decoder restart and a frozen picture for its whole latency;
 * soft sync costs a slightly-fast playback that closes the offset at
 * MAX_ADJUST*rate per second. At 150ms the nudge is done in about 1.25s and is
 * barely visible, while on a slow phone a seek would freeze the picture for
 * longer than that to fix the same thing. So the smaller offsets are handed to
 * the rate nudge on purpose.
 */
const SEEK_AT = 0.15
/** Strongest playbackRate correction for soft sync (±12%). */
const MAX_ADJUST = 0.12
/** Soft-sync gain: correction = offset * GAIN, clamped to ±MAX_ADJUST. */
const RATE_GAIN = 2
/** Minimum gap between two hard syncs, so a seek gets time to land. */
const HARD_COOLDOWN_MS = 300
/** Hard seeks allowed inside SEEK_WINDOW_MS; beyond that, rate nudges only. */
const SEEK_BUDGET = 4
const SEEK_WINDOW_MS = 2500
/**
 * How many consecutive seeks may land still out of sync before we stop trying.
 *
 * A seek that leaves the same offset behind it is not going to fix it: either
 * the offset is growing as fast as we close it (a decoder that cannot play at
 * realtime) or the seek itself keeps knocking it back. Retrying costs a decoder
 * restart and a frozen picture every time, so a user sees B stuttering and
 * never catching up — strictly worse than giving up and letting the rate nudge
 * close what it can, smoothly. Reset by a user seek, which is a fresh
 * situation.
 */
const MAX_SEEK_FAILS = 3
/**
 * First guess for the lead, before any landing has been observed. Typical
 * seek latency is tens of ms on a desktop and a couple of hundred on a phone,
 * so this splits the difference: the first seek lands close, and the error it
 * leaves teaches the controller the real value.
 */
const INITIAL_LEAD_MS = 100
/**
 * Ceiling for the learned lead.
 *
 * This must comfortably exceed the slowest seek the device can produce, or it
 * silently becomes a permanent offset: the target is only ever `lead` ahead of
 * A, so a lead shorter than the real latency leaves B exactly that far behind
 * after every seek, forever — the loop then keeps seeking (freezing B's picture
 * each time) and never closes the gap. Measured on an emulated slow decoder:
 * with the cap at 1500ms and a real latency of ~2600ms, B sat ~1.1s behind and
 * never recovered.
 */
const MAX_LEAD_MS = 3000
/**
 * How much of the landing error to fold into the lead.
 *
 * 1.0 on purpose. The error is not a noisy signal to be damped — it is the
 * measurement: A advanced by exactly the seek's duration while B jumped by
 * `lead`, so `err = duration - lead`, i.e. the true latency is `lead + err`.
 * Folding in all of it therefore makes the very next seek land on target. Any
 * damping leaves the lead short by that fraction, which on a slow device is
 * enough to trip the seek threshold again — and every extra seek freezes B's
 * picture for the full latency. Measured at 1.9s latency: gain 0.9 needed three
 * seeks to converge, gain 1.0 needs two.
 */
const LEAD_GAIN = 1
/** A playing video whose clock has not moved for this long is out of data. */
const STALL_MS = 300
/**
 * How long to wait for a requested seek to visibly land before giving up on it
 * and judging the offset anyway (a seek that never completes must not wedge the
 * loop).
 *
 * Generous on purpose: on a slow phone a long jump can take seconds, and giving
 * up early means judging a stale position and issuing the seek again — which
 * aborts the one still in flight. The `seeking` check is what normally holds
 * the loop, so this only bounds the case where an element reports not-seeking
 * while its clock is still stale.
 */
const LANDING_TIMEOUT_MS = 4000
/** Store writes for the progress bar: 10/s is plenty and avoids 60 re-renders. */
const TIME_UPDATE_MS = 100
/**
 * A drag that has produced no update for this long is over.
 *
 * `beginSeek`/`endSeek` bracket a drag, but the matching "up" event cannot be
 * relied on: on touch, the browser fires `touchcancel` instead of `touchend`
 * whenever it decides the gesture is a scroll, when the finger leaves the
 * element, or when the system interrupts. A missed "up" left `dragging` true
 * forever, which disables the whole sync loop — B then sat wherever it was and
 * never returned to sync, no matter how far behind it had fallen. Rather than
 * trust a second event to arrive, treat silence as the end of the drag: a real
 * drag calls seek() many times per second, so anything this quiet is finished.
 */
const DRAG_IDLE_MS = 600
/** How long to wait for both elements to have a decodable frame before aligning. */
const READY_TIMEOUT_MS = 1500

export class SyncManager {
  private rafId: number | null = null
  private videoA: HTMLVideoElement | null = null
  private videoB: HTMLVideoElement | null = null
  private onTimeUpdate: ((time: number) => void) | null = null

  private lastHardSeekAt = -Infinity
  /** Timestamps of recent hard seeks, pruned to SEEK_WINDOW_MS. */
  private seekStamps: number[] = []
  /** Target of the last hard seek, so the same one is never repeated. */
  private lastSeekTarget = NaN
  /**
   * How far ahead of A to aim B, in ms. Learned: every landing measures the
   * error it left and folds it back in here, so an inaccurate first guess costs
   * one extra seek and then stops mattering.
   */
  private leadMs = INITIAL_LEAD_MS
  /** A hard seek is awaiting its landing, so nothing may be judged yet. */
  private learnPending = false
  /** When the outstanding hard seek was issued, to sanity-check its landing. */
  private seekIssuedAt = 0
  /**
   * When the user's own scrub last wrote B. Its landing is a free, real
   * measurement of this device's seek latency, available before we have issued
   * any corrective seek.
   */
  private userSeekMeasureAt = 0
  /** True until some landing has taught the lead a real value. */
  private leadCold = true
  /**
   * Consecutive seeks that landed still out of sync. Once this reaches
   * MAX_SEEK_FAILS the loop stops seeking — see that constant.
   */
  private seekFailStreak = 0
  /** Set by seek(), consumed by the loop once both elements have landed. */
  private userSeekPending = false
  /** True between beginSeek() and endSeek() — the pointer is on the bar. */
  private dragging = false
  /** When the drag last produced a seek() call, so a lost "up" cannot wedge it. */
  private dragActiveAt = 0

  /** Last seen clock per element, and when it last moved, to spot a starved video. */
  private prevTimeA = -1
  private prevTimeB = -1
  private advancedAtA = 0
  private advancedAtB = 0
  /**
   * When a seek was last requested per element. Until that element's clock has
   * demonstrably moved past this mark, its position cannot be trusted — see
   * seekSettled().
   */
  private requestedSeekAtA = 0
  private requestedSeekAtB = 0

  private lastTimeUpdateAt = 0

  start(
    videoA: HTMLVideoElement,
    videoB: HTMLVideoElement,
    onTimeUpdate?: (time: number) => void,
  ) {
    this.videoA = videoA
    this.videoB = videoB
    this.onTimeUpdate = onTimeUpdate ?? null

    const now = performance.now()
    this.lastHardSeekAt = -Infinity
    this.seekStamps = []
    this.lastSeekTarget = NaN
    this.leadMs = INITIAL_LEAD_MS
    this.learnPending = false
    this.seekIssuedAt = 0
    this.seekFailStreak = 0
    this.userSeekMeasureAt = 0
    this.leadCold = true
    this.userSeekPending = false
    this.dragging = false
    this.dragActiveAt = 0
    this.prevTimeA = -1
    this.prevTimeB = -1
    this.advancedAtA = now
    this.advancedAtB = now
    this.requestedSeekAtA = 0
    this.requestedSeekAtB = 0
    this.lastTimeUpdateAt = 0

    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.loop()
  }

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.videoA = null
    this.videoB = null
    this.onTimeUpdate = null
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
    this.trackAdvance(a, b, now)

    const settledA = this.seekSettled(a, this.advancedAtA, this.requestedSeekAtA, now)
    const settledB = this.seekSettled(b, this.advancedAtB, this.requestedSeekAtB, now)

    // A drag that has gone quiet is over — see DRAG_IDLE_MS. This is the only
    // thing that keeps a missed touchend/touchcancel from disabling the loop
    // for the rest of the session.
    if (this.dragging && now - this.dragActiveAt > DRAG_IDLE_MS) {
      this.dragging = false
      this.userSeekPending = true
    }

    if (this.dragging || a.seeking || b.seeking || !settledA || !settledB) {
      // A seeking element's currentTime is stale, so anything computed now is
      // noise. Note this is not just "is seeking": an element can report
      // `seeking === false` while still reading the pre-seek position, and
      // judging the offset in that window re-issues the seek every frame. So a
      // requested seek is only considered settled once the clock has moved.
      this.rafId = requestAnimationFrame(this.loop)
      return
    }

    if (this.learnPending) {
      // Only a seek that actually landed teaches us anything: one that hit the
      // timeout left B wherever it was, and its "error" is not a lead error.
      this.learnFromLanding(a, b, this.advancedAtB > this.requestedSeekAtB, now)
    } else if (this.userSeekMeasureAt > 0 && this.advancedAtB > this.requestedSeekAtB) {
      // The user's own scrub just landed. That was a real seek on this device,
      // so how long it took is the lead we need — known before we have issued
      // a single corrective seek. Seeding from it saves a whole wasted seek
      // (and its frozen picture) on the first scrub after loading, which is
      // otherwise the worst case: a cold lead means the first correction lands
      // a full latency short and has to be repeated.
      const lat = this.advancedAtB - this.userSeekMeasureAt
      if (this.leadCold && lat > 0) this.leadMs = Math.min(MAX_LEAD_MS, lat)
      this.userSeekMeasureAt = 0
    }

    if (now - this.lastTimeUpdateAt >= TIME_UPDATE_MS) {
      this.lastTimeUpdateAt = now
      this.onTimeUpdate?.(a.currentTime)
    }

    if (a.paused || b.paused) {
      this.rafId = requestAnimationFrame(this.loop)
      return
    }

    if (this.userSeekPending) {
      // The user let go of the bar and both seeks have landed. Re-align once,
      // immediately — this is the case where a slow drift used to be left to
      // soft sync for several seconds.
      this.userSeekPending = false
      this.alignNow()
    } else {
      this.correct(now)
    }

    this.rafId = requestAnimationFrame(this.loop)
  }

  /**
   * Has a requested seek visibly landed?
   *
   * `seeking === false` alone is not a safe signal: there is a window where the
   * element reports not-seeking while `currentTime` still reads the pre-seek
   * position, and a loop that judges the offset there issues the seek again on
   * every frame — a fresh storm in place of the old one. Requiring the clock to
   * have visibly moved since the request is what makes "it landed" unambiguous,
   * and it needs no arbitrary delay. The timeout keeps a seek that never
   * completes from wedging the loop forever.
   */
  private seekSettled(v: HTMLVideoElement, advancedAt: number, requestedAt: number, now: number) {
    if (requestedAt <= 0) return true
    if (v.seeking) return false
    if (advancedAt > requestedAt) return true
    return now - requestedAt > LANDING_TIMEOUT_MS
  }

  /**
   * Fold the error a seek left behind into the lead, so the next one lands
   * closer.
   *
   * This is the whole latency model: we never try to predict how long a seek
   * takes, we just look at where B ended up. If it landed behind by δ, the lead
   * was δ too short; if it landed ahead, δ too long. Note that δ *is* the
   * latency measurement — A advanced by the seek's duration while B jumped by
   * `lead`, so δ = duration - lead. Folding in all of it therefore sets the lead
   * to the measured latency exactly, in one step, however slow the device is;
   * the gain just damps timing noise. Any bound on the step would make a slow
   * device take several seeks to learn its own latency, and each of those seeks
   * freezes B's picture.
   */
  private learnFromLanding(a: HTMLVideoElement, b: HTMLVideoElement, landed: boolean, now: number) {
    this.learnPending = false
    // Only a seek that actually landed, and landed while we were still waiting
    // for it, teaches us anything. A seek that hit the timeout left B wherever
    // it was, and its "error" is not a lead error.
    if (!landed || this.seekIssuedAt <= 0) return
    if (now - this.seekIssuedAt > LANDING_TIMEOUT_MS) return
    const err = a.currentTime - b.currentTime // > 0 → B landed behind
    this.leadCold = false
    this.seekFailStreak = Math.abs(err) > SEEK_AT ? this.seekFailStreak + 1 : 0
    this.leadMs = Math.max(0, Math.min(MAX_LEAD_MS, this.leadMs + err * 1000 * LEAD_GAIN))
  }

  /** Note when each clock last moved, so a starved element can be spotted. */
  private trackAdvance(a: HTMLVideoElement, b: HTMLVideoElement, now: number) {
    if (a.currentTime !== this.prevTimeA) {
      this.prevTimeA = a.currentTime
      this.advancedAtA = now
    }
    if (b.currentTime !== this.prevTimeB) {
      this.prevTimeB = b.currentTime
      this.advancedAtB = now
    }
  }

  /**
   * Is this element starved of data? A video that is out of data has a frozen
   * clock, so comparing against it would report a "drift" that is really just
   * buffering, and any correction would have to be undone once data arrives.
   * Detected from the clock rather than from `waiting`/`playing` events, which
   * can get out of step if one of the pair never fires.
   */
  private isStalled(v: HTMLVideoElement, advancedAt: number, now: number) {
    if (v.paused || v.seeking) return false
    return now - advancedAt > STALL_MS
  }

  /** Compare B against A and apply the cheapest correction that will work. */
  private correct(now: number) {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return

    // A starved element has no reliable clock to compare against.
    if (this.isStalled(a, this.advancedAtA, now) || this.isStalled(b, this.advancedAtB, now)) return
    if (a.readyState < 2 || b.readyState < 2) return

    const diff = a.currentTime - b.currentTime // > 0 → B is behind
    const absDiff = Math.abs(diff)
    const baseRate = a.playbackRate

    if (absDiff <= MICRO) {
      this.applyRateB(baseRate)
      return
    }

    if (absDiff <= SEEK_AT) {
      // Soft sync: proportional, so a 10ms error does not get the same kick as
      // a 90ms one — that is what makes a fixed ±2% toggle ring.
      const adjust = Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, diff * RATE_GAIN))
      this.applyRateB(baseRate * (1 + adjust))
      return
    }

    // Large offset. A rate nudge would need about a second to close it, so seek
    // — but only if the budget allows, and never to a target we just used.
    if (this.canHardSeek(now) && !(Math.abs(a.currentTime - this.lastSeekTarget) <= MICRO)) {
      this.hardSeek(a, b, now)
      this.applyRateB(baseRate)
      return
    }

    // Out of seek budget: fall back to the strongest nudge available so the
    // offset still closes, just more slowly.
    this.applyRateB(baseRate * (1 + (diff > 0 ? MAX_ADJUST : -MAX_ADJUST)))
  }

  /** Rolling-window rate limit on hard seeks. */
  private canHardSeek(now: number) {
    // Seeking has stopped helping — see MAX_SEEK_FAILS. Freezing B's picture
    // again would only make it stutter more without closing the offset.
    if (this.seekFailStreak >= MAX_SEEK_FAILS) return false
    if (now - this.lastHardSeekAt < HARD_COOLDOWN_MS) return false
    const cutoff = now - SEEK_WINDOW_MS
    while (this.seekStamps.length > 0 && this.seekStamps[0] < cutoff) this.seekStamps.shift()
    return this.seekStamps.length < SEEK_BUDGET
  }

  /** Seek B onto where A will be, leading by the learned amount. */
  private hardSeek(a: HTMLVideoElement, b: HTMLVideoElement, now: number) {
    const target = this.seekTargetFor(a)
    this.lastSeekTarget = target
    this.lastHardSeekAt = now
    this.seekStamps.push(now)
    this.learnPending = true
    this.seekIssuedAt = now
    this.requestedSeekAtB = now
    b.currentTime = target
  }

  /**
   * Where B should land.
   *
   * Aiming at A's current position is the obvious choice and the wrong one: the
   * decoder needs some time to get there, and A keeps playing throughout, so B
   * lands exactly that far behind — the offset that triggered the seek is still
   * there when the seek completes. Leading by the learned amount lands B where
   * A will actually be by then.
   */
  private seekTargetFor(a: HTMLVideoElement) {
    const lead = (this.leadMs / 1000) * a.playbackRate
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

  /** The pointer went down on the progress bar. */
  beginSeek() {
    this.dragging = true
    this.dragActiveAt = performance.now()
  }

  /**
   * The pointer came off the progress bar: align once as soon as both land.
   *
   * The loop also ends a drag on its own if this never arrives (see
   * DRAG_IDLE_MS), because on touch the browser is free to send `touchcancel`
   * instead of `touchend`.
   */
  endSeek() {
    this.dragging = false
    this.userSeekPending = true
  }

  // Called while the user scrubs — both videos jump to the same position, and
  // the loop stays out of the way until they land. Re-aligning on every
  // intermediate pointer position is what used to fight the drag.
  seek(time: number) {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return
    const now = performance.now()
    this.userSeekPending = true
    this.dragActiveAt = now
    this.requestedSeekAtA = now
    this.requestedSeekAtB = now
    // A scrub is a fresh episode: whatever the seek budget was spent on before,
    // re-locking after this drag is exactly what the budget is for.
    this.seekStamps = []
    this.lastHardSeekAt = -Infinity
    this.seekFailStreak = 0
    this.userSeekMeasureAt = now
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
    await this.waitReady()
    this.userSeekPending = false
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

  /**
   * Resolve once both elements are ready at their current position.
   *
   * `minReadyState` matters: 2 (HAVE_CURRENT_DATA) means a frame exists, which is
   * enough to draw one. 3 (HAVE_FUTURE_DATA) means enough is buffered to play
   * FORWARD, which is what "B has finished loading" actually means — and it is
   * the difference between a follower that starts on time and one that stalls a
   * beat behind.
   */
  waitReady(minReadyState = 2, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return Promise.resolve()
    const ready = (v: HTMLVideoElement) => v.readyState >= minReadyState && !v.seeking
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
   * Put B exactly where A is, with NO lead, and wait for it to land.
   *
   * Only correct while both elements are parked, and that is the whole point of
   * the pause-then-align route: the lead exists purely to compensate for A
   * advancing while B's decoder restarts, so a parked A means there is nothing
   * to compensate for. No latency estimate, no learning, no landing error — the
   * two clocks end up identical by construction rather than by convergence.
   *
   * Nothing is learned from this seek either: with A stationary the landing
   * error carries no information about how long the seek took.
   */
  async alignPaused(landingTimeoutMs = LANDING_TIMEOUT_MS): Promise<void> {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return
    const target = a.currentTime
    this.learnPending = false
    this.lastSeekTarget = target
    this.requestedSeekAtB = performance.now()
    b.currentTime = target
    await this.waitForLanding(landingTimeoutMs)
  }

  /**
   * Resolve once the outstanding seek on B has visibly landed, or give up.
   *
   * The loop already knows how to do this, but that gate is not awaitable, and a
   * caller that starts both elements needs to be sure before it does.
   */
  private waitForLanding(timeoutMs = LANDING_TIMEOUT_MS): Promise<void> {
    if (!this.videoB) return Promise.resolve()
    const deadline = performance.now() + timeoutMs
    return new Promise((resolve) => {
      const tick = () => {
        if (this.advancedAtB > this.requestedSeekAtB || performance.now() > deadline) {
          resolve()
          return
        }
        setTimeout(tick, 16)
      }
      tick()
    })
  }

  /**
   * One-shot alignment: put B where A is (leading by the learned amount), then
   * let the loop take over. Used at playback start and at the end of a user
   * scrub — the two moments where a known offset exists and a single seek is
   * the correct answer.
   *
   * Below SEEK_AT the remainder is left to soft sync on purpose: a seek costs
   * B a visible freeze while its decoder restarts, and that is a worse trade
   * than a few hundred milliseconds of imperceptible rate nudge.
   */
  private alignNow() {
    const a = this.videoA
    const b = this.videoB
    if (!a || !b) return
    const now = performance.now()

    if (Math.abs(a.currentTime - b.currentTime) > SEEK_AT && !a.seeking && !b.seeking) {
      this.hardSeek(a, b, now)
    }
    this.applyRateB(a.playbackRate)
  }
}
