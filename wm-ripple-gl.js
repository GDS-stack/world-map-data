// wm-ripple-gl.js
import { Renderer, Geometry, Program, Mesh } from 'https://cdn.skypack.dev/ogl@0.0.104';

export default async function initRipple(opts = {}) {
  const {
    canvasSelector = '#wm-canvas',
    dataUrl = '',
    targetDotPx = 4,
    cornerPct = 0.12,
    seedFraction = 0.20,
    cycleSec = 10,
    rngJitter = 0.5,
    maxSeeds = 64
  } = opts;

  const canvas = document.querySelector(canvasSelector);
  if (!canvas) return console.error('[wm-ripple-gl] Canvas not found:', canvasSelector);

  // Read CSS variables for colors
  const idleHex   = getComputedStyle(document.documentElement).getPropertyValue('--idle').trim() || '#276C8C';
  const brightHex = getComputedStyle(document.documentElement).getPropertyValue('--bright').trim() || '#5FDEDE';
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

  // Renderer
  const renderer = new Renderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
  const gl = renderer.gl;

  // Data
  if (!dataUrl) return console.error('[wm-ripple-gl] Missing dataUrl.');
  const res = await fetch(dataUrl, { cache: 'no-store' });
  if (!res.ok) { console.error('[wm-ripple-gl] Data fetch failed:', dataUrl); return; }
  const pts = await res.json();
  if (!Array.isArray(pts) || !pts.length) return;

  // Bounds
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

  // Responsive sizing
  let dotSizeData = 1;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height);
    const pxPerDataX = rect.width / vbW || 1e-6;
    dotSizeData = targetDotPx / pxPerDataX;
  }
  window.addEventListener('resize', resize);
  resize();

  // Seeds
  const indices = Array.from(pts.keys());
  for (let i = indices.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const seedCount = Math.max(1, Math.min(maxSeeds, Math.round(pts.length * seedFraction)));
  const seedIdxs  = indices.slice(0, seedCount).sort((a,b)=>a-b);
  const seeds = seedIdxs.map(i => pts[i]);
  const seedPhase = seeds.map(() => Math.random() * cycleSec);

  // Wave speed
  const diag = Math.hypot(vbW, vbH);
  const waveSpeed = diag / (cycleSec * 0.60);

  // Per-instance attributes
  const N = pts.length;
  const instanceXY = new Float32Array(N * 2);
  const instanceDelay = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = pts[i];
    instanceXY[i*2 + 0] = p.x;
    instanceXY[i*2 + 1] = p.y;

    // nearest seed distance
    let bestDist = Infinity, bestIdx = 0;
    for (let s = 0; s < seeds.length; s++) {
      const S = seeds[s];
      const d = Math.hypot(p.x - S.x, p.y - S.y);
      if (d < bestDist) { bestDist = d; bestIdx = s; }
    }
    const travelSec = bestDist / waveSpeed;
    const jitter = (Math.random() - 0.5) * rngJitter;
    let phaseSec = seedPhase[bestIdx] + travelSec + jitter;
    phaseSec = -(phaseSec % cycleSec);
    if (phaseSec === 0) phaseSec = -0.0001;
    instanceDelay[i] = phaseSec;
  }

  // Quad geometry (unit square), instanced attributes
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

  // Shaders
  const vertex = /* glsl */`
    attribute vec2 position;
    attribute vec2 iCenter;
    attribute float iDelay;
    uniform vec3 uBounds;  // (vbX, vbY, dotSizeData)
    uniform vec2 uScale;   // data->NDC
    uniform vec2 uOffset;  // data->NDC
    varying vec2 vLocal;
    varying vec2 vCenter;
    varying float vDelay;
    void main() {
      vLocal = position;
      vCenter = iCenter;
      vDelay = iDelay;
      float s = uBounds.z;
      vec2 posData = iCenter + position * s;
      vec2 posNDC = posData * uScale + uOffset;
      gl_Position = vec4(posNDC, 0.0, 1.0);
    }`;

  const fragment = /* glsl */`
    precision highp float;
    varying vec2 vLocal;
    varying vec2 vCenter;
    varying float vDelay;
    uniform vec2 uViewSize;
    uniform float uTime;
    uniform float uCycle;
    uniform float uCorner;
    uniform vec3 uIdle;
    uniform vec3 uBright;

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
      if (tNorm < 0.03) {
        return smoothstep(0.0, 0.03, tNorm);
      } else if (tNorm < 0.10) {
        return 1.0;
      } else {
        float k = (tNorm - 0.10) / 0.90;
        return 1.0 - k;
      }
    }
    void main(){
      float corner = clamp(uCorner, 0.0, 0.49);
      float mask = roundedRectMask(vLocal, corner);
      if (mask <= 0.0) discard;

      float t = uTime + vDelay;
      float tCycle = mod(t, uCycle);
      float tNorm = tCycle / uCycle;

      float w = rippleWindow(tNorm);
      vec3 lin = mix(uIdle, uBright, w);
      gl_FragColor = vec4(lin, 1.0);
    }`;

  const program = new Program(gl, {
    vertex, fragment,
    uniforms: {
      uBounds:   { value: new Float32Array([vbX, vbY, dotSizeData]) },
      uScale:    { value: new Float32Array([0,0]) },
      uOffset:   { value: new Float32Array([0,0]) },
      uViewSize: { value: new Float32Array([vbW, vbH]) },
      uTime:     { value: 0 },
      uCycle:    { value: cycleSec },
      uCorner:   { value: cornerPct * 0.5 },
      uIdle:     { value: new Float32Array(IDLE) },
      uBright:   { value: new Float32Array(BRIGHT) },
    }
  });

  const mesh = new Mesh(gl, { geometry, program });

  function updateTransforms(){
    const sx =  2.0 / vbW;
    const sy = -2.0 / vbH; // flip Y to feel like SVG
    const ox = -1.0 - vbX * sx;
    const oy =  1.0 - vbY * sy;
    program.uniforms.uScale.value.set([sx, sy]);
    program.uniforms.uOffset.value.set([ox, oy]);
    program.uniforms.uBounds.value[2] = dotSizeData;
  }
  updateTransforms();

  // Visibility pause (saves battery/CPU when offscreen)
  let running = true;
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(entries=>{
    for (const e of entries) running = e.isIntersecting;
  }) : null;
  if (io) io.observe(canvas);

  function animate(tMs){
    if (running) {
      program.uniforms.uTime.value = tMs * 0.001;
      renderer.render({ scene: mesh });
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  window.addEventListener('resize', ()=>{ resize(); updateTransforms(); });

  // Reduced motion (optional): freeze at low-intensity frame
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    running = false;
    program.uniforms.uTime.value = 0.0;
    renderer.render({ scene: mesh });
  }
}

