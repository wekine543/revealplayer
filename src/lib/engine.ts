/**
 * Engine singleton — holds Three.js objects, video/image elements,
 * and the SyncManager so any component can interact with the render pipeline.
 */
import * as THREE from 'three'
import { SyncManager } from './SyncManager'
import { vertexShader, fragmentShader } from './shaders'
import { isMobileDevice } from './device'
import { qualityById, defaultQualityId, type QualityId, type QualityLevel } from './quality'
import { gridLayout } from './grid'
import { parkMedia } from './media'
import type { MediaItem } from '../types'

// ---- Render quality ceilings -------------------------------------------------
// The resolution caps are user-selectable (原画 / 1080P / 720P / 480P) and live in
// lib/quality.ts. What stays here is the ceiling on the DISPLAY side, which is a
// separate concern: the drawing buffer is capped by device pixel ratio, so a
// high-DPI phone does not shade four times the pixels for no visible gain.
const MOBILE_MAX_DPR = 1.5
const DESKTOP_MAX_DPR = 2
/** Never scale below this or the picture turns to mush. */
const MIN_DPR = 0.5
/**
 * Budget for the WHOLE parked resync, in milliseconds — waiting for both
 * elements to be ready to play forward (readyState >= HAVE_FUTURE_DATA),
 * aligning, and settling.
 *
 * This is a budget, not a per-call timeout: the two waits and the alignment
 * share it, so the pause the user sees is bounded by this number regardless of
 * how slow the follower is. It is deliberately small — pausing for long enough
 * to notice is worse than a pair that needs one correction afterwards, which
 * the running loop already knows how to do.
 *
 * The two call sites do not need the same budget:
 *
 *  - LOOP: the clip just hit `ended`, so the decoder is already parked at the
 *    tail and the jump back to 0 is a rewind into data that is still buffered.
 *    It is also a moment with nothing to interrupt — the picture is already
 *    frozen on the last frame — so a longer pause buys nothing the user can
 *    see. Kept at 250ms.
 *  - SCRUB: the user picked an arbitrary point, so both decoders usually have to
 *    restart from a distant keyframe and refill from scratch, and the pause
 *    lands in the middle of intentional interaction. Given the larger budget
 *    (400ms) — long enough for a slow follower to finish, still short enough to
 *    read as immediate.
 */
const LOOP_RESYNC_BUDGET_MS = 250
const SCRUB_RESYNC_BUDGET_MS = 400

/** Offscreen downscale target, used only when a video exceeds the tier's cap. */
interface VideoScaler {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

/**
 * Every texture in this app must be uploaded with NO colour-space conversion.
 *
 * The fragment shader is a plain ShaderMaterial that writes `gl_FragColor`
 * directly, so Three.js never appends its output sRGB encoding (that lives in
 * the `colorspace_fragment` chunk, which custom shaders do not include). The
 * drawing buffer is sRGB, so whatever the sampler returns is what the user
 * sees — meaning the bytes have to go through untouched or the picture comes
 * out wrong.
 *
 * Marking a texture `SRGBColorSpace` instead makes Three.js pick the
 * `SRGB8_ALPHA8` internal format, and the GPU then linearises it on sample.
 * Those linear values reach the framebuffer unconverted, i.e. the picture is
 * displayed about 35% too dark.
 *
 * Videos never showed this, which is what made the bug look image-specific:
 * `getInternalFormat()` is called with `forceLinearTransfer = texture.isVideoTexture`,
 * so a VideoTexture is uploaded as plain RGBA8 **whatever its colorSpace says**.
 * Images get no such exemption — hence "images are dark, videos are fine".
 */
const TEXTURE_COLOR_SPACE = THREE.NoColorSpace

/**
 * Build a downscale target for a video, or null when it is already small enough
 * to upload directly.
 *
 * This is the lever that actually scales with the SOURCE resolution. Using a
 * <video> directly as a texture uploads one full-size image every frame: a 4K
 * frame is ~33 MB, and at 30 fps that is ~1 GB/s of bus traffic, which is what
 * stalls a phone. Scaling the frame into a canvas first so the upload is
 * capped-sized cuts that by ~9x at 720P.
 *
 * `longEdgeCap` comes from the active quality tier; Infinity means the tier asks
 * for the source resolution and this returns null so the direct video-texture
 * path is used.
 */
function createScaler(video: HTMLVideoElement, longEdgeCap: number): VideoScaler | null {
  const srcW = video.videoWidth
  const srcH = video.videoHeight
  if (srcW <= 0 || srcH <= 0) return null
  if (!isFinite(longEdgeCap)) return null

  const longEdge = Math.max(srcW, srcH)
  if (longEdge <= longEdgeCap) return null

  const scale = longEdgeCap / longEdge
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(srcW * scale))
  canvas.height = Math.max(2, Math.round(srcH * scale))

