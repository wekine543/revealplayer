/**
 * Engine singleton — holds Three.js objects, video/image elements,
 * and the SyncManager so any component can interact with the render pipeline.
 */
import * as THREE from 'three'
import { SyncManager } from './SyncManager'
import { vertexShader, fragmentShader } from './shaders'
import type { MediaItem } from '../types'

// ---- Render quality ceilings -------------------------------------------------
// Single place to tune if a phone is still struggling.
const MOBILE_MAX_DPR = 1.5
const MOBILE_MAX_BUFFER_W = 1280  // 720p, wide edge
const MOBILE_MAX_BUFFER_H = 720   // 720p, tall edge
const DESKTOP_MAX_DPR = 2
/** Never scale below this or the picture turns to mush. */
const MIN_DPR = 0.5

/**
 * Long-edge cap for a video texture.
 *
 * This is the lever that actually scales with the SOURCE resolution, which the
 * output-resolution caps above do not touch. Using a <video> directly as a
 * texture uploads one full-size image every frame: a 4K frame is ~33 MB, and at
 * 30 fps that is ~1 GB/s of bus traffic, which is what stalls a phone. Scaling
 * the frame into a canvas first so the upload is 720p-sized cuts that by ~9x.
 *
 * Sources already at or below the cap keep the direct video-texture path, so
 * nothing regresses for small clips.
 */
const TEXTURE_MAX_LONG_EDGE = 1280

/** Offscreen downscale target, used only when a video exceeds the cap above. */
interface VideoScaler {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

/**
 * Build a downscale target for a video, or null when it is already small enough
 * to upload directly.
 */
function createScaler(video: HTMLVideoElement): VideoScaler | null {
  const srcW = video.videoWidth
  const srcH = video.videoHeight
  if (srcW <= 0 || srcH <= 0) return null

  const longEdge = Math.max(srcW, srcH)
  if (longEdge <= TEXTURE_MAX_LONG_EDGE) return null

  const scale = TEXTURE_MAX_LONG_EDGE / longEdge
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
  mediaA: MediaItem | null = null
  mediaB: MediaItem | null = null

  // Sync
  sync = new SyncManager()

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
  private maxBufferW = Infinity
  private maxBufferH = Infinity
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

  // Callbacks
  onTimeUpdate: ((t: number) => void) | null = null
  onVideoEnded: (() => void) | null = null

  init(canvas: HTMLCanvasElement) {
    this.canvas = canvas

    // Decide the quality tier once, at startup.
    const coarsePointer =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    const smallScreen = Math.min(window.innerWidth, window.innerHeight) <= 900
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent)
    this.isMobileDevice = mobileUA || (coarsePointer && smallScreen)

    if (this.isMobileDevice) {
      this.qualityDpr = MOBILE_MAX_DPR
      this.maxBufferW = MOBILE_MAX_BUFFER_W
      this.maxBufferH = MOBILE_MAX_BUFFER_H
    } else {
      this.qualityDpr = DESKTOP_MAX_DPR
      this.maxBufferW = Infinity
      this.maxBufferH = Infinity
    }

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
        `buffer cap ${isFinite(this.maxBufferW) ? `${this.maxBufferW}x${this.maxBufferH}` : 'unlimited'} · ` +
        `texture cap ${TEXTURE_MAX_LONG_EDGE}px`,
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

    // Effective pixel ratio: the device DPR capped by the quality ceiling, then
    // reduced further so the drawing buffer stays within the resolution limit
    // (720p on mobile). Shading fewer pixels helps, but note this only bounds
    // the OUTPUT — the per-frame video upload is bounded separately, by
    // TEXTURE_MAX_LONG_EDGE.
    let dpr = Math.min(window.devicePixelRatio || 1, this.qualityDpr)
    if (isFinite(this.maxBufferW)) dpr = Math.min(dpr, this.maxBufferW / w)
    if (isFinite(this.maxBufferH)) dpr = Math.min(dpr, this.maxBufferH / h)
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
      video.loop = this._loopEnabled
      video.src = media.url

      // Handle ended event when not looping
      video.addEventListener('ended', () => {
        if (!this._loopEnabled) {
          this.onVideoEnded?.()
        }
      })

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
      texture.colorSpace = THREE.SRGBColorSpace

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
          texture.colorSpace = THREE.SRGBColorSpace

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
   * Confirms the aspect ratio, and for a clip larger than TEXTURE_MAX_LONG_EDGE
   * swaps the direct video texture for a CanvasTexture that receives a
   * scaled-down copy of each frame. Uploading raw frames is the cost that grows
   * with the source resolution, so this is where large clips are tamed.
   */
  private applyVideoMeta(slot: 'A' | 'B', video: HTMLVideoElement) {
    if (!this.material) return

    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw > 0 && vh > 0) {
      const a = vw / vh
      if (slot === 'A') this.material.uniforms.mediaAspectA.value = a
      else this.material.uniforms.mediaAspectB.value = a
    }

    // Already small enough — keep uploading the video frame directly.
    const scaler = createScaler(video)
    if (!scaler) return

    const tex = new THREE.CanvasTexture(scaler.canvas)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    // Deliberately NOT SRGBColorSpace.
    //
    // The fragment shader is a raw ShaderMaterial that writes gl_FragColor
    // directly, so Three.js never appends its output sRGB conversion. Marking a
    // texture as sRGB makes the GPU linearise it on sample, and those linear
    // values then reach the framebuffer unconverted — the picture comes out
    // visibly dark (measured ~75 average luma vs ~119 for the video path).
    // A plain video texture is effectively not linearised, so matching that
    // keeps the scaled path looking identical to the direct one.
    tex.colorSpace = THREE.NoColorSpace

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

  setLoop(enabled: boolean) {
    this._loopEnabled = enabled
    const vA = this.elA instanceof HTMLVideoElement ? this.elA : null
    const vB = this.elB instanceof HTMLVideoElement ? this.elB : null
    if (vA) vA.loop = enabled
    if (vB) vB.loop = enabled
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
    // there is nothing to redraw for it — see uploadVideoFrame().
    if (this.mouseActive) {
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
    if (slot === 'B' && !this.mouseActive) return

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
