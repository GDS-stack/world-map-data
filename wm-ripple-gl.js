// wm-ripple-gl.js — resilient OGL loader (UMD -> global alias -> ESM fallbacks) + ripple render

/* -------------------------------------------
   Utilities
------------------------------------------- */
async function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(true);
    s.onerror = (e) => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

function pickGlobalOGL() {
  // Some builds attach to window.OGL, others (older/alt) to window.ogl
  if (window.OGL) return window.OGL;
  if (window.ogl) return window.ogl;
  return null;
}

/* -------------------------------------------
   Robust OGL loader
   Order: (1) Use existing global -> (2) Try UMD scripts -> (3) ESM dynamic imports
------------------------------------------- */
async function ensureOGL() {
  // (1) Already present?
  let og = pickGlobalOGL();
  if (og) { console.info('[wm] Using preexisting OGL global.'); return og; }

  // (2) Try UMD scripts (attach a global)
  const UMD_CANDIDATES = [
    // Local copy in your repo (recommended) — resolves next to this module under jsDelivr:
    new URL('./ogl.umd.js', import.meta.url).href,

    // Known CDN UMD builds that actually ship /dist/ogl.umd.js:
    'https://cdn.jsdelivr.net/npm/ogl@0.0.63/dist/ogl.umd.js',
    'https://unpkg.com/ogl@0.0.63/dist/ogl.umd.js',
    // NOTE: raw.githubusercontent.com is not usable as <script> (nosniff); skip here on purpose
  ];

  for (const url of UMD_CANDIDATES) {
    try {
      console.info('[wm] Loading OGL UMD:', url);
      await loadScript(url);
      og = pickGlobalOGL();
      if (og) {
        console.info('[wm] OGL UMD ready via', url, 'global =', og === window.OGL ? 'window.OGL' : 'window.ogl');
        return og;
      } else {
        console.warn('[wm] Script loaded but no OGL global found after', url, '(trying next)');
      }
    } catch (e) {
      console.warn('[wm] OGL UMD failed:', url, e?.message || e);
    }
  }

  // (3) ESM fallbacks — import as a module and synthesize an OGL-like object
  const ESM_CANDIDATES = [
    'https://esm.sh/ogl@0.0.63',
    'https://cdn.jsdelivr.net/npm/ogl@0.0.63/+esm',
    'https://unpkg.com/ogl@0.0.63?module',
  ];

  let lastErr;
  for (const url of ESM_CANDIDATES) {
    try {
      console.info('[wm] Importing OGL ESM:', url);
      const mod = await import(url);
      // Exports may be default or named; normalize
      const ns = mod?.default && typeof mod.default === 'object' ? mod.default : mod;
      const OGL_API = {
        Renderer: ns.Renderer,
        Geometry: ns.Geometry,
        Program:  ns.Program,
        Mesh:     ns.Mesh,
        // (extra symbols can be added here if you expand usage)
      };
      if (OGL_API.Renderer && OGL_API.Geometry && OGL_API.Program && OGL_API.Mesh) {
        console.info('[wm] OGL ESM ready via', url);
        return OGL_API;
      }
      console.warn('[wm] ESM missing expected exports at', url, 'keys=', Object.keys(ns||{}));
    } catch (e) {
      lastErr = e;
      console.warn('[wm] OGL ESM import failed:', url, e?.message || e);
    }
  }

  throw lastErr || new Error('[wm] Could not acquire OGL via UMD or ESM.');
}

/* -------------------------------------------
   Tiny color helper (sRGB -> linear)
------------------------------------------- */
function cssHexToLinearRGB(hex) {
  const c = hex.replace('#','');
  const r = parseInt(c.slice(0,2),16)/255;
  const g = parseInt(c.slice(2,4),16)/255;
  const b = parseInt(c.slice(4,6),16)/255;
  const toLin = v => Math.pow(v, 2.2);
  return [toLin(r), toLin(g), toLin(b)];
}

