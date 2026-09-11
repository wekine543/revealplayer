import { useStore } from '../store/useStore'

export function MaskControls() {
  const mask = useStore((s) => s.maskSettings)
  const setMask = useStore((s) => s.setMaskSettings)

  // UV-space values (0-1) are used internally for the shader.
  // We present pixel-ish equivalents in the UI for usability.
  // radius: 0.02-0.5  (UV) → display as 20-500px range (approx)
  const radiusPx = Math.round(mask.radius * 1000)
  const featherPx = Math.round(mask.feather * 1000)
  const borderPx = Math.round(mask.borderWidth * 1000)

  return (
    <div className="space-y-3">
      {/* Radius */}
      <div>
        <label className="flex items-center justify-between text-xs text-gray-400 mb-1">
          <span>Radius</span>
          <span className="font-mono text-gray-300">{radiusPx}px</span>
        </label>
        <input
          type="range"
          min={20}
          max={500}
          step={5}
          value={radiusPx}
          onChange={(e) => setMask({ radius: parseInt(e.target.value) / 1000 })}
          className="w-full accent-brand-400"
        />
      </div>

      {/* Feather */}
      <div>
        <label className="flex items-center justify-between text-xs text-gray-400 mb-1">
          <span>Feather</span>
          <span className="font-mono text-gray-300">{featherPx}px</span>
        </label>
        <input
          type="range"
          min={0}
          max={100}
          step={2}
          value={featherPx}
          onChange={(e) => setMask({ feather: parseInt(e.target.value) / 1000 })}
          className="w-full accent-brand-400"
        />
      </div>

      {/* Divider */}
      <div className="h-px bg-white/5" />

      {/* Border toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">Border</span>
        <button
          onClick={() => setMask({ borderEnabled: !mask.borderEnabled })}
          className={`relative w-9 h-5 rounded-full transition-colors ${mask.borderEnabled ? 'bg-brand-500' : 'bg-white/10'}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200 ${mask.borderEnabled ? 'translate-x-4' : 'translate-x-0'}`}
          />
        </button>
      </div>

      {/* Border width */}
      {mask.borderEnabled && (
        <>
          <div>
            <label className="flex items-center justify-between text-xs text-gray-400 mb-1">
              <span>Border Width</span>
              <span className="font-mono text-gray-300">{borderPx}px</span>
            </label>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={borderPx}
              onChange={(e) => setMask({ borderWidth: parseInt(e.target.value) / 1000 })}
              className="w-full accent-brand-400"
            />
          </div>

          {/* Border color */}
          <div>
            <label className="flex items-center justify-between text-xs text-gray-400 mb-1">
              <span>Border Color</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={mask.borderColor}
                onChange={(e) => setMask({ borderColor: e.target.value })}
                className="w-8 h-8 rounded-md bg-transparent border border-white/10 cursor-pointer"
              />
              <div className="flex gap-1">
                {['#ffffff', '#000000', '#ff4444', '#44ff44', '#4488ff', '#ffdd44'].map((c) => (
                  <button
                    key={c}
                    onClick={() => setMask({ borderColor: c })}
                    className="w-5 h-5 rounded-full border border-white/20"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Border opacity */}
          <div>
            <label className="flex items-center justify-between text-xs text-gray-400 mb-1">
              <span>Border Opacity</span>
              <span className="font-mono text-gray-300">{Math.round(mask.borderOpacity * 100)}%</span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={mask.borderOpacity}
              onChange={(e) => setMask({ borderOpacity: parseFloat(e.target.value) })}
              className="w-full accent-brand-400"
            />
          </div>
        </>
      )}

      {/* Tip */}
      <p className="text-xs text-gray-600 pt-1">
        Tip: scroll on the canvas to adjust mask radius
      </p>
    </div>
  )
}
