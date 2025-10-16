// wm-ripple-gl.js — DEBUG BUILD
// Adds verbose [wm] logs and a tiny on-canvas overlay for heartbeat.

// ---------- OGL loader (UMD via <script> with fallbacks) ----------
async function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = (e) => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function ensureOGL() {
  if (window.OGL) {
    console.info('[wm] OGL already present on window.');
    return window.OGL;
  }

  const CANDIDATES = [
    // Local file in your repo (preferred). When served via jsDelivr, this resolves alongside the module.
    new URL('./ogl.umd.js', import.meta.url).href,

    // Your raw GitHub fallback
    'https://raw.githubusercontent.com/GDS-stack/world-map-data/refs/heads/main/ogl.umd.js',

    // Known CDN mirrors that expose /dist/ogl.umd.js for 0.0.63
    'https://cdn.jsdelivr.net/npm/ogl@0.0.63/dist/ogl.umd.js',
    'https://unpkg.com/ogl@0.0.63/dist/ogl.umd.js',
  ];

  let lastErr;
  for (const url of CANDIDATES) {
    try {
      console.info('[wm] Attempting to load OGL from', url);
      await loadScript(url);
      if (window.OGL) {
        console.info('[wm] OGL loaded from', url);
        return window.OGL;
      }
      console.warn('[wm] Script loaded but window.OGL missing:', url);
    } catch (e) {
      lastErr = e;
      console.warn('[wm] OGL load failed:', url, e?.message || e);
    }
  }
  throw lastErr || new Error('[wm] Could not load OGL from any source.');
}

// ---------- Tiny debug HUD drawn on canvas ----------
function makeDebugHUD(gl) {
  // Draw a single-pixel alpha line each second to prove frames are happening.
  // (We avoid 2D context to keep it simple and cross-API-safe.)
  let lastStamp = 0;
  return function hud(tMs) {
    const t = (tMs / 1000) | 0;
    if (t !== lastStamp) {
      lastStamp = t;
      // Set a CSS outline so you can see the canvas box in the layout
      if (!gl.canvas.style.outline) {
        gl.canvas.style.outline = '1px dashed rgba(255,255,255,0.35)';
        gl.canvas.style.outlineOffset = '-1px';
      }
      console.info('[wm] frame heartbeat', t, 's');
    }
  };
}