  // alpha:false is cheaper and lets the driver skip a blending path.
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null

  return { canvas, ctx }
}

class Engine {
  // Three.js
  renderer: THREE.WebGLRenderer | null = null
  scene: THREE.Scene | null = null
  camera: THREE.OrthographicCamera | null = null
  plane: THREE.Mesh | null = null
  material: THREE.ShaderMaterial | null = null
  texA: THREE.Texture | null = null
  texB: THREE.Texture | null = null

  // Media elements
   elA: HTMLVideoElement | HTMLImageElement | null = null
   elB: HTMLVideoElement | HTMLImageElement | null = null
   /** Undo the off-screen parking of the slot's video element, if any. */
   private unparkA: (() => void) | null = null
   private unparkB: (() => void) | null = null
  mediaA: MediaItem | null = null
  mediaB: MediaItem | null = null

  // Sync
  sync = new SyncManager()

  /**
   * Grid mode: the two media are shown whole, side by side, instead of B being
   * revealed through A. Owned here rather than in the store because it changes
   * what the renderer uploads every frame, not just what the UI shows.
   */
  gridMode = false

  // Render loop
  private rafId: number | null = null
  canvas: HTMLCanvasElement | null = null

  // Mouse smoothing
  private mouseTarget = new THREE.Vector2(0.5, 0.5)
  private mouseCurrent = new THREE.Vector2(0.5, 0.5)
  private mouseActive = false

  // Loop
  private _loopEnabled = false

  // ---- Quality / performance ----
  // Phones choke on high-resolution WebGL, and the cost grows with the video
  // texture size. On mobile-class devices we cap the device pixel ratio, cap
  // the drawing buffer to 720p, drop MSAA, and skip frames when nothing is
  // moving — all of which cut GPU work and heat (heat causes throttling, which
  // is what actually shows up as stutter).
  private isMobileDevice = false
  private qualityDpr = DESKTOP_MAX_DPR
  /** Active user-selected tier. Its caps replace the old hardcoded ones. */
  private quality: QualityLevel = qualityById(defaultQualityId())
  /** Set whenever something visually changed, so the idle loop knows to draw. */
  private dirty = true
  /**
   * currentTime of the last video frame uploaded per slot. Video frames arrive
   * at the source's frame rate, which is usually lower than the display's, so
   * this lets us skip re-uploading and re-drawing identical frames.
   */
  private uploadedTimeA = -1
  private uploadedTimeB = -1
  /**
   * Set only for oversized videos. When present, the decoded frame is scaled
   * into this canvas and the canvas is uploaded instead of the raw video frame.
   */
  private scalerA: VideoScaler | null = null
  private scalerB: VideoScaler | null = null

  /** True when the mobile render caps are in effect (useful for a UI hint). */
  get lowPowerMode() {
    return this.isMobileDevice
  }

  /** The active quality tier's id, for the UI to reflect. */
  get qualityId(): QualityId {
    return this.quality.id
  }

  /**
   * Switch quality tier.
   *
   * The caps take effect in two places, and both have to be re-applied for an
   * already-loaded clip: the drawing buffer (resize) and the per-frame texture
   * upload (the scaler, which may need creating OR removing — going up a tier
   * has to hand the slot back to the direct video-texture path).
   */
  setQuality(id: QualityId) {
    if (this.quality.id === id) return
    this.quality = qualityById(id)
    console.info(
      `[RevealPlayer] quality: ${this.quality.label} · ` +
        `buffer cap ${isFinite(this.quality.bufferW) ? `${this.quality.bufferW}x${this.quality.bufferH}` : 'unlimited'} · ` +
        `texture cap ${isFinite(this.quality.textureLongEdge) ? `${this.quality.textureLongEdge}px` : 'source'}`,
    )
    if (this.elA instanceof HTMLVideoElement) this.applyVideoMeta('A', this.elA)
    if (this.elB instanceof HTMLVideoElement) this.applyVideoMeta('B', this.elB)
    this.resize()
  }

