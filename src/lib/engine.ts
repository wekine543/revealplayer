/**
 * Engine singleton — holds Three.js objects, video/image elements,
 * and the SyncManager so any component can interact with the render pipeline.
 */
import * as THREE from 'three'
import { SyncManager } from './SyncManager'
import { vertexShader, fragmentShader } from './shaders'
import type { MediaItem } from '../types'

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

  // Callbacks
  onTimeUpdate: ((t: number) => void) | null = null
  onVideoEnded: (() => void) | null = null

  init(canvas: HTMLCanvasElement) {
    this.canvas = canvas

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

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
    this.renderer.setSize(w, h, false)
    if (this.material) {
      this.material.uniforms.aspectRatio.value = w / h
    }
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

      // Set aspect ratio from MediaItem metadata (populated at load time)
      const aspect = (media.width > 0 && media.height > 0) ? media.width / media.height : 1
      if (slot === 'A') {
        this.material.uniforms.mediaAspectA.value = aspect
      } else {
        this.material.uniforms.mediaAspectB.value = aspect
      }

      // Fallback: read actual video dimensions after metadata loads
      video.addEventListener('loadedmetadata', () => {
        if (!this.material) return
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          const a = video.videoWidth / video.videoHeight
          if (slot === 'A') {
            this.material!.uniforms.mediaAspectA.value = a
          } else {
            this.material!.uniforms.mediaAspectB.value = a
          }
        }
      })

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
  }

  setMouseInactive() {
    this.mouseActive = false
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

  private render() {
    if (!this.renderer || !this.scene || !this.camera || !this.material) return

    // Lerp mouse for smooth following
    this.mouseCurrent.lerp(this.mouseTarget, 0.2)
    this.material.uniforms.mouse.value.copy(this.mouseCurrent)
    this.material.uniforms.mouseActive.value = this.mouseActive

    // Update video textures
    if (this.texA instanceof THREE.VideoTexture) this.texA.needsUpdate = true
    if (this.texB instanceof THREE.VideoTexture) this.texB.needsUpdate = true

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
    // Force a render to ensure the latest frame
    this.render()
    return this.canvas.toDataURL('image/png')
  }
}

export const engine = new Engine()