// ---------- Main ----------
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
  if (!canvas) {
    console.error('[wm] FATAL: Canvas not found for selector:', canvasSelector);
    return;
  }
  console.info('[wm] Using canvas selector:', canvasSelector);

  // Colors from CSS
  const idleHex   = getComputedStyle(document.documentElement).getPropertyValue('--idle').trim() || '#276C8C';
  const brightHex = getComputedStyle(document.documentElement).getPropertyValue('--bright').trim() || '#5FDEDE';
  console.info('[wm] CSS colors idle/bright:', idleHex, brightHex);

  const cssHexToLinearRGB = (hex) => {
    const c = hex.replace('#','');
    const r = parseInt(c.slice(0,2),16)/255;
    const g = parseInt(c.slice(2,4),16)/255;
    const b = parseInt(c.slice(4,6),16)/255;
    const toLin = v => Math.pow(v, 2.2);
    return [toLin(r), toLin(g), toLin(b)];
  };
  const IDLE   = cssHexToLinearRGB(idleHex);
  const BRIGHT = cssHexToLinearRGB(brightHex);

  // Ensure OGL
  const OGL = await ensureOGL().catch(e => {
    console.error('[wm] FATAL: OGL failed to load:', e?.message || e);
  });
  if (!OGL) return;
  const { Renderer, Geometry, Program, Mesh } = OGL;

  // Renderer
  const renderer = new Renderer({ canvas, antialias:false, alpha:true, powerPreference });
  const gl = renderer.gl;
  console.info('[wm] WebGL version:', gl.getParameter(gl.VERSION));

  // Data
  if (!dataUrl) {
    console.error('[wm] FATAL: dataUrl missing.');
    return;
  }
  let pts;
  try {
    const res = await fetch(dataUrl, { cache:'no-store' });
    console.info('[wm] Data fetch status:', res.status, res.statusText, 'type:', res.headers.get('content-type'));
    if (!res.ok) throw new Error('HTTP '+res.status);
    pts = await res.json();
  } catch (err) {
    console.error('[wm] FATAL: Data fetch failed:', dataUrl, err?.message || err);
    return;
  }
  if (!Array.isArray(pts) || !pts.length) {
    console.error('[wm] FATAL: Data is empty or invalid array. url=', dataUrl);
    return;
  }
  console.info('[wm] Points:', pts.length);

  // Bounds
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity, maxR=0;
  for (const p of pts) {
    if (p.x<minX) minX=p.x; if (p.y<minY) minY=p.y;
    if (p.x>maxX) maxX=p.x; if (p.y>maxY) maxY=p.y;
    if ((p.r||0)>maxR) maxR=p.r||0;
  }
  const pad=Math.max(maxR,1);
  const vbX=minX-pad, vbY=minY-pad;
  const vbW=(maxX-minX)+pad*2, vbH=(maxY-minY)+pad*2;
  console.info('[wm] Bounds (vb):', { vbX, vbY, vbW, vbH });

  // Size mapping
  let dotSizeData=1;
  function resize(){
    const rect=canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height);
    const pxPerDataX=(rect.width||1)/vbW;
    dotSizeData = targetDotPx/Math.max(pxPerDataX,1e-6);
    console.info('[wm] resize → canvas CSS:', rect.width+'×'+rect.height, ' dotSizeData:', dotSizeData.toFixed(4));
  }
  window.addEventListener('resize', resize, { passive:true });
  resize();

  // Seeds
  const indices=Array.from(pts.keys());
  for (let i=indices.length-1;i>0;i--){
    const j=(Math.random()*(i+1))|0;
    [indices[i],indices[j]]=[indices[j],indices[i]];
  }
  const seedCount=Math.max(1, Math.min(maxSeeds, Math.round(pts.length*seedFraction)));
  const seedIdxs=indices.slice(0,seedCount).sort((a,b)=>a-b);
  const seeds=seedIdxs.map(i=>pts[i]);
  const seedPhase=seeds.map(()=>Math.random()*cycleSec);
  console.info('[wm] Seeds:', seedCount);

  // Wave speed
  const diag=Math.hypot(vbW,vbH);
  const waveSpeed=diag/(cycleSec*0.60);
  console.info('[wm] waveSpeed (data units/sec):', waveSpeed.toFixed(3));

  // Instance buffers
  const N=pts.length;
  const instanceXY=new Float32Array(N*2);
  const instanceDelay=new Float32Array(N);
  for (let i=0;i<N;i++){
    const p=pts[i];
    instanceXY[i*2+0]=p.x;
    instanceXY[i*2+1]=p.y;

    let bestDist=Infinity, bestIdx=0;
    for (let s=0;s<seeds.length;s++){
      const S=seeds[s];
      const d=Math.hypot(p.x-S.x,p.y-S.y);
      if (d<bestDist){bestDist=d; bestIdx=s;}
    }
    const travelSec=bestDist/waveSpeed;
    const jitter=(Math.random()-0.5)*rngJitter;
    let phaseSec=seedPhase[bestIdx]+travelSec+jitter;
    phaseSec=-(phaseSec%cycleSec);
    if (phaseSec===0) phaseSec=-0.0001;
    instanceDelay[i]=phaseSec;
  }
  console.info('[wm] Instance buffers prepared.');

  // Geometry
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
    uniform vec3 uBounds;
    uniform vec2 uScale;
    uniform vec2 uOffset;
    varying vec2 vLocal;
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
    uniform float uCorner;
    uniform vec3  uIdle;
    uniform vec3  uBright;

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

  function updateTransforms(){
    const sx =  2.0 / vbW;
    const sy = -2.0 / vbH;
    const ox = -1.0 - vbX * sx;
    const oy =  1.0 - vbY * sy;
    program.uniforms.uScale.value.set([sx, sy]);
    program.uniforms.uOffset.value.set([ox, oy]);
    program.uniforms.uBounds.value[2] = dotSizeData;
    console.info('[wm] updateTransforms', { sx, sy, ox, oy, dotSizeData });
  }
  updateTransforms();

  // Visibility + reduced motion
  let running = true;
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(es=>{
    for (const e of es) running = e.isIntersecting;
    console.info('[wm] IntersectionObserver → running:', running);
  }) : null;
  if (io) io.observe(canvas);

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    running = false;
    program.uniforms.uTime.value = 0.0;
    renderer.render({ scene: mesh });
    console.warn('[wm] Reduced motion active → rendering paused.');
  }

  const hud = makeDebugHUD(gl);

  function animate(tMs){
    hud(tMs);
    if (running){
      program.uniforms.uTime.value = tMs * 0.001;
      renderer.render({ scene: mesh });
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Context loss monitor
  canvas.addEventListener('webglcontextlost', (evt)=> {
    console.error('[wm] WebGL context LOST:', evt?.statusMessage || '(no status)');
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    console.info('[wm] WebGL context RESTORED.');
  }, false);

  // Post-init report
  setTimeout(() => {
    const rect = canvas.getBoundingClientRect();
    console.info('[wm] Post-init canvas CSS size:', Math.round(rect.width)+'×'+Math.round(rect.height),
      ' DPR:', window.devicePixelRatio);
  }, 600);
}
