// wm-ripple-gl-standalone.js
// Standalone WebGL2 ripple renderer (no OGL / no external libs)
// Export: default async function initRipple(options)

function cssHexToLinearRGB(hex) {
  const c = hex.replace('#', '').trim();
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const toLin = (v) => Math.pow(v, 2.2);
  return new Float32Array([toLin(r), toLin(g), toLin(b)]);
}

function createShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || 'shader compile failed';
    gl.deleteShader(sh);
    throw new Error(log);
  }
  return sh;
}

function createProgram(gl, vertSrc, fragSrc) {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prg = gl.createProgram();
  gl.attachShader(prg, vs);
  gl.attachShader(prg, fs);
  gl.linkProgram(prg);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prg, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prg) || 'program link failed';
    gl.deleteProgram(prg);
    throw new Error(log);
  }
  return prg;
}

export default async function initRipple(opts = {}) {
  const {
    // DOM
    canvasSelector = '#wm-canvas',

    // Data
    dataUrl = '',

    // Visual/behavior
    targetDotPx = 4,      // approx on-screen “pixel” size of each square
    cornerPct   = 0.12,   // 0..1 (we remap to 0..0.5 in shader)
    seedFraction= 0.20,   // fraction of points acting as ripple origins
    cycleSec    = 10,     // time for one ripple cycle
    rngJitter   = 0.5,    // seconds of random phase jitter
    maxSeeds    = 64,     // cap seeds

    // Perf knobs (optional)
    dprCap      = 2.0,    // clamp devicePixelRatio (e.g., 1.5–2.0)
    fpsCap      = 0,      // 0 = uncapped; otherwise e.g., 45 or 30
  } = opts;

  // 1) Canvas + WebGL2
  const canvas = document.querySelector(canvasSelector);
  if (!canvas) {
    console.error('[wm] Canvas not found:', canvasSelector);
    return;
  }
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    console.error('[wm] WebGL2 not available in this browser.');
    return;
  }

  // 2) Colors from CSS (linear)
  const idleHex   = getComputedStyle(document.documentElement).getPropertyValue('--idle').trim()   || '#276C8C';
  const brightHex = getComputedStyle(document.documentElement).getPropertyValue('--bright').trim() || '#5FDEDE';
  const IDLE   = cssHexToLinearRGB(idleHex);
  const BRIGHT = cssHexToLinearRGB(brightHex);

  // 3) Load grid data
  if (!dataUrl) {
    console.error('[wm] dataUrl is required.');
    return;
  }
  let pts;
  try {
    const res = await fetch(dataUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    pts = await res.json();
  } catch (e) {
    console.error('[wm] Failed to fetch data:', e?.message || e);
    return;
  }
  if (!Array.isArray(pts) || !pts.length) {
    console.error('[wm] Data is empty/invalid.');
    return;
  }

  // 4) Compute bounds & padding (SVG-like viewBox)
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

  // 5) Choose seeds (origins) and per-instance delays
  const indices = Array.from(pts.keys());
  for (let i = indices.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const seedCountBase = Math.round(pts.length * seedFraction);
  const seedCount = Math.max(1, Math.min(maxSeeds, seedCountBase));
  const seedIdxs  = indices.slice(0, seedCount).sort((a, b) => a - b);
  const seeds     = seedIdxs.map(i => pts[i]);
  const seedPhase = seeds.map(() => Math.random() * cycleSec);

  const diag = Math.hypot(vbW, vbH);
  const waveSpeed = diag / (cycleSec * 0.60); // traverse ~60% of bbox per cycle

  const N = pts.length;
  const instCenters = new Float32Array(N * 2);
  const instDelay   = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const p = pts[i];
    instCenters[i * 2 + 0] = p.x;
    instCenters[i * 2 + 1] = p.y;

    // nearest seed → distance → travel time
    let best = Infinity, bestIdx = 0;
    for (let s = 0; s < seeds.length; s++) {
      const S = seeds[s];
      const d = Math.hypot(p.x - S.x, p.y - S.y);
      if (d < best) { best = d; bestIdx = s; }
    }
    const travelSec = best / waveSpeed;
    const jitter    = (Math.random() - 0.5) * rngJitter;
    let phaseSec    = seedPhase[bestIdx] + travelSec + jitter;
    phaseSec = -(phaseSec % cycleSec);
    if (phaseSec === 0) phaseSec = -0.0001;
    instDelay[i] = phaseSec;
  }

  // 6) Geometry: unit quad (2 triangles)
  const quadVerts = new Float32Array([
    -0.5, -0.5,   0.5, -0.5,  -0.5,  0.5,
    -0.5,  0.5,   0.5, -0.5,   0.5,  0.5
  ]);

  // Buffers & VAO
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

  const centerBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, centerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, instCenters, gl.STATIC_DRAW);

  const delayBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, delayBuf);
  gl.bufferData(gl.ARRAY_BUFFER, instDelay, gl.STATIC_DRAW);

  // 7) Shaders (GLSL ES 3.00)
  const vertSrc = `#version 300 es
    layout(location=0) in vec2 aPos;     // quad vertex (-0.5..0.5)
    layout(location=1) in vec2 aCenter;  // instance center (data units)
    layout(location=2) in float aDelay;  // instance delay (seconds)

    uniform vec3 uBounds;  // (vbX, vbY, dotSizeData)
    uniform vec2 uScale;   // data -> NDC
    uniform vec2 uOffset;  // data -> NDC

    out vec2 vLocal;
    out float vDelay;

    void main() {
      vLocal = aPos;
      vDelay = aDelay;
      float s = uBounds.z;                // square size in data units
      vec2 posData = aCenter + aPos * s;  // data-space vertex
      vec2 posNDC  = posData * uScale + uOffset;
      gl_Position  = vec4(posNDC, 0.0, 1.0);
    }`;

  const fragSrc = `#version 300 es
    precision highp float;
    in vec2 vLocal;
    in float vDelay;

    uniform float uTime;
    uniform float uCycle;
    uniform float uCorner; // 0..0.5 in half-size space
    uniform vec3  uIdle;   // linear RGB
    uniform vec3  uBright; // linear RGB

    out vec4 outColor;

    float roundedRectMask(vec2 uv, float corner){
      // uv in [-0.5,0.5]
      vec2 a = abs(uv) - 0.5 + vec2(corner);
      float outside = max(a.x, a.y);
      float m = step(outside, 0.0);
      vec2 q = max(a, 0.0);
      float r = length(q) - corner;
      m *= step(r, 0.0);
      return m;
    }

    float rippleWindow(float tNorm){
      // ~3% fade-in → 7% hold → 90% fade-out
      if (tNorm < 0.03) return smoothstep(0.0, 0.03, tNorm);
      else if (tNorm < 0.10) return 1.0;
      float k = (tNorm - 0.10) / 0.90;
      return 1.0 - k;
    }

    void main(){
      float mask = roundedRectMask(vLocal, clamp(uCorner, 0.0, 0.49));
      if (mask <= 0.0) discard;

      float t = uTime + vDelay;
      float tCycle = mod(t, uCycle);
      float tNorm  = tCycle / uCycle;

      float w = rippleWindow(tNorm);
      vec3 col = mix(uIdle, uBright, w);

      outColor = vec4(col, 1.0);
    }`;

  const program = createProgram(gl, vertSrc, fragSrc);
  gl.useProgram(program);

  // Attribute bindings
  const locPos    = 0;
  const locCenter = 1;
  const locDelay  = 2;

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(locPos);
  gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(locPos, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, centerBuf);
  gl.enableVertexAttribArray(locCenter);
  gl.vertexAttribPointer(locCenter, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(locCenter, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, delayBuf);
  gl.enableVertexAttribArray(locDelay);
  gl.vertexAttribPointer(locDelay, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(locDelay, 1);

  // Uniform locations
  const uBounds = gl.getUniformLocation(program, 'uBounds');
  const uScale  = gl.getUniformLocation(program, 'uScale');
  const uOffset = gl.getUniformLocation(program, 'uOffset');
  const uTime   = gl.getUniformLocation(program, 'uTime');
  const uCycle  = gl.getUniformLocation(program, 'uCycle');
  const uCorner = gl.getUniformLocation(program, 'uCorner');
  const uIdle   = gl.getUniformLocation(program, 'uIdle');
  const uBright = gl.getUniformLocation(program, 'uBright');

  // Static uniforms
  gl.uniform1f(uCycle,  cycleSec);
  gl.uniform1f(uCorner, cornerPct * 0.5); // map 0..1 to 0..0.5 of half-size
  gl.uniform3fv(uIdle,   IDLE);
  gl.uniform3fv(uBright, BRIGHT);

  // Transform mapping data space -> NDC (like SVG viewBox; Y up)
  let dotSizeData = 1;
  function updateTransforms() {
    const sx =  2.0 / vbW;
    const sy = -2.0 / vbH; // flip Y for typical screen coordinates
    const ox = -1.0 - vbX * sx;
    const oy =  1.0 - vbY * sy;
    gl.uniform3f(uBounds, vbX, vbY, dotSizeData);
    gl.uniform2f(uScale,  sx, sy);
    gl.uniform2f(uOffset, ox, oy);
  }

  // Responsive sizing
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dprRaw = Math.max(1, window.devicePixelRatio || 1);
    const dpr = Math.min(dprCap || dprRaw, dprRaw);
    const w = Math.max(1, Math.round(rect.width  * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    const pxPerDataX = (rect.width || 1) / vbW;
    dotSizeData = targetDotPx / Math.max(pxPerDataX, 1e-6);
    updateTransforms();
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // GL state
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);

  // Respect reduced motion & pause when offscreen
  let running = true;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    running = false;
  }
  const io = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries) => {
        for (const e of entries) running = e.isIntersecting;
      })
    : null;
  if (io) io.observe(canvas);

  // Optional FPS cap
  let lastT = 0;
  const minDelta = fpsCap > 0 ? (1000 / fpsCap) : 0;

  function frame(tMs) {
    if (running) {
      if (!minDelta || (tMs - lastT >= minDelta)) {
        lastT = tMs;
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uTime, tMs * 0.001);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, N);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
