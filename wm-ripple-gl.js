// wm-ripple-gl.js
// GPU ripple grid using OGL (WebGL instancing)
// Usage from HTML:
//   <script type="module">
//     import initRipple from "https://cdn.jsdelivr.net/gh/YOUR_USER/YOUR_REPO@main/wm-ripple-gl.js";
//     initRipple({ canvasSelector:'#wm-canvas', dataUrl:'.../2mapData.json' });
//   </script>

import { Renderer, Geometry, Program, Mesh } from 'https://cdn.jsdelivr.net/npm/ogl@0.0.104/dist/ogl.mjs';

export default async function initRipple(opts = {}) {
  const {
    canvasSelector = '#wm-canvas',
    dataUrl = '',
    targetDotPx = 4,     // approximate on-screen square size in pixels
    cornerPct = 0.12,    // 0..0.5 (as fraction of half-size)
    seedFraction = 0.20, // fraction of points that act as ripple seeds
    cycleSec = 10,       // seconds for one ripple cycle
    rngJitter = 0.5,     // seconds ± jitter to desync rings
    maxSeeds = 64,       // uniform budget cap (visual looks same with 32–64)
    powerPreference = 'high-performance' // 'high-performance' | 'default' | 'low-power'
  } = opts;

  // Find canvas
  const canvas = document.querySelector(canvasSelector);
  if (!canvas) {
    console.error('[wm-ripple-gl] Canvas not found:', canvasSelector);
    return;
  }

  // Read CSS variables for colors (sRGB hex)
  const idleHex   = getComputedStyle(document.documentElement).getPropertyValue('--idle').trim() || '#276C8C';
  const brightHex = getComputedStyle(document.documentElement).getPropertyValue('--bright').trim() || '#5FDEDE';

  // Convert sRGB hex -> approximate linear RGB (simple gamma ≈ 2.2)
  const cssHexToLinearRGB = (hex) => {
    const c = hex.replace('#','');
    const r = parseInt(c.slice(0,2),16) / 255;
    const g = parseInt(c.slice(2,4),16) / 255;
    const b = parseInt(c.slice(4,6),16) / 255;
    const toLin = v => Math.pow(v, 2.2);
    return [toLin(r), toLin(g), toLin(b)];
  };
  const IDLE   = cssHexToLinearRGB(idleHex);
  const BRIGHT = cssHexToLinearRGB(brightHex);

  // Create renderer
  const renderer = new Renderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference
  });
  const gl = renderer.gl;

  // Fetch point data
  if (!dataUrl) {
    console.error('[wm-ripple-gl] Missing dataUrl.');
    return;
  }
  let pts;
  try {
    const res = await fetch(dataUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    pts = await res.json();
  } catch (err) {
    console.error('[wm-ripple-gl] Data fetch failed:', dataUrl, err);
    return;
  }
  if (!Array.isArray(pts) || !pts.length) {
    console.error('[wm-ripple-gl] Data empty or invalid:', dataUrl);
    return;
  }

  // Compute padded bounds (like your SVG viewBox)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxR = 0;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if ((p.r || 0) > maxR) maxR = p.r || 0;
  }
  const pad = Math.max(maxR, 1);
  const vbX = minX - pad, vbY = minY - pad;
  const vbW = (maxX - minX) + pad * 2;
  const vbH = (maxY - minY) + pad * 2;

  // Responsive sizing: derive data-unit size for a ~targetDotPx square
  let dotSizeData = 1;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height);
    const pxPerDataX = (rect.width || 1) / vbW;
    dotSizeData = targetDotPx / Math.max(pxPerDataX, 1e-6);
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // Choose seed points (Fisher-Yates shuffle, then take first N)
  const indices = Array.from(pts.keys());
  for (let i = indices.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const seedCount = Math.max(1, Math.min(maxSeeds, Math.round(pts.length * seedFraction)));
  const seedIdxs = indices.slice(0, seedCount).sort((a,b)=>a-b);
  const seeds = seedIdxs.map(i => pts[i]);
  const seedPhase = seeds.map(() => Math.random() * cycleSec); // seconds

  // Wave speed: cross most of the map in ~60% of cycle
  const diag = Math.hypot(vbW, vbH);
  const waveSpeed = diag / (cycleSec * 0.60); // data units / second

  // Build per-instance attributes: centers + per-instance phase delay
  const N = pts.length;
  const instanceXY = new Float32Array(N * 2);
  const instanceDelay = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = pts[i];
    instanceXY[i*2 + 0] = p.x;
    instanceXY[i*2 + 1] = p.y;

    // nearest seed
    let bestDist = Infinity, bestIdx = 0;
    for (let s = 0; s < seeds.length; s++) {
      const S = seeds[s];
      const d = Math.hypot(p.x - S.x, p.y - S.y);
      if (d < bestDist) { bestDist = d; bestIdx = s; }
    }
    const travelSec = bestDist / waveSpeed;
    const jitter = (Math.random() - 0.5) * rngJitter; // ±
    let phaseSec = seedPhase[bestIdx] + travelSec + jitter;
    // convert to negative delay within [-cycleSec, 0)
    phaseSec = -(phaseSec % cycleSec);
    if (phaseSec === 0) phaseSec = -0.0001;
    instanceDelay[i] = phaseSec;
  }

  // Geometry: unit quad (two triangles), instanced attributes for center & delay
  const quad = {
    position: { size: 2, data: new Float32Array([
      -0.5, -0.5,
       0.5, -0.5,
      -0.5,  0.5,
      -0.5,  0.5,
       0.5, -0.5,
       0.5,  0.5
    ])},
    iCenter: { instanced: 1, size: 2, data: instanceXY },
    iDelay:  { instanced: 1, size: 1, data: instanceDelay },
  };
  const geometry = new Geometry(gl, quad);

  // Shaders: rounded squares + ripple timing in fragment shader
  const vertex = /* glsl */`
    attribute vec2 position;
    attribute vec2 iCenter;
    attribute float iDelay;
    uniform vec3 uBounds;  // (vbX, vbY, dotSizeData)
    uniform vec2 uScale;   // data->NDC scale
    uniform vec2 uOffset;  // data->NDC offset
    varying vec2 vLocal;   // -0.5..0.5 quad coords (for rounding)
    varying float vDelay;  // per-instance delay (seconds)
    void main() {
      vLocal = position;
      vDelay = iDelay;
      float s = uBounds.z; // data-unit square size
      vec2 posData = iCenter + position * s;
      vec2 posNDC  = posData * uScale + uOffset;
      gl_Position  = vec4(posNDC, 0.0, 1.0);
    }`;

  const fragment = /* glsl */`
    precision highp float;
    varying vec2 vLocal;
    varying float vDelay;

    uniform float uTime;     // seconds
    uniform float uCycle;    // seconds per cycle
    uniform float uCorner;   // 0..0.5 of half-size
    uniform vec3  uIdle;     // linear RGB
    uniform vec3  uBright;   // linear RGB

    // Crisp rounded-rect mask; vLocal in [-0.5, 0.5]
    float roundedRectMask(vec2 uv, float corner) {
      vec2 a = abs(uv) - 0.5 + vec2(corner);
      float outside = max(a.x, a.y);
      float m = step(outside, 0.0);
      vec2 q = max(a, 0.0);
      float r = length(q) - corner;
      m *= step(r, 0.0);
      return m;
    }

    // Matches your CSS timing:
    //  0–3%  quick fade-in
    //  3–10% hold bright
    // 10–100% long fade-out
    float rippleWindow(float tNorm) {
      if (tNorm < 0.03) {
        return smoothstep(0.0, 0.03, tNorm);
      } else if (tNorm < 0.10) {
        return 1.0;
      } else {
        float k = (tNorm - 0.10) / 0.90;
        return 1.0 - k;
      }
    }

    void main() {
      float mask = roundedRectMask(vLocal, clamp(uCorner, 0.0, 0.49));
      if (mask <= 0.0) discard;

      float t = uTime + vDelay;
      float tCycle = mod(t, uCycle);
      float tNorm  = tCycle / uCycle;

      float w = rippleWindow(tNorm);
      vec3 col = mix(uIdle, uBright, w);

      gl_FragColor = vec4(col, 1.0);
    }`;

  const program = new Program(gl, {
    vertex,
    fragment,
    uniforms: {
      uBounds:   { value: new Float32Array([vbX, vbY, dotSizeData]) },
      uScale:    { value: new Float32Array([0, 0]) },
      uOffset:   { value: new Float32Array([0, 0]) },
      uTime:     { value: 0 },
      uCycle:    { value: cycleSec },
      uCorner:   { value: cornerPct * 0.5 }, // percentage of half-size
      uIdle:     { value: new Float32Array(IDLE) },
      uBright:   { value: new Float32Array(BRIGHT) },
    }
  });

  const mesh = new Mesh(gl, { geometry, program });

  // Data->NDC transform (fit bounds to clip space, flip Y to feel like SVG)
  function updateTransforms() {
    const sx =  2.0 / vbW;
    const sy = -2.0 / vbH;
    const ox = -1.0 - vbX * sx;
    const oy =  1.0 - vbY * sy;
    program.uniforms.uScale.value[0]  = sx;
    program.uniforms.uScale.value[1]  = sy;
    program.uniforms.uOffset.value[0] = ox;
    program.uniforms.uOffset.value[1] = oy;
    program.uniforms.uBounds.value[2] = dotSizeData;
  }
  updateTransforms();

  // Pause when offscreen (battery/CPU saver)
  let running = true;
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    for (const e of entries) {
      running = e.isIntersecting;
    }
  }) : null;
  if (io) io.observe(canvas);

  // Respect reduced motion (freeze at low-intensity frame)
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    running = false;
    program.uniforms.uTime.value = 0.0;
    renderer.render({ scene: mesh });
  }

  // Main loop
  function animate(tMs) {
    if (running) {
      program.uniforms.uTime.value = tMs * 0.001;
      renderer.render({ scene: mesh });
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Keep transforms in sync on resize
  window.addEventListener('resize', () => { resize(); updateTransforms(); }, { passive: true });
}