/* -------------------------------------------
   Public API
------------------------------------------- */
export default async function initRipple(opts = {}) {
  const {
    canvasSelector = '#wm-canvas',
    dataUrl = '',
    targetDotPx = 4,
    cornerPct = 0.12,
    seedFraction = 0.20,
    cycleSec = 10,
    rngJitter = 0.5,
    maxSeeds = 64,
    powerPreference = 'high-performance'
  } = opts;

  // Canvas
  const canvas = document.querySelector(canvasSelector);
  if (!canvas) { console.error('[wm] FATAL: Canvas not found:', canvasSelector); return; }

  // Colors from CSS
  const idleHex   = getComputedStyle(document.documentElement).getPropertyValue('--idle').trim() || '#276C8C';
  const brightHex = getComputedStyle(document.documentElement).getPropertyValue('--bright').trim() || '#5FDEDE';
  const IDLE   = cssHexToLinearRGB(idleHex);
  const BRIGHT = cssHexToLinearRGB(brightHex);

  // OGL (UMD global or ESM module)
  let OGL;
  try {
    OGL = await ensureOGL();
  } catch (e) {
    console.error('[wm] FATAL: OGL failed to load:', e?.message || e);
    return;
  }
  const { Renderer, Geometry, Program, Mesh } = OGL;

  // Renderer / GL
  const renderer = new Renderer({ canvas, antialias:false, alpha:true, powerPreference });
  const gl = renderer.gl;

  // Data
  if (!dataUrl) { console.error('[wm] FATAL: dataUrl missing.'); return; }
  let pts;
  try {
    const res = await fetch(dataUrl, { cache:'no-store' });
    if (!res.ok) throw new Error('HTTP '+res.status);
    pts = await res.json();
  } catch (err) {
    console.error('[wm] FATAL: Data fetch failed:', dataUrl, err?.message || err);
    return;
  }
  if (!Array.isArray(pts) || !pts.length) { console.error('[wm] FATAL: Data empty/invalid'); return; }

  // Bounds (SVG-like viewBox + padding)
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity, maxR=0;
  for (const p of pts) {
    if (p.x<minX) minX=p.x; if (p.y<minY) minY=p.y;
    if (p.x>maxX) maxX=p.x; if (p.y>maxY) maxY=p.y;
    if ((p.r||0)>maxR) maxR=p.r||0;
  }
  const pad = Math.max(maxR, 1);
  const vbX = minX - pad, vbY = minY - pad;
  const vbW = (maxX - minX) + pad * 2;
  const vbH = (maxY - minY) + pad * 2;

  // Dot size mapping (so each rect ~ targetDotPx on screen)
  let dotSizeData = 1;
  function resize(){
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height);
    const pxPerDataX = (rect.width || 1) / vbW;
    dotSizeData = targetDotPx / Math.max(pxPerDataX, 1e-6);
  }
  window.addEventListener('resize', resize, { passive:true });
  resize();

  // Seeds (ripple origins)
  const indices = Array.from(pts.keys());
  for (let i=indices.length-1;i>0;i--){
    const j=(Math.random()*(i+1))|0;
    [indices[i],indices[j]]=[indices[j],indices[i]];
  }
  const seedCount = Math.max(1, Math.min(maxSeeds, Math.round(pts.length * seedFraction)));
  const seedIdxs  = indices.slice(0, seedCount).sort((a,b)=>a-b);
  const seeds     = seedIdxs.map(i=>pts[i]);
  const seedPhase = seeds.map(()=>Math.random()*cycleSec);

  const diag = Math.hypot(vbW, vbH);
  const waveSpeed = diag / (cycleSec * 0.60); // data-units / second

  // Instance attributes
  const N = pts.length;
  const instanceXY    = new Float32Array(N * 2);
  const instanceDelay = new Float32Array(N);
  for (let i=0;i<N;i++){
    const p = pts[i];
    instanceXY[i*2+0] = p.x;
    instanceXY[i*2+1] = p.y;

    let bestDist=Infinity, bestIdx=0;
    for (let s=0;s<seeds.length;s++){
      const S=seeds[s];
      const d=Math.hypot(p.x-S.x, p.y-S.y);
      if (d<bestDist){ bestDist=d; bestIdx=s; }
    }
    const travelSec = bestDist / waveSpeed;
    const jitter    = (Math.random()-0.5) * rngJitter;
    let phaseSec    = seedPhase[bestIdx] + travelSec + jitter;
    phaseSec = -(phaseSec % cycleSec);
    if (phaseSec === 0) phaseSec = -0.0001;
    instanceDelay[i] = phaseSec;
  }

  // Geometry (unit quad instanced)
  const geometry = new Geometry(gl, {
    position: { size:2, data:new Float32Array([
      -0.5,-0.5,  0.5,-0.5,  -0.5,0.5,
      -0.5,0.5,   0.5,-0.5,   0.5,0.5
    ])},
    iCenter: { instanced:1, size:2, data:instanceXY },
    iDelay:  { instanced:1, size:1, data:instanceDelay },
  });

  // Shaders
  const vertex = /* glsl */`
    attribute vec2 position;
    attribute vec2 iCenter;
    attribute float iDelay;
    uniform vec3 uBounds;  // (vbX, vbY, dotSizeData)
    uniform vec2 uScale;   // data->NDC
    uniform vec2 uOffset;  // data->NDC
    varying vec2 vLocal;   // -0.5..0.5
    varying float vDelayV;
    void main(){
      vLocal = position;
      vDelayV = iDelay;
      float s = uBounds.z;
      vec2 posData = iCenter + position * s;
      vec2 posNDC  = posData * uScale + uOffset;
      gl_Position  = vec4(posNDC, 0.0, 1.0);
    }`;

  const fragment = /* glsl */`
    precision highp float;
    varying vec2 vLocal;
    varying float vDelayV;
    uniform float uTime;
    uniform float uCycle;
    uniform float uCorner; // 0..0.5 (of half-size)
    uniform vec3  uIdle;   // linear RGB
    uniform vec3  uBright; // linear RGB

    float roundedRectMask(vec2 uv, float corner){
      vec2 a = abs(uv) - 0.5 + vec2(corner);
      float outside = max(a.x, a.y);
      float m = step(outside, 0.0);
      vec2 q = max(a, 0.0);
      float r = length(q) - corner;
      m *= step(r, 0.0);
      return m;
    }
    float rippleWindow(float tNorm){
      if (tNorm < 0.03) return smoothstep(0.0, 0.03, tNorm);
      else if (tNorm < 0.10) return 1.0;
      float k = (tNorm - 0.10) / 0.90;
      return 1.0 - k;
    }
    void main(){
      float mask = roundedRectMask(vLocal, clamp(uCorner, 0.0, 0.49));
      if (mask <= 0.0) discard;

      float t = uTime + vDelayV;
      float tCycle = mod(t, uCycle);
      float tNorm  = tCycle / uCycle;

      float w = rippleWindow(tNorm);
      vec3 col = mix(uIdle, uBright, w);

      gl_FragColor = vec4(col, 1.0);
    }`;

  const program = new Program(gl, {
    vertex, fragment,
    uniforms: {
      uBounds:  { value:new Float32Array([vbX, vbY, dotSizeData]) },
      uScale:   { value:new Float32Array([0,0]) },
      uOffset:  { value:new Float32Array([0,0]) },
      uTime:    { value:0 },
      uCycle:   { value:cycleSec },
      uCorner:  { value:cornerPct * 0.5 },
      uIdle:    { value:new Float32Array(IDLE) },
      uBright:  { value:new Float32Array(BRIGHT) },
    }
  });

  const mesh = new Mesh(gl, { geometry, program });

  // Data->NDC transform (SVG-like, flip Y)
  function updateTransforms(){
    const sx =  2.0 / vbW;
    const sy = -2.0 / vbH;
    const ox = -1.0 - vbX * sx;
    const oy =  1.0 - vbY * sy;
    program.uniforms.uScale.value.set([sx, sy]);
    program.uniforms.uOffset.value.set([ox, oy]);
    program.uniforms.uBounds.value[2] = dotSizeData;
  }
  updateTransforms();

  // Pause when offscreen
  let running = true;
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(entries=>{
    for (const e of entries) running = e.isIntersecting;
  }) : null;
  if (io) io.observe(canvas);

  // Respect reduced motion
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    running = false;
    program.uniforms.uTime.value = 0.0;
    renderer.render({ scene: mesh });
  }

  // Main loop
  function animate(tMs){
    if (running){
      program.uniforms.uTime.value = tMs * 0.001;
      renderer.render({ scene: mesh });
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Keep transforms updated on resize
  window.addEventListener('resize', () => { resize(); updateTransforms(); }, { passive:true });
}
