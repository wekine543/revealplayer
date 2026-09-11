/**
 * SyncManager — keeps two video elements frame-synchronized.
 * A is the master clock; B follows via rAF calibration.
 */
export class SyncManager {
  private rafId: number | null = null
  private videoA: HTMLVideoElement | null = null
  private videoB: HTMLVideoElement | null = null
  private onTimeUpdate: ((time: number) => void) | null = null

  private static readonly THRESHOLD = 0.04   // 40ms — hard sync
  private static readonly MICRO = 0.005      // 5ms  — below this, no adjustment
  private static readonly ADJUST = 0.02      // ±2% playbackRate for soft sync

  start(
    videoA: HTMLVideoElement,
    videoB: HTMLVideoElement,
    onTimeUpdate?: (time: number) => void,
  ) {
    this.videoA = videoA
    this.videoB = videoB
    this.onTimeUpdate = onTimeUpdate ?? null
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.loop()
  }

  private loop = () => {
    if (!this.videoA || !this.videoB) return

    if (!this.videoA.paused && !this.videoB.paused) {
      const diff = this.videoA.currentTime - this.videoB.currentTime
      const absDiff = Math.abs(diff)

      if (absDiff > SyncManager.THRESHOLD) {
        // Hard sync — jump B to A
        this.videoB.currentTime = this.videoA.currentTime
        this.videoB.playbackRate = this.videoA.playbackRate
      } else if (absDiff > SyncManager.MICRO) {
        // Soft sync — micro-adjust playbackRate
        const baseRate = this.videoA.playbackRate
        if (diff > 0) {
          // B is behind — speed up
          this.videoB.playbackRate = baseRate * (1 + SyncManager.ADJUST)
        } else {
          // B is ahead — slow down
          this.videoB.playbackRate = baseRate * (1 - SyncManager.ADJUST)
        }
      } else {
        this.videoB.playbackRate = this.videoA.playbackRate
      }
    }

    this.onTimeUpdate?.(this.videoA.currentTime)
    this.rafId = requestAnimationFrame(this.loop)
  }

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  // Called when seeking — both videos jump
  seek(time: number) {
    if (!this.videoA || !this.videoB) return
    this.videoA.currentTime = time
    this.videoB.currentTime = time
  }

  // Unified play
  async play() {
    if (!this.videoA || !this.videoB) return
    try { await this.videoA.play() } catch { /* autoplay block */ }
    try { await this.videoB.play() } catch { /* autoplay block */ }
  }

  // Unified pause
  pause() {
    if (!this.videoA || !this.videoB) return
    this.videoA.pause()
    this.videoB.pause()
  }

  // Unified rate change
  setRate(rate: number) {
    if (!this.videoA || !this.videoB) return
    this.videoA.playbackRate = rate
    this.videoB.playbackRate = rate
  }
}
