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

  // Grid ("both at once") mode. See src/lib/grid.ts for the layout maths —
  // these four values are the result of it, precomputed on the CPU.
  uniform bool gridMode;
  uniform bool gridHorizontal;  // true: A left / B right. false: A top / B bottom
  uniform float gridAspect;     // ratio of the two cells joined together
  uniform float gridSplit;      // fraction of the split axis taken by A
  uniform bool gridHasBoth;     // false: a single item gets the whole frame

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

  // Is this UV inside the unit box? Used for the letterbox area and, in grid
  // mode, for each cell.
  float inside(vec2 uv) {
    return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  }

  void main() {
    const vec4 bgColor = vec4(0.05, 0.05, 0.06, 1.0);

    // ---- Grid mode: both media, whole, in two cells ----
    // The two cells are joined into one box of gridAspect, which is then
    // fitted into the canvas exactly the way a single clip is. Because the box
    // is sized from the two clips' own ratios, each cell already matches its
    // media and nothing is cropped or stretched.
    if (gridMode) {
      if (!hasTexA && !hasTexB) {
        gl_FragColor = bgColor;
        return;
      }

      if (!gridHasBoth) {
        // Only one slot loaded — give it the entire frame rather than half of
        // it plus an empty panel. Sampled in a branch rather than mixed, so the
        // empty slot's sampler is never touched.
        if (hasTexA) {
          vec2 uv = containUV(vUv, mediaAspectA, aspectRatio);
          gl_FragColor = mix(bgColor, texture2D(texA, uv), inside(uv));
        } else {
          vec2 uv = containUV(vUv, mediaAspectB, aspectRatio);
          gl_FragColor = mix(bgColor, texture2D(texB, uv), inside(uv));
        }
        return;
      }

      vec2 g = containUV(vUv, gridAspect, aspectRatio);
      if (inside(g) < 0.5) {
        gl_FragColor = bgColor;
        return;
      }

      vec2 cellA;
      vec2 cellB;
      float aspectCellA;
      float aspectCellB;
      bool inFirst;

      if (gridHorizontal) {
        // A on the left half of the split, B on the right.
        cellA = vec2(g.x / gridSplit, g.y);
        cellB = vec2((g.x - gridSplit) / (1.0 - gridSplit), g.y);
        aspectCellA = gridAspect * gridSplit;
        aspectCellB = gridAspect * (1.0 - gridSplit);
        inFirst = g.x < gridSplit;
      } else {
        // A on top (UV y grows upward), B below.
        cellA = vec2(g.x, (g.y - gridSplit) / (1.0 - gridSplit));
        cellB = vec2(g.x, g.y / gridSplit);
        aspectCellA = gridAspect / (1.0 - gridSplit);
        aspectCellB = gridAspect / gridSplit;
        inFirst = g.y >= gridSplit;
      }

      // Contain inside the cell: a no-op for a correct layout, but it keeps a
      // media whose ratio is not what the layout assumed — unknown dimensions,
      // a metadata change — from being stretched.
      cellA = containUV(cellA, mediaAspectA, aspectCellA);
      cellB = containUV(cellB, mediaAspectB, aspectCellB);

      vec4 cA = mix(bgColor, texture2D(texA, cellA), inside(cellA));
      vec4 cB = mix(bgColor, texture2D(texB, cellB), inside(cellB));
      gl_FragColor = inFirst ? cA : cB;
      return;
    }

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