  // Callbacks
  onTimeUpdate: ((t: number) => void) | null = null
  onVideoEnded: (() => void) | null = null

  init(canvas: HTMLCanvasElement) {
    this.canvas = canvas

    // Decide the display-side tier once, at startup.
    this.isMobileDevice = isMobileDevice()
    this.qualityDpr = this.isMobileDevice ? MOBILE_MAX_DPR : DESKTOP_MAX_DPR

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // MSAA is expensive on mobile and buys little here: the mask edge, feather
      // and border ring are all produced by smoothstep gradients in the shader.
      antialias: !this.isMobileDevice,
      // Only desktop keeps the drawing buffer. On mobile it forces the driver to
      // copy every frame; captureScreenshot() renders synchronously right before
      // reading, which works without it.
      preserveDrawingBuffer: !this.isMobileDevice,
      powerPreference: this.isMobileDevice ? 'default' : 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.qualityDpr))

    // Worth having in the log when someone is chasing playback stutter.
    console.info(
      `[RevealPlayer] quality tier: ${this.isMobileDevice ? 'mobile' : 'desktop'} · ` +
        `max DPR ${this.qualityDpr} · ` +
        `selected ${this.quality.label} · ` +
        `buffer cap ${isFinite(this.quality.bufferW) ? `${this.quality.bufferW}x${this.quality.bufferH}` : 'unlimited'} · ` +
        `texture cap ${isFinite(this.quality.textureLongEdge) ? `${this.quality.textureLongEdge}px` : 'source'}`,
    )

    // Scene & camera
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10)
    this.camera.position.z = 1

    // Plane
    const geometry = new THREE.PlaneGeometry(2, 2)
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        texA: { value: null },
        texB: { value: null },
        mouse: { value: new THREE.Vector2(0.5, 0.5) },
        radius: { value: 0.15 },
        feather: { value: 0.02 },
        mouseActive: { value: false },
        borderEnabled: { value: true },
        borderWidth: { value: 0.003 },
        borderColor: { value: new THREE.Color(0xffffff) },
        borderOpacity: { value: 0.8 },
        aspectRatio: { value: 1 },
        hasTexA: { value: false },
        hasTexB: { value: false },
        mediaAspectA: { value: 1 },
        mediaAspectB: { value: 1 },
        gridMode: { value: false },
        gridHorizontal: { value: true },
        gridAspect: { value: 16 / 9 },
        gridSplit: { value: 0.5 },
        gridHasBoth: { value: false },
      },
    })
    this.plane = new THREE.Mesh(geometry, this.material)
    this.scene.add(this.plane)

    this.resize()
    this.startRenderLoop()
  }

  dispose() {
    this.stopRenderLoop()
    this.sync.stop()
    this.disposeTexture('A')
    this.disposeTexture('B')
    if (this.plane) {
      this.plane.geometry.dispose()
      this.plane = null
    }
    if (this.material) {
      this.material.dispose()
      this.material = null
    }
    if (this.renderer) {
      this.renderer.dispose()
      this.renderer = null
    }
    this.canvas = null
  }

  resize() {
    if (!this.canvas || !this.renderer) return
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w === 0 || h === 0) return

    // Effective pixel ratio: the device DPR capped by the display ceiling, then
    // reduced further so the drawing buffer stays within the selected tier's
    // resolution limit. Shading fewer pixels helps, but note this only bounds
    // the OUTPUT — the per-frame video upload is bounded separately, by the
    // tier's texture cap.
    let dpr = Math.min(window.devicePixelRatio || 1, this.qualityDpr)
    if (isFinite(this.quality.bufferW)) dpr = Math.min(dpr, this.quality.bufferW / w)
    if (isFinite(this.quality.bufferH)) dpr = Math.min(dpr, this.quality.bufferH / h)
    dpr = Math.max(dpr, MIN_DPR)

    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h, false)
    if (this.material) {
      this.material.uniforms.aspectRatio.value = w / h
    }
    this.dirty = true
  }

  // ---- Texture management ----

  setMedia(slot: 'A' | 'B', media: MediaItem | null) {
    if (slot === 'A') {
      this.mediaA = media
      this.disposeTexture('A')
      if (media) this.createTexture('A', media)
    } else {
      this.mediaB = media
      this.disposeTexture('B')
      if (media) this.createTexture('B', media)
    }
    this.updateSyncManager()
    this.updateHasTextures()
  }

  private createTexture(slot: 'A' | 'B', media: MediaItem) {
    if (!this.material) return

    if (media.type === 'video') {
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      // Native looping stays off — see handleVideoEnded.
      video.loop = false
      // Mobile Safari will not decode a <video> that is not in the document, so a
      // detached element (fine on desktop) leaves a phone with a black canvas and
      // no error. Parked off-screen, and taken back out in disposeTexture.
      if (slot === 'A') {
        this.unparkA?.()
        this.unparkA = parkMedia(video)
      } else {
        this.unparkB?.()
        this.unparkB = parkMedia(video)
      }
      video.src = media.url

      // Looping is handled here rather than by the browser's own `loop`:
      // native looping restarts each element independently, so the pair drifts
      // apart across loops. Restarting from a parked alignment instead puts them
      // back on the same clock every time.
      video.addEventListener('ended', this.handleVideoEnded)

      // Handle video load errors
      video.addEventListener('error', () => {
        console.error(`Video load error for slot ${slot}:`, video.error)
      })

      // The first decoded frame arrives asynchronously, and the idle render loop
      // may already have stopped by then — so redraw whenever new pixel data or
      // a new seek position becomes available, otherwise the canvas would stay
      // black until the user happened to press play.
      video.addEventListener('loadeddata', () => { this.dirty = true })
      video.addEventListener('seeked', () => { this.dirty = true })
      video.addEventListener('playing', () => { this.dirty = true })

      // Set aspect ratio from MediaItem metadata (populated at load time)
      const aspect = (media.width > 0 && media.height > 0) ? media.width / media.height : 1
      if (slot === 'A') {
        this.material.uniforms.mediaAspectA.value = aspect
      } else {
        this.material.uniforms.mediaAspectB.value = aspect
      }

      const texture = new THREE.VideoTexture(video)
      texture.minFilter = THREE.LinearFilter
      texture.magFilter = THREE.LinearFilter
      texture.colorSpace = TEXTURE_COLOR_SPACE

      if (slot === 'A') {
        this.elA = video
        this.texA = texture
        this.material.uniforms.texA.value = texture
      } else {
        this.elB = video
        this.texB = texture
        this.material.uniforms.texB.value = texture
      }

      // Once the real dimensions are known, confirm the aspect ratio and — for
      // an oversized clip — switch to the downscaling upload path.
      const onMeta = () => this.applyVideoMeta(slot, video)
      video.addEventListener('loadedmetadata', onMeta)
      // A cached clip may already have metadata, in which case the event never
      // fires and the downscale path would never be set up.
      if (video.readyState >= 1) onMeta()
    } else {
      const loader = new THREE.TextureLoader()
      loader.setCrossOrigin('anonymous')
      loader.load(
        media.url,
        (texture) => {
          texture.minFilter = THREE.LinearFilter
          texture.magFilter = THREE.LinearFilter
          // Not SRGBColorSpace — see TEXTURE_COLOR_SPACE. This is the line that
          // made imported images come out visibly dark while videos looked fine.
          texture.colorSpace = TEXTURE_COLOR_SPACE

          if (slot === 'A') {
            if (this.texA) this.texA.dispose()
            this.elA = null
            this.texA = texture
            if (this.material) {
              this.material.uniforms.texA.value = texture
              const img = texture.image as { width: number; height: number } | undefined
              if (img && img.width > 0 && img.height > 0) {
                this.material.uniforms.mediaAspectA.value = img.width / img.height
              }
            }
          } else {
            if (this.texB) this.texB.dispose()
            this.elB = null
            this.texB = texture
            if (this.material) {
              this.material.uniforms.texB.value = texture
              const img = texture.image as { width: number; height: number } | undefined
              if (img && img.width > 0 && img.height > 0) {
                this.material.uniforms.mediaAspectB.value = img.width / img.height
              }
            }
          }

          // CRITICAL: update hasTex flags after async image load completes
          this.updateHasTextures()
        },
        undefined,
        (err) => {
          console.error(`Failed to load image texture for slot ${slot}:`, err)
        },
      )
    }
  }

  /**
   * Called once a video's dimensions are known.
   *
   * Confirms the aspect ratio, and for a clip larger than the active tier's
   * texture cap swaps the direct video texture for a CanvasTexture that receives
   * a scaled-down copy of each frame. Uploading raw frames is the cost that
   * grows with the source resolution, so this is where large clips are tamed.
   */
  private applyVideoMeta(slot: 'A' | 'B', video: HTMLVideoElement) {
    if (!this.material) return

    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw > 0 && vh > 0) {
      const a = vw / vh
      if (slot === 'A') this.material.uniforms.mediaAspectA.value = a
      else this.material.uniforms.mediaAspectB.value = a
      // The real dimensions may differ from the ones probed at load time, so
      // the grid has to be recomputed — otherwise the container is sized from
      // stale numbers and the picture is letterboxed inside it.
      this.updateGridUniforms()
    }

    // Called both when metadata arrives and whenever the user changes quality,
    // so it has to handle BOTH directions: create the downscale path when the
    // clip exceeds the tier's cap, and hand the slot back to the direct
    // video-texture path when it no longer does (going up a tier).
    const scaler = createScaler(video, this.quality.textureLongEdge)
    const currentScaler = slot === 'A' ? this.scalerA : this.scalerB

    if (!scaler) {
      if (currentScaler) {
        // Drop the CanvasTexture and go back to uploading the video frame.
        const direct = new THREE.VideoTexture(video)
        direct.minFilter = THREE.LinearFilter
        direct.magFilter = THREE.LinearFilter
        direct.colorSpace = TEXTURE_COLOR_SPACE
        if (slot === 'A') {
          if (this.texA) this.texA.dispose()
          this.texA = direct
          this.scalerA = null
          this.material.uniforms.texA.value = direct
          this.uploadedTimeA = -1
        } else {
          if (this.texB) this.texB.dispose()
          this.texB = direct
          this.scalerB = null
          this.material.uniforms.texB.value = direct
          this.uploadedTimeB = -1
        }
        this.dirty = true
      }
      // Logged on every call, not just when switching away from the scaled
      // path: "this clip is uploaded whole" is exactly the fact a quality-tier
      // test needs to see, and on a first load at 原画 nothing else would say it.
      console.info(
        `[RevealPlayer] media ${slot}: ${vw}x${vh} source — uploading full frames ` +
          `(${this.quality.label}${isFinite(this.quality.textureLongEdge) ? `, cap ${this.quality.textureLongEdge}px` : ''})`,
      )
      return
    }

    const tex = new THREE.CanvasTexture(scaler.canvas)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    // See TEXTURE_COLOR_SPACE. Matching the direct path is what keeps a scaled
    // clip looking identical to an unscaled one.
    tex.colorSpace = TEXTURE_COLOR_SPACE

    if (slot === 'A') {
      if (this.texA) this.texA.dispose()
      this.texA = tex
      this.scalerA = scaler
      this.material.uniforms.texA.value = tex
      // Forget the previous upload position so the first scaled frame is drawn.
      this.uploadedTimeA = -1
    } else {
      if (this.texB) this.texB.dispose()
      this.texB = tex
      this.scalerB = scaler
      this.material.uniforms.texB.value = tex
      this.uploadedTimeB = -1
    }

    console.info(
      `[RevealPlayer] media ${slot}: ${vw}x${vh} source — ` +
        `scaled to ${scaler.canvas.width}x${scaler.canvas.height} before texture upload ` +
        `(${Math.round((1 - (scaler.canvas.width * scaler.canvas.height) / (vw * vh)) * 100)}% less per frame)`,
    )
    this.dirty = true
  }

  private disposeTexture(slot: 'A' | 'B') {
    if (slot === 'A') {
      this.unparkA?.()
      this.unparkA = null
      if (this.elA instanceof HTMLVideoElement) {
        this.elA.pause()
        this.elA.removeAttribute('src')
        this.elA.load()
      }
      this.elA = null
      if (this.texA) {
        this.texA.dispose()
        this.texA = null
      }
      // Forget the uploaded frame position: a replacement video could legitimately
      // sit at the same currentTime, and we still need its first frame drawn.
      this.uploadedTimeA = -1
      this.scalerA = null
      if (this.material) {
        this.material.uniforms.texA.value = null
        this.material.uniforms.mediaAspectA.value = 1
      }
    } else {
      this.unparkB?.()
      this.unparkB = null
      if (this.elB instanceof HTMLVideoElement) {
        this.elB.pause()
        this.elB.removeAttribute('src')
        this.elB.load()
      }
      this.elB = null
      if (this.texB) {
        this.texB.dispose()
        this.texB = null
      }
      this.uploadedTimeB = -1
      this.scalerB = null
      if (this.material) {
        this.material.uniforms.texB.value = null
        this.material.uniforms.mediaAspectB.value = 1
      }
    }
  }

  private updateHasTextures() {
    if (!this.material) return
    this.material.uniforms.hasTexA.value = this.texA !== null
    this.material.uniforms.hasTexB.value = this.texB !== null
    this.updateGridUniforms()
    this.dirty = true
  }

  // ---- Grid ("both at once") mode ----

  /**
   * Switch between the reveal mask and the two-cell grid.
   *
   * Media B only reaches the screen inside the mask, so while the mask is closed
   * the engine deliberately stops uploading its frames (see uploadVideoFrame).
   * In grid mode B is always visible, so that shortcut has to be lifted and the
   * next frame forced, otherwise B would show a stale frame until something else
   * happened to redraw it.
   */
  setGridMode(enabled: boolean) {
    if (this.gridMode === enabled) return
    this.gridMode = enabled
    this.uploadedTimeB = -1
    this.updateGridUniforms()
    this.dirty = true
  }

  /**
   * Recompute where the two cells are. Cheap, and it is the one place the
   * layout is derived, so the picture and the container can never disagree.
   */
  private updateGridUniforms() {
    if (!this.material) return
    const u = this.material.uniforms
    const aA = u.hasTexA.value ? (u.mediaAspectA.value as number) : null
    const aB = u.hasTexB.value ? (u.mediaAspectB.value as number) : null
    const layout = gridLayout(aA, aB)
    u.gridMode.value = this.gridMode
    u.gridHorizontal.value = layout.horizontal
    u.gridAspect.value = layout.aspect
    u.gridSplit.value = layout.split
    u.gridHasBoth.value = layout.hasBoth
    this.dirty = true
  }

  // ---- SyncManager ----

  private updateSyncManager() {
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    const vB = this.elB instanceof HTMLVideoElement ? this.elB : null

    if (vA && vB) {
      // Both are videos — start sync
      this.sync.start(vA, vB, (t) => {
        this.onTimeUpdate?.(t)
      })
    } else {
      this.sync.stop()
      // Single video time tracking is handled in render loop
    }
  }

  // ---- Unified playback control (works with 1 or 2 videos) ----

  async play() {
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    const vB = this.elB instanceof HTMLVideoElement ? this.elB : null
    // Draw at least once immediately, even if playback takes a moment to start.
    this.dirty = true
    if (vA && vB) {
      await this.sync.play()
    } else {
      if (vA) { try { await vA.play() } catch { /* autoplay block */ } }
      if (vB) { try { await vB.play() } catch { /* autoplay block */ } }
    }
  }

  pause() {
    this.sync.pause()
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    const vB = this.elB instanceof HTMLVideoElement ? this.elB : null
    if (vA) vA.pause()
    if (vB) vB.pause()
    // Draw once more so the frozen frame is definitely the current one.
    this.dirty = true
  }

  /**
   * Park both elements, bring B exactly onto A, then start them together.
   *
   * This is the answer to "the misalignment all comes from B loading a beat slow
   * when playback starts". Correcting a RUNNING pair means aiming ahead of A by
   * an estimated seek latency, and every attempt freezes B's picture for its
   * full duration. Correcting a PARKED pair removes both problems:
   *
   *   - A is not advancing, so B has as long as it needs to finish its seek and
   *     fill its buffer — the waiting is invisible instead of showing up as a
   *     follower that falls behind while it loads.
   *   - the alignment target does not move, so no lead is needed at all and the
   *     two clocks end up identical by construction (see alignPaused), rather
   *     than by a latency estimate converging over several seeks.
   *
   * `resume` restores the state the caller found the player in: a scrub while
   * paused must not start playback as a side effect.
   *
   * `budgetMs` is the total time this may hold the pause, shared by both waits
   * and the alignment (see the two constants above).
   */
  async realignAndResume(
    resume: boolean,
    time?: number,
    budgetMs: number = SCRUB_RESYNC_BUDGET_MS,
  ): Promise<void> {
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    const vB = this.elB instanceof HTMLVideoElement ? this.elB : null
    if (!vA || !vB) return

    if (typeof time === 'number') this.seek(time)

    // Park first. This is what stops A running away from a follower that is
    // still seeking, and it is why the alignment below needs no lead.
    this.pause()

    // HAVE_FUTURE_DATA rather than HAVE_CURRENT_DATA: a single decoded frame is
    // not the same as being able to play on, and it is the difference between
    // "B has finished loading" and "B has one frame and will stall again".
    // Whatever the budget, if the follower is still loading when it runs out we
    // start anyway rather than hold the pause any longer.
    const deadline = performance.now() + budgetMs
    const left = () => Math.max(0, deadline - performance.now())
    await this.sync.waitReady(3, left())
    await this.sync.alignPaused(left())
    await this.sync.waitReady(3, left())

    if (resume) await this.sync.play()
    this.dirty = true
  }

  seek(time: number) {
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    const vB = this.elB instanceof HTMLVideoElement ? this.elB : null
    if (vA && vB) {
      this.sync.seek(time)
    } else {
      if (vA) vA.currentTime = time
      if (vB) vB.currentTime = time
    }
    this.onTimeUpdate?.(time)
    this.dirty = true
  }

  /** The user grabbed the progress bar. */
  beginSeek() {
    this.sync.beginSeek()
  }

  /** The user let go — the pair re-aligns once both seeks land. */
  endSeek() {
    this.sync.endSeek()
  }

  /** Volume and mute are per slot, so the two sources can be balanced. */
  setVolume(slot: 'A' | 'B', volume: number, muted: boolean) {
    const el = slot === 'A' ? this.elA : this.elB
    if (!(el instanceof HTMLVideoElement)) return
    el.volume = volume
    el.muted = muted
  }

  setRate(rate: number) {
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    const vB = this.elB instanceof HTMLVideoElement ? this.elB : null
    if (vA && vB) {
      this.sync.setRate(rate)
    } else {
      if (vA) vA.playbackRate = rate
      if (vB) vB.playbackRate = rate
    }
  }

  /**
   * The intentional A→B time offset, in seconds. Positive = B ahead of A.
   *
   * The value lives in SyncManager, which is where every comparison between the
   * two clocks happens. It is kept across setMedia() on purpose — it describes
   * the pair being compared, and reloading one slot should not quietly undo it.
   */
  setSyncOffset(sec: number) {
    this.sync.setOffset(sec)
  }

  /**
   * Restart from the top, aligned, when either clip finishes.
   *
   * "Either", not just A: if B is the shorter clip it would otherwise sit frozen
   * at its last frame while A plays on, which looks like a bug.
   */
  private handleVideoEnded = () => {
    if (this._loopEnabled) {
      void this.realignAndResume(true, 0, LOOP_RESYNC_BUDGET_MS)
      return
    }
    this.onVideoEnded?.()
  }

  setLoop(enabled: boolean) {
    this._loopEnabled = enabled
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    const vB = this.elB instanceof HTMLVideoElement ? this.elB : null
    // Native looping stays off — handleVideoEnded restarts both together.
    if (vA) vA.loop = false
    if (vB) vB.loop = false
  }

  // ---- Mouse interaction ----

  setMouseFromEvent(clientX: number, clientY: number) {
    if (!this.canvas) return
    const rect = this.canvas.getBoundingClientRect()
    const x = (clientX - rect.left) / rect.width
    const y = 1.0 - (clientY - rect.top) / rect.height
    this.mouseTarget.set(x, y)
    this.mouseActive = true
    this.dirty = true
  }

  setMouseInactive() {
    this.mouseActive = false
    this.dirty = true
  }

  // ---- Mask settings ----

  updateMaskUniforms(settings: {
    radius: number
    feather: number
    borderEnabled: boolean
    borderWidth: number
    borderColor: string
    borderOpacity: number
  }) {
    if (!this.material) return
    const u = this.material.uniforms
    u.radius.value = settings.radius
    u.feather.value = settings.feather
    u.borderEnabled.value = settings.borderEnabled
    u.borderWidth.value = settings.borderWidth
    ;(u.borderColor.value as THREE.Color).set(settings.borderColor)
    u.borderOpacity.value = settings.borderOpacity
    this.dirty = true
  }

  // ---- Render loop ----

  private startRenderLoop() {
    if (this.rafId !== null) return
    const loop = () => {
      this.render()
      this.rafId = requestAnimationFrame(loop)
    }
    loop()
  }

  private stopRenderLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  /**
   * Has a playing video decoded a frame we have not drawn yet?
   *
   * Video arrives at the source's frame rate (often 24/25/30 fps) while the
   * display runs at 60 Hz or more, so a naive loop draws and uploads the same
   * frame two or three times. Uploading a 1080p frame moves ~8 MB, which makes
   * this the cheapest large saving available for big videos.
   */
  private videoFramePending(): boolean {
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    if (vA && !vA.paused && !vA.ended && vA.currentTime !== this.uploadedTimeA) return true

    // Media B is only on screen while the mask is open, so while it is closed
    // there is nothing to redraw for it — see uploadVideoFrame(). In grid mode
    // B has its own cell and is visible the whole time.
    if (this.mouseActive || this.gridMode) {
      const vB = this.elB instanceof HTMLVideoElement ? this.elB : null
      if (vB && !vB.paused && !vB.ended && vB.currentTime !== this.uploadedTimeB) return true
    }

    return false
  }

  /**
   * Is there any reason to draw this frame?
   *
   * Drawing continuously while paused burns battery and heats the device, and
   * heat is what makes a phone throttle and stutter. The canvas keeps showing
   * its last frame, so skipping is invisible.
   */
  private needsFrame(): boolean {
    if (this.videoFramePending()) return true

    // The mask is still easing toward the pointer.
    if (this.mouseCurrent.distanceToSquared(this.mouseTarget) > 1e-7) return true

    // Something changed: media, mask settings, resize, pointer enter/leave.
    return this.dirty
  }

  /** Upload a slot's video texture, but only when its frame actually advanced. */
  private uploadVideoFrame(slot: 'A' | 'B') {
    // Media B is invisible while the mask is closed — the shader returns media A
    // alone. Its decode keeps running (so it stays in sync with A), but there is
    // no point pushing ~4-8 MB per frame to the GPU for something nobody can
    // see. The moment the mask opens, the stale timestamp below makes the next
    // frame upload immediately, still perfectly in sync.
    // In grid mode B has its own cell, so it is always worth uploading.
    if (slot === 'B' && !this.mouseActive && !this.gridMode) return

    const el = slot === 'A' ? this.elA : this.elB
    if (!(el instanceof HTMLVideoElement)) return

    const tex = slot === 'A' ? this.texA : this.texB
    if (!tex) return

    const t = el.currentTime
    if (t === (slot === 'A' ? this.uploadedTimeA : this.uploadedTimeB)) return

    const scaler = slot === 'A' ? this.scalerA : this.scalerB
    if (scaler && tex instanceof THREE.CanvasTexture) {
      // No decoded pixels yet — leave the slot pending so the next tick retries.
      if (el.readyState < 2) return
      scaler.ctx.drawImage(el, 0, 0, scaler.canvas.width, scaler.canvas.height)
      tex.needsUpdate = true
    } else if (tex instanceof THREE.VideoTexture) {
      tex.needsUpdate = true
    } else {
      return
    }

    if (slot === 'A') this.uploadedTimeA = t
    else this.uploadedTimeB = t
  }

  private render() {
    if (!this.renderer || !this.scene || !this.camera || !this.material) return
    if (!this.needsFrame()) return
    this.dirty = false

    // Lerp mouse for smooth following
    this.mouseCurrent.lerp(this.mouseTarget, 0.2)
    this.material.uniforms.mouse.value.copy(this.mouseCurrent)
    this.material.uniforms.mouseActive.value = this.mouseActive

    // Update video textures — only the frames that are actually new
    this.uploadVideoFrame('A')
    this.uploadVideoFrame('B')

    // Track single video time (when only one of A/B is video)
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    const vB = this.elB instanceof HTMLVideoElement ? this.elB : null
    if (vA && !vB && !vA.paused) {
      this.onTimeUpdate?.(vA.currentTime)
    } else if (vB && !vA && !vB.paused) {
      this.onTimeUpdate?.(vB.currentTime)
    }

    this.renderer.render(this.scene, this.camera)
  }

  // ---- Screenshot ----

  captureScreenshot(): string | null {
    if (!this.renderer || !this.canvas) return null
    // Force a fresh frame (the loop may be idle-skipping) and read it back in
    // the same task, which works even on mobile where we don't keep the
    // drawing buffer around.
    this.dirty = true
    this.render()
    return this.canvas.toDataURL('image/png')
  }
}

export const engine = new Engine()
