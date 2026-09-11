// Vertex shader — pass through UVs
export const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Fragment shader — mask blending with feather & border
// Implements "object-fit: contain" for both textures (preserves aspect ratio)
export const fragmentShader = /* glsl */`
  uniform sampler2D texA;
  uniform sampler2D texB;
  uniform vec2 mouse;
  uniform float radius;
  uniform float feather;
  uniform bool mouseActive;
  uniform bool borderEnabled;
  uniform float borderWidth;
  uniform vec3 borderColor;
  uniform float borderOpacity;
  uniform float aspectRatio;    // canvas aspect (w/h)
  uniform bool hasTexA;
  uniform bool hasTexB;
  uniform float mediaAspectA;   // mediaA width/height
  uniform float mediaAspectB;   // mediaB width/height

  varying vec2 vUv;

  // Adjust UV for "contain" fit: preserve media aspect ratio within canvas
  vec2 containUV(vec2 uv, float mediaAspect, float canvasAspect) {
    vec2 adjusted = uv;
    if (mediaAspect > canvasAspect) {
      // Media wider than canvas — letterbox top & bottom
      float scale = canvasAspect / mediaAspect;  // fraction of canvas height the media occupies
      adjusted.y = (uv.y - 0.5) / scale + 0.5;
    } else {
      // Media taller than canvas — letterbox left & right
      float scale = mediaAspect / canvasAspect;  // fraction of canvas width the media occupies
      adjusted.x = (uv.x - 0.5) / scale + 0.5;
    }
    return adjusted;
  }

  void main() {
    const vec4 bgColor = vec4(0.05, 0.05, 0.06, 1.0);

    // Compute aspect-ratio-corrected UVs for each texture
    vec2 uvA = hasTexA ? containUV(vUv, mediaAspectA, aspectRatio) : vUv;
    vec2 uvB = hasTexB ? containUV(vUv, mediaAspectB, aspectRatio) : vUv;

    // Check if adjusted UVs are within [0,1] bounds (outside = letterbox area)
    float inA = step(0.0, uvA.x) * step(uvA.x, 1.0) * step(0.0, uvA.y) * step(uvA.y, 1.0);
    float inB = step(0.0, uvB.x) * step(uvB.x, 1.0) * step(0.0, uvB.y) * step(uvB.y, 1.0);

    // Sample textures
    vec4 colorA = hasTexA ? mix(bgColor, texture2D(texA, uvA), inA) : bgColor;
    vec4 colorB = hasTexB ? mix(bgColor, texture2D(texB, uvB), inB) : bgColor;

    // If mouse inactive or missing textures, show A only
    if (!mouseActive || !hasTexA || !hasTexB) {
      gl_FragColor = colorA;
      return;
    }

    // Correct for canvas aspect ratio so the mask is circular on screen
    vec2 diff = vUv - mouse;
    diff.x *= aspectRatio;
    float dist = length(diff);

    // Base mask: 1 inside, 0 outside, feathered edge
    float mask = 1.0 - smoothstep(radius - feather, radius, dist);

    // Blend A and B
    vec4 finalColor = mix(colorA, colorB, mask);

    // Border ring
    if (borderEnabled) {
      float borderStart = radius - borderWidth * 0.5;
      float borderEnd = radius + borderWidth * 0.5;
      float borderMask = smoothstep(borderStart - feather * 0.5, borderStart, dist)
                       * (1.0 - smoothstep(borderEnd, borderEnd + feather * 0.5, dist));
      vec4 borderCol = vec4(borderColor, borderOpacity);
      finalColor = mix(finalColor, borderCol, borderMask);
    }

    gl_FragColor = finalColor;
  }
`
