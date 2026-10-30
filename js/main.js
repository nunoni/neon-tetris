/* ------------------------------------------------------------------ *
 * main.js — WebGL neon Tetris renderer & game shell.
 * Requires: three.min.js, EffectComposer, RenderPass, ShaderPass,
 * UnrealBloomPass, FXAAShader (all local), audio.js, game.js.
 * ------------------------------------------------------------------ */
'use strict';

/* ============================ constants ============================ */

const COLORS = {
  I: 0x38cfe8, J: 0x5578e0, L: 0xf5924a, O: 0xf2c14e,
  S: 0x5cd9a0, T: 0xb07ce6, Z: 0xe8556f,
};
const COLORS_CSS = {
  I: '#38cfe8', J: '#5578e0', L: '#f5924a', O: '#f2c14e',
  S: '#5cd9a0', T: '#b07ce6', Z: '#e8556f',
};

const CELL_GAP = 0.06;
const BOARD_W = COLS;                       // 10
const BOARD_H = VISIBLE_ROWS;               // 20
const CLEAR_ANIM_BASE = 0.55;

function gridToWorld(r, c) {
  return { x: c - (COLS - 1) / 2, y: (BOARD_H - 1) / 2 + HIDDEN_ROWS - r, z: 0 };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* ====================== renderer / scene / camera =================== */

const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x0a0409, 1);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 400);
let camDist = 26;
const camParallax = { x: 0, y: 0, tx: 0, ty: 0 };

const sharedTime = { value: 0 };

/* --------------------------- post chain ---------------------------- */

const composer = new THREE.EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
composer.setSize(window.innerWidth, window.innerHeight);

const renderPass = new THREE.RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new THREE.UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), 0.78, 0.55, 0.42,
);
composer.addPass(bloomPass);

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uRgbShift: { value: 0.0016 },
    uVignette: { value: 0.55 },
    uScan: { value: 0.05 },
    uHue: { value: 0 },
    uDanger: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uFlash, uRgbShift, uVignette, uScan, uHue, uDanger;
    uniform vec3 uFlashColor;
    varying vec2 vUv;
    float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 hueShift(vec3 color, float h){
      const vec3 k = vec3(0.57735);
      float ca = cos(h);
      return color * ca + cross(k, color) * sin(h) + k * dot(k, color) * (1.0 - ca);
    }
    void main(){
      vec2 dir = vUv - 0.5;
      float dist = length(dir);
      vec2 off = dir * uRgbShift * (0.6 + dist * 2.5);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col = hueShift(col, uHue);
      float sl = sin(vUv.y * 1400.0) * 0.5 + 0.5;
      col *= 1.0 - uScan * sl;
      col += (rand(vUv * 913.0 + fract(uTime) * 17.0) - 0.5) * 0.035;
      col *= 1.0 - smoothstep(0.42, 0.95, dist) * uVignette;
      col += uFlashColor * uFlash;
      col = mix(col, vec3(1.0, 0.12, 0.18), uDanger * 0.10 * (0.5 + 0.5 * sin(uTime * 6.0)));
      col += vec3(0.55, 0.02, 0.05) * smoothstep(0.3, 0.95, dist) * uDanger * (0.5 + 0.35 * sin(uTime * 7.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
const finalPass = new THREE.ShaderPass(FinalShader);
composer.addPass(finalPass);

const fxaaPass = new THREE.ShaderPass(THREE.FXAAShader);
composer.addPass(fxaaPass);
updateFxaaResolution();

function updateFxaaResolution() {
  const pr = renderer.getPixelRatio();
  fxaaPass.material.uniforms.resolution.value.set(1 / (window.innerWidth * pr), 1 / (window.innerHeight * pr));
}

/* =========================== block shader =========================== */

const BLOCK_VERT = `
  varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  void main(){
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const BLOCK_FRAG = `
  uniform vec3 uColor;
  uniform float uTime, uPulse, uBoost, uDim, uAlpha, uGlow;
  varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  void main(){
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vW);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 2.2);
    vec2 f = abs(vUv - 0.5) * 2.0;
    float m = max(f.x, f.y);
    float edge = smoothstep(0.66, 0.86, m);
    float inner = 1.0 - smoothstep(0.0, 0.6, m);
    float diff = max(dot(N, normalize(vec3(0.45, 0.85, 0.55))), 0.0);
    float diff2 = max(dot(N, normalize(vec3(-0.5, -0.35, 0.4))), 0.0);
    vec3 col = uColor * (0.12 + 0.42 * diff + 0.14 * diff2);
    col += uColor * edge * 0.95 * uGlow;
    col += uColor * inner * 0.22;
    col += uColor * fres * 0.75 * uGlow;
    float pulse = uPulse * (0.65 + 0.35 * sin(uTime * 7.0));
    col *= (1.0 + pulse * 0.3 + uBoost * 0.8);
    col = mix(col, col * 0.22, uDim);
    float cd = length(vUv - 0.5);
    col += uColor * smoothstep(0.16, 0.0, cd) * 0.3 * uGlow;
    gl_FragColor = vec4(col, uAlpha);
  }
`;

const blockGeo = new THREE.BoxGeometry(1 - CELL_GAP, 1 - CELL_GAP, 1 - CELL_GAP);

function makeBlockMaterial(type, variant) {
  /* normalize luminance so every color blooms about the same amount */
  const base = new THREE.Color(COLORS[type]);
  const luma = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
  base.multiplyScalar(clamp(0.62 / luma, 0.7, 1.25));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: base },
      uTime: sharedTime,
      uPulse: { value: 0 },
      uBoost: { value: 0 },
      uDim: { value: variant === 'dim' ? 1 : 0 },
      uAlpha: { value: 1 },
      uGlow: { value: variant === 'locked' ? 0.55 : 1 },
    },
    vertexShader: BLOCK_VERT,
    fragmentShader: BLOCK_FRAG,
    transparent: variant === 'ghost',
    depthWrite: variant !== 'ghost',
  });
  if (variant === 'ghost') {
    mat.uniforms.uAlpha.value = 0.13;
    mat.uniforms.uDim.value = 0.45;
  }
  return mat;
}

const lockedMats = {}; const activeMats = {}; const ghostFillMats = {}; const dimMats = {};
for (const t of PIECE_TYPES) {
  lockedMats[t] = makeBlockMaterial(t, 'locked');
  activeMats[t] = makeBlockMaterial(t, 'active');
  ghostFillMats[t] = makeBlockMaterial(t, 'ghost');
  dimMats[t] = makeBlockMaterial(t, 'dim');
}

/* ======================= scene environment ========================== */

const boardGroup = new THREE.Group();
scene.add(boardGroup);

/* --- neon frame tubes --- */
const frameMat = new THREE.MeshBasicMaterial({ color: 0xff8fc4 });
const frameBaseColor = new THREE.Color(0xff8fc4);
function tube(w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
  m.position.set(x, y, z);
  boardGroup.add(m);
  return m;
}
const FH = BOARD_H + 0.9;
for (const zz of [0.62, -0.62]) {
  tube(0.1, FH, 0.1, -BOARD_W / 2 - 0.25, 0, zz);
  tube(0.1, FH, 0.1, BOARD_W / 2 + 0.25, 0, zz);
  tube(BOARD_W + 0.6, 0.1, 0.1, 0, BOARD_H / 2 + 0.2, zz);
  tube(BOARD_W + 0.6, 0.1, 0.1, 0, -BOARD_H / 2 - 0.2, zz);
}
for (const [x, y] of [[-BOARD_W / 2 - 0.25, BOARD_H / 2 + 0.2], [BOARD_W / 2 + 0.25, BOARD_H / 2 + 0.2],
[-BOARD_W / 2 - 0.25, -BOARD_H / 2 - 0.2], [BOARD_W / 2 + 0.25, -BOARD_H / 2 - 0.2]]) {
  for (const zz of [0.62, -0.62]) tube(0.22, 0.22, 0.22, x, y, zz);
}

/* --- back plane grid --- */
const backMat = new THREE.ShaderMaterial({
  uniforms: { uTime: sharedTime, uColor: { value: new THREE.Color(0xc4708f) } },
  vertexShader: `varying vec2 vUv; varying vec3 vW;
    void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: `
    uniform float uTime; uniform vec3 uColor;
    varying vec2 vUv; varying vec3 vW;
    void main(){
      vec2 g = vUv * vec2(${BOARD_W + 0.5}, ${BOARD_H + 0.5});
      vec2 gr = abs(fract(g) - 0.5);
      float line = 1.0 - smoothstep(0.0, 0.06, min(gr.x, gr.y));
      float band = exp(-pow(g.y - mod(uTime * 2.2, ${BOARD_H + 6.0}) + 3.0, 2.0) / 1.8);
      float fade = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x)
                 * smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.95, vUv.y);
      float a = line * (0.12 + band * 0.55) * fade;
      gl_FragColor = vec4(uColor * a, a);
    }`,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const backPlane = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W + 0.5, BOARD_H + 0.5), backMat);
backPlane.position.z = -0.68;
boardGroup.add(backPlane);

/* --- floor grid --- */
const floorMat = new THREE.ShaderMaterial({
  uniforms: { uTime: sharedTime, uColor: { value: new THREE.Color(0xe08fc0) }, uBeat: { value: 0 } },
  extensions: { derivatives: true },
  vertexShader: `varying vec3 vW;
    void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: `
    uniform float uTime, uBeat; uniform vec3 uColor;
    varying vec3 vW;
    void main(){
      vec2 g = vW.xz * 0.9;
      vec2 aa = fwidth(g);
      vec2 gr = abs(fract(g) - 0.5) / max(aa, vec2(0.0001));
      float line = 1.0 - min(min(gr.x, gr.y), 1.0);
      float d = length(vW.xz);
      float ring = 0.5 + 0.5 * sin(d * 0.55 - uTime * 2.4);
      float fade = smoothstep(42.0, 4.0, d);
      float a = line * fade * (0.09 + uBeat * 0.4 * ring);
      gl_FragColor = vec4(uColor * a, a);
    }`,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 70), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -BOARD_H / 2 - 1.1;
floor.position.z = -8;
scene.add(floor);

/* --- starfield --- */
{
  const N = 900;
  const pos = new Float32Array(N * 3);
  const phase = new Float32Array(N);
  const size = new Float32Array(N);
  const hue = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 150;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 90;
    pos[i * 3 + 2] = -95 + Math.random() * 85;
    phase[i] = Math.random() * Math.PI * 2;
    size[i] = 1.2 + Math.random() * 2.6;
    hue[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aHue', new THREE.BufferAttribute(hue, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: sharedTime },
    vertexShader: `
      attribute float aPhase, aSize, aHue;
      uniform float uTime;
      varying float vA; varying vec3 vC;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float tw = 0.55 + 0.45 * sin(uTime * (0.5 + aHue) + aPhase * 19.0);
        gl_PointSize = aSize * tw * (240.0 / max(1.0, -mv.z));
        vA = tw;
        vC = aHue < 0.15 ? vec3(1.0, 0.93, 0.97)
           : (aHue < 0.55 ? vec3(1.0, 0.72, 0.86) : vec3(0.92, 0.6, 0.95));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA; varying vec3 vC;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.06, d) * vA;
        gl_FragColor = vec4(vC * a, a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const stars = new THREE.Points(geo, mat);
  stars.frustumCulled = false;
  scene.add(stars);
  window.__stars = stars;
}

/* --- nebula backdrop --- */
const nebulaMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: sharedTime,
    uColA: { value: new THREE.Color(0x120510) },
    uColB: { value: new THREE.Color(0x3a1425) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform float uTime; uniform vec3 uColA, uColB;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                 mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    float fbm(vec2 p){
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
    void main(){
      vec2 p = vUv * 3.2 + vec2(uTime * 0.016, uTime * 0.009);
      float n = fbm(p) * fbm(p * 1.6 - uTime * 0.012);
      vec3 col = mix(uColA, uColB, n);
      col += uColB * 0.4 * smoothstep(0.52, 1.0, n);
      float vig = smoothstep(1.35, 0.25, length(vUv - 0.5));
      col *= 0.6 * (0.3 + 0.7 * vig);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const nebula = new THREE.Mesh(new THREE.PlaneGeometry(420, 240), nebulaMat);
nebula.position.z = -130;
scene.add(nebula);

/* --- giant wireframe icosahedron --- */
const icoMat = new THREE.LineBasicMaterial({
  color: 0x5e2840, transparent: true, opacity: 0.65,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const ico = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(26, 1)), icoMat,
);
ico.position.set(0, 4, -48);
scene.add(ico);
const ico2 = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.OctahedronGeometry(13, 1)), icoMat,
);
ico2.position.set(0, 4, -30);
scene.add(ico2);

/* ========================= particles system ========================= */

const MAXP = 4000;
const P = {
  n: 0,
  px: new Float32Array(MAXP), py: new Float32Array(MAXP), pz: new Float32Array(MAXP),
  vx: new Float32Array(MAXP), vy: new Float32Array(MAXP), vz: new Float32Array(MAXP),
  life: new Float32Array(MAXP), inv: new Float32Array(MAXP),
  size: new Float32Array(MAXP), grav: new Float32Array(MAXP), drag: new Float32Array(MAXP),
  r: new Float32Array(MAXP), g: new Float32Array(MAXP), b: new Float32Array(MAXP),
};
const partGeo = new THREE.BufferGeometry();
const partPos = new Float32Array(MAXP * 3);
const partCol = new Float32Array(MAXP * 3);
const partSize = new Float32Array(MAXP);
const partLife = new Float32Array(MAXP);
partGeo.setAttribute('position', new THREE.BufferAttribute(partPos, 3));
partGeo.setAttribute('aColor', new THREE.BufferAttribute(partCol, 3));
partGeo.setAttribute('aSize', new THREE.BufferAttribute(partSize, 1));
partGeo.setAttribute('aLife', new THREE.BufferAttribute(partLife, 1));
const partMat = new THREE.ShaderMaterial({
  uniforms: {},
  vertexShader: `
    attribute vec3 aColor; attribute float aSize, aLife;
    varying vec3 vC; varying float vL;
    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (0.4 + 0.6 * aLife) * (300.0 / max(1.0, -mv.z));
      vC = aColor; vL = aLife;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying vec3 vC; varying float vL;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.05, d) * clamp(vL, 0.0, 1.0);
      gl_FragColor = vec4(vC * (0.7 + vL) * a, a);
    }`,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const partPoints = new THREE.Points(partGeo, partMat);
partPoints.frustumCulled = false;
scene.add(partPoints);

const _tmpColor = new THREE.Color();
function spawnParticle(x, y, z, vx, vy, vz, color, size, life, grav, drag) {
  if (P.n >= MAXP) return;
  const i = P.n++;
  P.px[i] = x; P.py[i] = y; P.pz[i] = z;
  P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
  P.life[i] = life; P.inv[i] = 1 / life;
  P.size[i] = size; P.grav[i] = grav; P.drag[i] = drag;
  _tmpColor.set(color);
  P.r[i] = _tmpColor.r; P.g[i] = _tmpColor.g; P.b[i] = _tmpColor.b;
}

function burst(x, y, z, color, count, opts = {}) {
  const speed = opts.speed || 4;
  const up = opts.up || 0;
  const life = opts.life || 0.7;
  const size = opts.size || 10;
  const grav = opts.gravity === undefined ? 9 : opts.gravity;
  const drag = opts.drag === undefined ? 1.2 : opts.drag;
  const zSpread = opts.zSpread === undefined ? 2.5 : opts.zSpread;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.35 + Math.random() * 0.75);
    spawnParticle(
      x + (Math.random() - 0.5) * 0.5, y + (Math.random() - 0.5) * 0.5, z + (Math.random() - 0.5) * 0.4,
      Math.cos(a) * s, up + Math.sin(a) * s * 0.7 + Math.random() * speed * 0.4,
      (Math.random() - 0.5) * zSpread,
      color, size * (0.6 + Math.random() * 0.8),
      life * (0.6 + Math.random() * 0.7), grav, drag,
    );
  }
}

function updateParticles(dt) {
  let n = P.n;
  for (let i = 0; i < n; i++) {
    P.life[i] -= dt;
    if (P.life[i] <= 0) {
      const j = --n;
      P.px[i] = P.px[j]; P.py[i] = P.py[j]; P.pz[i] = P.pz[j];
      P.vx[i] = P.vx[j]; P.vy[i] = P.vy[j]; P.vz[i] = P.vz[j];
      P.life[i] = P.life[j]; P.inv[i] = P.inv[j];
      P.size[i] = P.size[j]; P.grav[i] = P.grav[j]; P.drag[i] = P.drag[j];
      P.r[i] = P.r[j]; P.g[i] = P.g[j]; P.b[i] = P.b[j];
      i--;
      continue;
    }
    const drag = Math.exp(-P.drag[i] * dt);
    P.vx[i] *= drag; P.vz[i] *= drag; P.vy[i] = P.vy[i] * drag - P.grav[i] * dt;
    P.px[i] += P.vx[i] * dt; P.py[i] += P.vy[i] * dt; P.pz[i] += P.vz[i] * dt;
  }
  P.n = n;
  for (let i = 0; i < n; i++) {
    partPos[i * 3] = P.px[i]; partPos[i * 3 + 1] = P.py[i]; partPos[i * 3 + 2] = P.pz[i];
    partCol[i * 3] = P.r[i]; partCol[i * 3 + 1] = P.g[i]; partCol[i * 3 + 2] = P.b[i];
    partSize[i] = P.size[i];
    partLife[i] = clamp(P.life[i] * P.inv[i], 0, 1);
  }
  partGeo.setDrawRange(0, n);
  partGeo.attributes.position.needsUpdate = true;
  partGeo.attributes.aColor.needsUpdate = true;
  partGeo.attributes.aSize.needsUpdate = true;
  partGeo.attributes.aLife.needsUpdate = true;
}

/* =========================== block meshes =========================== */

const blockPool = [];
const liveBlocks = new Set();     // locked + active cubes
const lockedMap = new Map();      // "r,c" -> mesh
const debrisList = [];

function acquireBlock() {
  let m = blockPool.pop();
  if (!m) {
    m = new THREE.Mesh(blockGeo, lockedMats.I);
    scene.add(m);
  }
  m.visible = true;
  m.scale.set(1, 1, 1);
  m.rotation.set(0, 0, 0);
  m.renderOrder = 0;
  return m;
}

function releaseBlock(m) {
  m.visible = false;
  m.material = null;
  liveBlocks.delete(m);
  blockPool.push(m);
}

/* active piece cubes */
const activeCubes = [];
for (let i = 0; i < 4; i++) {
  const m = acquireBlock();
  m.visible = false;
  activeCubes.push(m);
}

let lean = 0; let leanTarget = 0;

function refreshActivePiece(popIn = false) {
  if (!game.active) {
    for (const m of activeCubes) m.visible = false;
    return;
  }
  const type = game.active.type;
  const cells = game.cells(game.active);
  for (let i = 0; i < 4; i++) {
    const m = activeCubes[i];
    const cell = cells[i];
    if (!cell) { m.visible = false; continue; }
    const w = gridToWorld(cell[0], cell[1]);
    if (!m.visible) {
      m.userData.pop = 0.16;
      m.position.set(w.x, w.y, 0);
    }
    m.visible = true;
    m.material = activeMats[type];
    m.userData.tx = w.x; m.userData.ty = w.y;
    if (m.userData.snap) { m.position.x = w.x; m.position.y = w.y; }
    liveBlocks.add(m);
  }
}

function updateActiveCubes(dt) {
  const type = game.active ? game.active.type : null;
  if (type) {
    activeMats[type].uniforms.uPulse.value = 1;
    activeMats[type].uniforms.uBoost.value = 0.05;
  }
  lean = lerp(lean, leanTarget, 1 - Math.exp(-dt * 8));
  leanTarget = lerp(leanTarget, 0, 1 - Math.exp(-dt * 4));
  const k = 1 - Math.exp(-dt * 26);
  for (const m of activeCubes) {
    if (!m.visible || m.userData.tx === undefined) continue;
    m.position.x = lerp(m.position.x, m.userData.tx, k);
    m.position.y = lerp(m.position.y, m.userData.ty, k);
    m.position.z = lerp(m.position.z, 0, k);
    m.rotation.z = lean * 0.14;
    if (m.userData.pop > 0) {
      m.userData.pop -= dt;
      const t = clamp(m.userData.pop / 0.16, 0, 1);
      const s = 1 + Math.sin(t * Math.PI) * 0.22;
      m.scale.set(s, s, s);
    } else m.scale.set(1, 1, 1);
    m.userData.snap = false;
  }
}

/* ghost piece */
const ghostEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.98, 0.98, 0.98));
const ghostEdgeMats = {};
const ghostFills = [];
for (const t of PIECE_TYPES) {
  ghostEdgeMats[t] = new THREE.LineBasicMaterial({
    color: COLORS[t], transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}
for (let i = 0; i < 4; i++) {
  const line = new THREE.LineSegments(ghostEdges, ghostEdgeMats.I);
  line.visible = false; line.renderOrder = 1;
  scene.add(line);
  const fill = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), ghostFillMats.I);
  fill.visible = false;
  scene.add(fill);
  ghostFills.push({ line, fill });
}

function updateGhost() {
  if (!game.active || game.state === 'over') {
    for (const g of ghostFills) { g.line.visible = false; g.fill.visible = false; }
    return;
  }
  const cells = game.ghostCells();
  for (let i = 0; i < 4; i++) {
    const g = ghostFills[i];
    const cell = cells[i];
    if (!cell) { g.line.visible = false; g.fill.visible = false; continue; }
    const w = gridToWorld(cell[0], cell[1]);
    g.line.visible = true; g.fill.visible = true;
    g.line.material = ghostEdgeMats[game.active.type];
    g.fill.material = ghostFillMats[game.active.type];
    g.line.position.set(w.x, w.y, 0);
    g.fill.position.set(w.x, w.y, 0);
  }
  const pulse = 0.4 + 0.25 * Math.sin(sharedTime.value * 5);
  ghostEdgeMats[game.active.type].opacity = pulse;
}

function updateLockedBlocks(dt) {
  const k = 1 - Math.exp(-dt * 17);
  for (const m of liveBlocks) {
    if (activeCubes.includes(m)) continue;
    const u = m.userData;
    if (u.tx === undefined) continue;
    m.position.x = lerp(m.position.x, u.tx, k);
    m.position.y = lerp(m.position.y, u.ty, k);
    if (u.pop > 0) {
      u.pop -= dt;
      const t = clamp(u.pop / 0.18, 0, 1);
      const s = 1 + Math.sin(t * Math.PI) * 0.25;
      m.scale.set(s, s, s);
    } else if (u.squash > 0) {
      u.squash -= dt;
      const t = clamp(u.squash / 0.16, 0, 1);
      m.scale.set(1 + Math.sin(t * Math.PI) * 0.14, 1 - Math.sin(t * Math.PI) * 0.2, 1 + Math.sin(t * Math.PI) * 0.14);
    } else m.scale.set(1, 1, 1);
  }
}

/* debris physics */
function makeDebris(mesh, vel, life) {
  liveBlocks.delete(mesh);
  lockedMap.delete(`${mesh.userData.r},${mesh.userData.c}`);
  debrisList.push({
    mesh, vx: vel.x, vy: vel.y, vz: vel.z,
    ax: (Math.random() - 0.5) * 10, ay: (Math.random() - 0.5) * 10, az: (Math.random() - 0.5) * 12,
    life: life || 0.9, maxLife: life || 0.9,
  });
}

function updateDebris(dt) {
  for (let i = debrisList.length - 1; i >= 0; i--) {
    const d = debrisList[i];
    d.life -= dt;
    if (d.life <= 0) {
      releaseBlock(d.mesh);
      debrisList.splice(i, 1);
      continue;
    }
    d.vy -= 16 * dt;
    d.mesh.position.x += d.vx * dt;
    d.mesh.position.y += d.vy * dt;
    d.mesh.position.z += d.vz * dt;
    d.mesh.rotation.x += d.ax * dt;
    d.mesh.rotation.y += d.ay * dt;
    d.mesh.rotation.z += d.az * dt;
    const t = clamp(d.life / d.maxLife, 0, 1);
    const s = t < 0.3 ? t / 0.3 : 1;
    d.mesh.scale.set(s, s, s);
  }
}

/* ============================ FX pools ============================== */

/* row flash quads */
const flashPool = [];
function rowFlash(y, colorHex) {
  let m = flashPool.find((f) => !f.active);
  if (!m) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_W + 0.8, 0.96),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    mesh.renderOrder = 3;
    scene.add(mesh);
    m = { mesh, active: false, t: 0, dur: 0.22 };
    flashPool.push(m);
  }
  m.active = true; m.t = 0;
  m.mesh.visible = true;
  m.mesh.position.set(0, y, 0.55);
  m.mesh.material.color.set(colorHex || 0xffffff);
  m.mesh.material.opacity = 0.95;
  m.mesh.scale.set(0.6, 1, 1);
  return m;
}

/* shockwave rings */
const ringPool = [];
function shockwave(x, y, colorHex, maxScale, dur) {
  let r = ringPool.find((q) => !q.active);
  if (!r) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.52, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    mesh.renderOrder = 3;
    scene.add(mesh);
    r = { mesh, active: false, t: 0, dur: 0.5, max: 10 };
    ringPool.push(r);
  }
  r.active = true; r.t = 0; r.dur = dur || 0.55; r.max = maxScale || 9;
  r.mesh.visible = true;
  r.mesh.position.set(x, y, 0.7);
  r.mesh.material.color.set(colorHex);
  r.mesh.scale.set(0.5, 0.5, 1);
  return r;
}

/* hard-drop streaks */
const streakPool = [];
function dropStreak(x, y0, y1, colorHex) {
  let s = streakPool.find((q) => !q.active);
  if (!s) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    mesh.renderOrder = 2;
    scene.add(mesh);
    s = { mesh, active: false, t: 0, dur: 0.28 };
    streakPool.push(s);
  }
  s.active = true; s.t = 0;
  s.mesh.visible = true;
  s.mesh.material.color.set(colorHex);
  s.mesh.scale.set(1, Math.abs(y1 - y0), 1);
  s.mesh.position.set(x, (y0 + y1) / 2, 0.35);
  s.mesh.material.opacity = 0.55;
  return s;
}

function updateFxPools(dt) {
  for (const f of flashPool) {
    if (!f.active) continue;
    f.t += dt;
    const t = f.t / f.dur;
    if (t >= 1) { f.active = false; f.mesh.visible = false; continue; }
    f.mesh.material.opacity = 0.95 * (1 - t) * (1 - t);
    f.mesh.scale.x = lerp(0.6, 1.08, t);
  }
  for (const r of ringPool) {
    if (!r.active) continue;
    r.t += dt;
    const t = r.t / r.dur;
    if (t >= 1) { r.active = false; r.mesh.visible = false; continue; }
    const s = lerp(0.5, r.max, 1 - Math.pow(1 - t, 3));
    r.mesh.scale.set(s, s, 1);
    r.mesh.material.opacity = 0.85 * (1 - t) * (1 - t);
  }
  for (const s of streakPool) {
    if (!s.active) continue;
    s.t += dt;
    const t = s.t / s.dur;
    if (t >= 1) { s.active = false; s.mesh.visible = false; continue; }
    s.mesh.material.opacity = 0.55 * (1 - t) * (1 - t);
    s.mesh.scale.x = 1 - t * 0.8;
  }
}

/* ======================= camera FX + uniforms ======================= */

const camFx = { shake: 0, punchOff: 0, punchVel: 0, fovKick: 0 };
let beat = 0;
let fxGlow = 0; let fxRgb = 0; let flashVal = 0; let timeScale = 1;
let dangerLevel = 0; let levelHue = 0.9; let hueCurrent = 0.9;

function shake(amp) { camFx.shake = Math.max(camFx.shake, amp); }
function punch(power) { camFx.punchVel -= power; }

function updateCamera(rawDt) {
  camFx.shake = Math.max(0, camFx.shake - rawDt * camFx.shake * 6 - rawDt * 0.4);
  camFx.punchVel += (-camFx.punchOff * 160 - camFx.punchVel * 11) * rawDt;
  camFx.punchOff += camFx.punchVel * rawDt;
  camFx.fovKick = Math.max(0, camFx.fovKick - rawDt * 60);

  camParallax.x = lerp(camParallax.x, camParallax.tx, 1 - Math.exp(-rawDt * 2.5));
  camParallax.y = lerp(camParallax.y, camParallax.ty, 1 - Math.exp(-rawDt * 2.5));

  const shx = (Math.random() - 0.5) * camFx.shake;
  const shy = (Math.random() - 0.5) * camFx.shake;
  camera.position.set(
    camParallax.x * 2.4 + shx,
    1.0 + camParallax.y * -1.6 + shy,
    camDist + camFx.punchOff,
  );
  camera.lookAt(0, 0.2, 0);
  camera.fov = 50 + camFx.fovKick;
  camera.updateProjectionMatrix();
}

function updateGlobalUniforms(rawDt) {
  beat = Math.max(0, beat - rawDt * 3.2);
  fxGlow = Math.max(0, fxGlow - rawDt * 2.0);
  fxRgb = Math.max(0, fxRgb - rawDt * 3.5);
  flashVal = Math.max(0, flashVal - rawDt * 2.2);
  floorMat.uniforms.uBeat.value = beat;
  bloomPass.strength = 0.78 + beat * 0.15 + fxGlow;
  finalPass.uniforms.uTime.value = sharedTime.value;
  finalPass.uniforms.uFlash.value = flashVal;
  finalPass.uniforms.uRgbShift.value = 0.0016 + fxRgb * 0.011;
  finalPass.uniforms.uDanger.value = dangerLevel;
  frameMat.color.copy(frameBaseColor).multiplyScalar(1 + beat * 0.6 + fxGlow * 0.7);

  hueCurrent = lerp(hueCurrent, levelHue, 1 - Math.exp(-rawDt * 0.8));
  finalPass.uniforms.uHue.value = (hueCurrent - 0.9) * 0.55;
  nebulaMat.uniforms.uColB.value.setHSL(hueCurrent, 0.85, 0.30).multiplyScalar(0.42);
  floorMat.uniforms.uColor.value.setHSL(hueCurrent, 0.9, 0.55);
}

/* ========================= attract mode ============================= */

const attractPieces = [];
{
  for (let i = 0; i < 9; i++) {
    const group = new THREE.Group();
    const type = PIECE_TYPES[Math.floor(Math.random() * 7)];
    const shape = SHAPES[type];
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c]) {
          const m = new THREE.Mesh(blockGeo, dimMats[type]);
          m.position.set(c - shape.length / 2, shape.length / 2 - r, 0);
          group.add(m);
        }
    group.scale.setScalar(0.8);
    resetAttractPiece(group);
    group.position.y = Math.random() * 30 - 15;
    scene.add(group);
    attractPieces.push(group);
  }
}
function resetAttractPiece(g) {
  g.position.x = (Math.random() - 0.5) * 26;
  g.position.y = 17;
  g.position.z = -14 - Math.random() * 10;
  g.userData.speed = 1.5 + Math.random() * 2.5;
  g.userData.spin = (Math.random() - 0.5) * 0.6;
}
function updateAttract(dt) {
  for (const g of attractPieces) {
    g.position.y -= g.userData.speed * dt;
    g.rotation.z += g.userData.spin * dt;
    g.rotation.y += g.userData.spin * 0.3 * dt;
    if (g.position.y < -16) resetAttractPiece(g);
    if (g.position.y > 18) g.position.y = 18;
  }
  const visible = game.state === 'menu' || game.state === 'over';
  for (const g of attractPieces) g.visible = visible;
}

/* ============================== HUD ================================ */

const els = {
  hud: document.getElementById('hud'),
  score: document.getElementById('score-val'),
  level: document.getElementById('level-val'),
  lines: document.getElementById('lines-val'),
  time: document.getElementById('time-val'),
  combo: document.getElementById('combo-badge'),
  hold: document.getElementById('hold-canvas'),
  holdWrap: document.getElementById('hold-wrap'),
  nextList: document.getElementById('next-list'),
  popups: document.getElementById('popups'),
  banner: document.getElementById('banner'),
  overlay: document.getElementById('overlay'),
  menu: document.getElementById('menu'),
  menuHs: document.getElementById('menu-hs'),
  pauseScreen: document.getElementById('pause-screen'),
  gameoverScreen: document.getElementById('gameover-screen'),
  goStats: document.getElementById('go-stats'),
  newHs: document.getElementById('new-hs'),
  countdown: document.getElementById('countdown'),
  touch: document.getElementById('touch'),
  mute: document.getElementById('mute-btn'),
};

const nextCanvases = [];
for (let i = 0; i < 5; i++) {
  const cv = document.createElement('canvas');
  cv.width = 120; cv.height = 78;
  cv.className = 'next-cv' + (i === 0 ? ' first' : '');
  els.nextList.appendChild(cv);
  nextCanvases.push(cv);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawMiniPiece(ctx, type, w, h, cell) {
  ctx.clearRect(0, 0, w, h);
  if (!type) return;
  const shape = SHAPES[type];
  let minR = 9, maxR = -1, minC = 9, maxC = -1;
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++)
      if (shape[r][c]) {
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      }
  const pw = (maxC - minC + 1) * cell;
  const ph = (maxR - minR + 1) * cell;
  const ox = (w - pw) / 2 - minC * cell;
  const oy = (h - ph) / 2 - minR * cell;
  const col = COLORS_CSS[type];
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const x = ox + c * cell + 1.5;
      const y = oy + r * cell + 1.5;
      const s = cell - 3;
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = 10;
      const grad = ctx.createLinearGradient(x, y, x + s, y + s);
      grad.addColorStop(0, col);
      grad.addColorStop(0.5, col);
      grad.addColorStop(1, shade(col, -0.35));
      ctx.fillStyle = grad;
      roundRectPath(ctx, x, y, s, s, 3);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = shade(col, 0.45);
      ctx.lineWidth = 1.4;
      roundRectPath(ctx, x + 0.5, y + 0.5, s - 1, s - 1, 3);
      ctx.stroke();
      ctx.restore();
    }
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function redrawHold() {
  drawMiniPiece(els.hold.getContext('2d'), game.hold, 140, 96, 26);
  els.holdWrap.classList.toggle('used', !game.canHold && game.hold);
}
function redrawNext() {
  for (let i = 0; i < nextCanvases.length; i++) {
    const ctx = nextCanvases[i].getContext('2d');
    drawMiniPiece(ctx, game.queue[i], 120, 78, i === 0 ? 24 : 20);
  }
}

let displayScore = 0;
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function updateHud(rawDt) {
  displayScore = Math.abs(game.score - displayScore) < 1
    ? game.score
    : lerp(displayScore, game.score, 1 - Math.exp(-rawDt * 9));
  els.score.textContent = Math.round(displayScore).toLocaleString('en-US');
  els.time.textContent = fmtTime(game.stats.timeMs);
  const h = game.stackHeight();
  dangerLevel = game.state === 'playing' || game.state === 'clearing'
    ? clamp((h - 13) / 6, 0, 1) * 0.85 : 0;
}

/* ============================ popups ================================ */

function popup(text, cls = '', sub = '') {
  const div = document.createElement('div');
  div.className = `popup ${cls}`;
  div.innerHTML = sub ? `<span>${text}</span><em>${sub}</em>` : `<span>${text}</span>`;
  div.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
  els.popups.appendChild(div);
  div.addEventListener('animationend', () => div.remove());
}

function banner(text, cls = '') {
  const div = document.createElement('div');
  div.className = `banner-pop ${cls}`;
  div.textContent = text;
  els.banner.appendChild(div);
  div.addEventListener('animationend', () => div.remove());
}

/* ============================ audio ================================= */

const audio = new AudioEngine();
audio.onBeat = () => { beat = 1; };

/* ============================= game ================================= */

const game = new Game();
let highScore = 0;
try { highScore = parseInt(localStorage.getItem('neon-tetris-3d-hs') || '0', 10) || 0; } catch (e) { /* ignore */ }
els.menuHs.textContent = highScore > 0 ? `HIGH SCORE ${highScore.toLocaleString('en-US')}` : '';

let clearTimer = 0;

/* ---------- event wiring ---------- */

game.on('spawn', () => { refreshActivePiece(true); redrawNext(); });

game.on('move', (e) => { audio.sfx('move'); leanTarget = e.dir > 0 ? -1 : 1; });

game.on('rotate', (e) => {
  audio.sfx('rotate');
  if (e.kicked) shake(0.05);
});

game.on('softstep', () => { audio.sfx('softstep'); });

game.on('harddrop', (e) => {
  audio.sfx('harddrop');
  shake(0.5); punch(9);
  const type = game.active ? game.active.type : 'I';
  const colsUsed = new Set(e.cells.map(([, c]) => c));
  const endY = gridToWorld(e.cells[0][0], 0).y;
  const startY = endY + e.distance;
  for (const c of colsUsed) {
    const w = gridToWorld(0, c);
    dropStreak(w.x, startY + 0.5, endY - 0.5, COLORS[type]);
  }
  for (const [r, c] of e.cells) {
    const w = gridToWorld(r, c);
    burst(w.x, w.y - 0.45, 0.3, COLORS[type], 6, { speed: 2.2, up: 1.2, life: 0.4, size: 7, gravity: 6 });
  }
  for (const m of activeCubes) { m.userData.snap = true; }
  refreshActivePiece();
});

game.on('lock', (e) => {
  audio.sfx('lock');
  const type = e.type;
  const fromDrop = game.lastAction === 'drop';
  for (let i = 0; i < 4; i++) {
    const m = activeCubes[i];
    if (!m.visible) continue;
    m.material = lockedMats[type];
    m.rotation.set(0, 0, 0);
    m.userData.type = type;
    m.userData.pop = fromDrop ? 0 : 0.18;
    m.userData.squash = fromDrop ? 0.16 : 0;
  }
  /* take ownership: register in map, spawn fresh cubes for next piece */
  const cells = e.cells;
  for (let i = 0; i < cells.length; i++) {
    const m = activeCubes[i];
    const [r, c] = cells[i];
    m.userData.r = r; m.userData.c = c;
    const w = gridToWorld(r, c);
    m.userData.tx = w.x; m.userData.ty = w.y;
    lockedMap.set(`${r},${c}`, m);
  }
  for (let i = 0; i < 4; i++) {
    const fresh = acquireBlock();
    fresh.visible = false;
    activeCubes[i] = fresh;
  }
});

game.on('clear', (e) => {
  const big = e.count === 4;
  const dur = big ? 0.95 : CLEAR_ANIM_BASE + e.count * 0.05;
  clearTimer = dur;

  for (const r of e.rows) {
    const y = gridToWorld(r, 0).y;
    rowFlash(y, big ? 0xffffff : 0xffd1e6);
    for (let c = 0; c < COLS; c++) {
      const key = `${r},${c}`;
      const mesh = lockedMap.get(key);
      if (!mesh) continue;
      const type = mesh.userData.type;
      const dir = Math.sign(mesh.position.x) || (Math.random() - 0.5);
      makeDebris(mesh, {
        x: dir * (2 + Math.random() * 6),
        y: 2 + Math.random() * 6,
        z: 2 + Math.random() * 5,
      }, 0.85 + Math.random() * 0.35);
      burst(mesh.position.x, mesh.position.y, 0.4, COLORS[type], 10,
        { speed: 3.5, up: 2, life: 0.6, size: 9, gravity: 7 });
    }
  }

  shake(big ? 0.9 : 0.28 + e.count * 0.12);
  punch(big ? 14 : 5 + e.count * 2);
  fxGlow = Math.max(fxGlow, big ? 1.1 : 0.35 + e.count * 0.12);

  if (e.tspin && e.count === 0) {
    audio.sfx('tspin');
    popup('T-SPIN', 'p-tspin');
    shockwave(0, gridToWorld(e.rows[0], 0).y, 0xffffff, 11, 0.6);
  }
  if (big) {
    audio.sfx('tetris');
    timeScale = 0.25;
    flashVal = 0.5;
    finalPass.uniforms.uFlashColor.value.setRGB(1, 0.78, 0.9);
    fxRgb = 1;
    camFx.fovKick = 7;
    for (const r of e.rows) shockwave(0, gridToWorld(r, 0).y, 0xffa8d4, 13, 0.7);
    shockwave(0, 0, 0xffffff, 18, 0.9);
    popup('TETRIS', 'p-tetris');
  } else {
    audio.sfx('clear', { lines: e.count });
    shockwave(0, gridToWorld(e.rows[0], 0).y, 0xffa8d4, 8, 0.5);
    if (e.count >= 2) popup(e.name, e.count === 3 ? 'p-triple' : 'p-double');
    if (e.tspin) audio.sfx('tspin');
  }

  if (e.combo > 0) {
    audio.sfx('combo', { combo: e.combo });
    popup(`COMBO ×${e.combo + 1}`, 'p-combo');
    els.combo.textContent = `COMBO ×${e.combo + 1}`;
    els.combo.classList.add('on');
  }
  if (e.b2b) { audio.sfx('b2b'); banner('BACK-TO-BACK ×1.5', 'b2b'); }
  if (e.perfect) {
    audio.sfx('perfect');
    flashVal = 0.75;
    finalPass.uniforms.uFlashColor.value.setRGB(1, 1, 0.85);
    popup('PERFECT CLEAR', 'p-perfect');
    for (let i = 0; i < 3; i++) shockwave(0, 0, 0xffe28a, 16 + i * 4, 0.8 + i * 0.15);
    for (let i = 0; i < 40; i++) {
      burst((Math.random() - 0.5) * 10, -9 + Math.random() * 18, 1, 0xffe28a, 3,
        { speed: 6, up: 5, life: 1.2, size: 12, gravity: 4 });
    }
  }
  if (e.points > 0) popup(`+${e.points.toLocaleString('en-US')}`, 'p-points');
});

game.on('lines', (e) => {
  els.lines.textContent = e.lines;
  els.level.textContent = e.level;
  els.combo.classList.remove('on');
});

game.on('levelup', (e) => {
  audio.sfx('levelup');
  banner(`LEVEL ${e.level}`, 'levelup');
  flashVal = Math.max(flashVal, 0.3);
  fxGlow = Math.max(fxGlow, 0.8);
  levelHue = 0.9 + ((e.level - 1) * 0.075) % 1;
  shockwave(0, 0, 0xffffff, 20, 0.8);
  for (let i = 0; i < 5; i++) {
    burst((Math.random() - 0.5) * 10, -9.4, 0.5, 0xffa8d4, 12,
      { speed: 5, up: 8, life: 1, size: 10, gravity: 5 });
  }
});

game.on('hold', () => { audio.sfx('hold'); redrawHold(); refreshActivePiece(true); });

game.on('gameover', () => {
  audio.stopMusic();
  audio.sfx('gameover');
  flashVal = 0.45;
  finalPass.uniforms.uFlashColor.value.setRGB(1, 0.15, 0.2);
  fxRgb = 1; fxGlow = 1;
  shake(0.7);
  timeScale = 1;
  /* cascade the stack into debris, bottom-up */
  const byRow = new Map();
  for (const m of liveBlocks) {
    if (activeCubes.includes(m)) continue;
    const r = m.userData.r;
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r).push(m);
  }
  const rows = [...byRow.keys()].sort((a, b) => b - a);
  rows.forEach((r, idx) => {
    setTimeout(() => {
      for (const m of byRow.get(r)) {
        makeDebris(m, {
          x: (Math.random() - 0.5) * 6,
          y: -2 - Math.random() * 3,
          z: 1 + Math.random() * 4,
        }, 1.2);
        burst(m.position.x, m.position.y, 0.4, COLORS[m.userData.type] || 0xff3860, 6,
          { speed: 3, up: 2, life: 0.7, size: 8, gravity: 8 });
      }
      shake(0.25);
      audio.sfx('lock');
    }, idx * 55);
  });
  for (const m of activeCubes) m.visible = false;
  for (const g of ghostFills) { g.line.visible = false; g.fill.visible = false; }

  const isHs = game.score > highScore;
  if (isHs) {
    highScore = game.score;
    try { localStorage.setItem('neon-tetris-3d-hs', String(highScore)); } catch (err) { /* ignore */ }
  }
  setTimeout(() => {
    els.goStats.innerHTML = `
      <div class="go-score">${game.score.toLocaleString('en-US')}</div>
      <div class="go-grid">
        <span>LINES</span><b>${game.lines}</b>
        <span>LEVEL</span><b>${game.level}</b>
        <span>TIME</span><b>${fmtTime(game.stats.timeMs)}</b>
        <span>PIECES</span><b>${game.stats.pieces}</b>
        <span>TETRIS</span><b>${game.stats.tetris}</b>
        <span>T-SPINS</span><b>${game.stats.tSpins}</b>
        <span>MAX COMBO</span><b>${game.stats.maxCombo > 0 ? `×${game.stats.maxCombo + 1}` : '-'}</b>
      </div>`;
    els.newHs.classList.toggle('hidden', !isHs);
    showScreen('gameover');
  }, 1600);
});

game.on('pause', () => { audio.setMusicOn(false); showScreen('pause'); });
game.on('resume', () => { audio.setMusicOn(true); hideScreens(); });

/* --------------------- board reset helper -------------------------- */

function clearBoardVisuals() {
  for (const m of [...liveBlocks]) releaseBlock(m);
  lockedMap.clear();
  for (const d of debrisList) releaseBlock(d.mesh);
  debrisList.length = 0;
  P.n = 0;
  for (const m of activeCubes) { m.visible = false; m.userData.tx = undefined; }
  while (activeCubes.length) activeCubes.pop();
  for (let i = 0; i < 4; i++) {
    const fresh = acquireBlock();
    fresh.visible = false;
    activeCubes.push(fresh);
  }
  displayScore = 0;
  els.combo.classList.remove('on');
  levelHue = 0.9 + ((game.level - 1) * 0.075) % 1;
}

/* --------------------------- screens ------------------------------- */

const SCREEN_IDS = { menu: 'menu', pause: 'pause-screen', gameover: 'gameover-screen' };
function showScreen(name) {
  els.overlay.classList.remove('hidden');
  for (const s of ['menu', 'pause-screen', 'gameover-screen']) {
    document.getElementById(s).classList.add('hidden');
  }
  if (name) document.getElementById(SCREEN_IDS[name]).classList.remove('hidden');
}
function hideScreens() {
  els.overlay.classList.add('hidden');
  for (const s of ['menu', 'pause-screen', 'gameover-screen']) {
    document.getElementById(s).classList.add('hidden');
  }
}

let countingDown = false;
function startCountdown() {
  countingDown = true;
  hideScreens();
  els.hud.classList.remove('hidden');
  els.countdown.classList.remove('hidden');
  const steps = ['3', '2', '1', 'GO'];
  let i = 0;
  const tick = () => {
    if (i >= steps.length) {
      els.countdown.classList.add('hidden');
      countingDown = false;
      game.start(1);
      audio.startMusic();
      return;
    }
    const txt = steps[i];
    els.countdown.textContent = txt;
    els.countdown.classList.remove('pop');
    void els.countdown.offsetWidth;
    els.countdown.classList.add('pop');
    if (txt === 'GO') {
      audio.sfx('go');
      punch(12); shake(0.4);
      fxGlow = 0.9;
    } else {
      audio.sfx('count');
      punch(5);
    }
    i++;
    setTimeout(tick, txt === 'GO' ? 500 : 620);
  };
  tick();
}

/* ============================= input ================================ */

const input = {
  left: false, right: false, soft: false,
  das: 0, arr: 0, dasDir: 0,
};
const DAS = 0.14, ARR = 0.032;

function anyGesture() {
  audio.init();
  audio.resume();
}
window.addEventListener('pointerdown', anyGesture, { once: false });
window.addEventListener('keydown', anyGesture, { once: false });

window.addEventListener('keydown', (e) => {
  if (e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
  switch (e.code) {
    case 'ArrowLeft': case 'ArrowRight': {
      e.preventDefault();
      const dir = e.code === 'ArrowLeft' ? -1 : 1;
      input[dir < 0 ? 'left' : 'right'] = true;
      input.das = 0; input.arr = 0; input.dasDir = dir;
      game.tryShift(dir);
      break;
    }
    case 'ArrowDown':
      e.preventDefault();
      if (!input.soft) { input.soft = true; game.setSoftDrop(true); }
      break;
    case 'ArrowUp': case 'KeyX':
      e.preventDefault(); game.rotate(1); break;
    case 'KeyZ': case 'ControlLeft': case 'ControlRight':
      game.rotate(-1); break;
    case 'Space':
      e.preventDefault(); game.hardDrop(); break;
    case 'KeyC': case 'ShiftLeft': case 'ShiftRight':
      game.holdPiece(); break;
    case 'KeyP': case 'Escape':
      if (game.state === 'playing' || game.state === 'clearing') game.pause();
      else if (game.state === 'paused') game.resume();
      break;
    case 'KeyM':
      audio.toggleMute();
      els.mute.classList.toggle('muted', audio.muted);
      break;
    case 'KeyR':
      if (game.state === 'paused' || game.state === 'over' || game.state === 'playing' || game.state === 'clearing') {
        restart();
      }
      break;
    case 'Enter':
      if (game.state === 'menu' || game.state === 'over') {
        if (!countingDown) { audio.sfx('select'); restart(); }
      } else if (game.state === 'paused') {
        game.resume();
      }
      break;
    default: break;
  }
});

window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'ArrowLeft':
      input.left = false;
      if (input.dasDir === -1) input.dasDir = input.right ? 1 : 0;
      break;
    case 'ArrowRight':
      input.right = false;
      if (input.dasDir === 1) input.dasDir = input.left ? -1 : 0;
      break;
    case 'ArrowDown':
      input.soft = false;
      game.setSoftDrop(false);
      break;
    default: break;
  }
});

function updateInput(rawDt) {
  if (game.state !== 'playing' || input.dasDir === 0) return;
  input.das += rawDt;
  if (input.das >= DAS) {
    input.arr += rawDt;
    while (input.arr >= ARR) {
      input.arr -= ARR;
      if (!game.tryShift(input.dasDir)) break;
    }
  }
}

/* pointer parallax */
window.addEventListener('pointermove', (e) => {
  camParallax.tx = (e.clientX / window.innerWidth) * 2 - 1;
  camParallax.ty = (e.clientY / window.innerHeight) * 2 - 1;
});

/* touch buttons */
function bindTouch(id, down, up) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    down();
  });
  const end = (e) => { e.preventDefault(); if (up) up(); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
bindTouch('t-left', () => { input.left = true; input.dasDir = -1; input.das = 0; input.arr = 0; game.tryShift(-1); },
  () => { input.left = false; if (input.dasDir === -1) input.dasDir = 0; });
bindTouch('t-right', () => { input.right = true; input.dasDir = 1; input.das = 0; input.arr = 0; game.tryShift(1); },
  () => { input.right = false; if (input.dasDir === 1) input.dasDir = 0; });
bindTouch('t-rot', () => game.rotate(1));
bindTouch('t-drop', () => game.hardDrop());
bindTouch('t-hold', () => game.holdPiece());
bindTouch('t-soft', () => { game.setSoftDrop(true); }, () => { game.setSoftDrop(false); });
if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
  els.touch.classList.remove('hidden');
}

els.mute.addEventListener('click', (e) => {
  e.stopPropagation();
  audio.toggleMute();
  els.mute.classList.toggle('muted', audio.muted);
});

const volumeSlider = document.getElementById('volume-slider');
if (volumeSlider) {
  volumeSlider.value = Math.round(audio.volume * 100);
  const paintSlider = () => {
    const v = Number(volumeSlider.value);
    volumeSlider.style.background = `linear-gradient(90deg, #ff9ed2 ${v}%, rgba(255, 158, 210, 0.18) ${v}%)`;
  };
  paintSlider();
  volumeSlider.addEventListener('pointerdown', (e) => e.stopPropagation());
  volumeSlider.addEventListener('input', () => {
    audio.setVolume(Number(volumeSlider.value) / 100);
    paintSlider();
    els.mute.classList.toggle('muted', audio.muted);
  });
}

document.getElementById('menu').addEventListener('click', () => {
  if (game.state === 'menu' && !countingDown) { audio.sfx('select'); restart(); }
});
document.getElementById('gameover-screen').addEventListener('click', () => {
  if (game.state === 'over' && !countingDown) { audio.sfx('select'); restart(); }
});

function restart() {
  game.reset();
  audio.stopMusic();
  clearBoardVisuals();
  els.hud.classList.remove('hidden');
  els.level.textContent = '1';
  els.lines.textContent = '0';
  els.time.textContent = '00:00';
  redrawHold();
  startCountdown();
}

/* auto-pause when tab hidden */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (game.state === 'playing' || game.state === 'clearing')) game.pause();
});

/* ============================ resize ================================ */

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  const vFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const distH = (BOARD_H / 2 + 2.1) / Math.tan(vFov);
  const distW = (BOARD_W / 2 + 1.9) / (Math.tan(vFov) * camera.aspect);
  camDist = clamp(Math.max(distH, distW) * 1.04, 20, 60);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
  updateFxaaResolution();
}
window.addEventListener('resize', onResize);
onResize();

/* ============================ main loop ============================= */

els.hud.classList.add('hidden');
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min((now - last) / 1000, 0.05);
  last = now;

  timeScale += (1 - timeScale) * Math.min(1, rawDt * 2.6);
  if (timeScale > 0.995) timeScale = 1;
  const dt = rawDt * timeScale;
  sharedTime.value += dt;

  audio.update();
  game.update(dt);
  updateInput(rawDt);

  if (game.state === 'clearing') {
  clearTimer -= dt;
  if (clearTimer <= 0) {
   const rows = game.clearingRows.slice();
   game.finishClear();
   /* shift surviving blocks down, then rebuild the (r,c)->mesh map */
   const survivors = [];
   for (const m of lockedMap.values()) {
   const shift = rows.filter((r) => r > m.userData.r).length;
   m.userData.r += shift;
   const w = gridToWorld(m.userData.r, m.userData.c);
   m.userData.tx = w.x; m.userData.ty = w.y;
   survivors.push(m);
   }
   lockedMap.clear();
   for (const m of survivors) lockedMap.set(`${m.userData.r},${m.userData.c}`, m);
  }
  }

  refreshActivePiece();
  updateActiveCubes(dt);
  updateLockedBlocks(dt);
  updateDebris(dt);
  updateParticles(dt);
  updateFxPools(dt);
  updateGhost();
  updateAttract(dt);

  ico.rotation.x += dt * 0.05;
  ico.rotation.y += dt * 0.08;
  ico2.rotation.x -= dt * 0.09;
  ico2.rotation.y += dt * 0.06;
  if (window.__stars) window.__stars.rotation.y += dt * 0.006;

  boardGroup.rotation.y = Math.sin(sharedTime.value * 0.4) * 0.012;

  updateCamera(rawDt);
  updateGlobalUniforms(rawDt);
  updateHud(rawDt);

  composer.render();
}
requestAnimationFrame(frame);

/* ---------------------- dev/test harness hooks --------------------- */
window.addEventListener('error', (e) => {
  const log = document.getElementById('err-log');
  if (log) {
    log.style.display = 'block';
    log.textContent += `ERR ${e.message} @ ${e.filename}:${e.lineno}  `;
  }
});
{
  const params = new URLSearchParams(location.search);
  if (params.get('autostart')) setTimeout(() => restart(), 400);
  if (params.get('democlear')) {
    setTimeout(() => {
      try {
        if (game.state !== 'playing') { window.__demoFail = 'state=' + game.state; return; }
        for (let c = 0; c < COLS; c++) if (c !== 4 && c !== 5) game.grid[ROWS - 1][c] = 'J';
        game.active = game.makePiece('O');
        game.active.x = 4; game.active.y = ROWS - 3;
        game.hardDrop();
        window.__demoRan = true;
      } catch (err) {
        window.__demoFail = String(err && err.stack || err);
      }
    }, 3200);
  }
  if (params.get('demodeath')) {
    setTimeout(() => { if (game.state === 'playing') game.gameOver(); }, 3200);
  }
  if (params.get('debug')) {
    const dbg = document.createElement('div');
    dbg.id = 'dbg';
    dbg.style.cssText = 'position:fixed;left:8px;bottom:44px;z-index:99;color:#0f0;font:11px monospace;white-space:pre;pointer-events:none';
    document.body.appendChild(dbg);
    setInterval(() => {
      let badKeys = 0, gridMismatch = 0, orphans = 0;
      for (const [key, m] of lockedMap) {
        const [r, c] = key.split(',').map(Number);
        if (m.userData.r !== r || m.userData.c !== c) badKeys++;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS || game.grid[r][c] === null) gridMismatch++;
      }
      for (const m of liveBlocks) {
        if (activeCubes.includes(m)) continue;
        if (lockedMap.get(`${m.userData.r},${m.userData.c}`) !== m) orphans++;
      }
      dbg.textContent = `badKeys=${badKeys} gridMismatch=${gridMismatch} orphans=${orphans} map=${lockedMap.size} live=${liveBlocks.size} state=${game.state} active=${game.active ? 1 : 0} demo=${window.__demoRan ? 'ran' : window.__demoFail || 'no'} score=${game.score}`;
    }, 400);
  }
  if (params.get('autoplay')) {
    setInterval(() => {
      if (game.state !== 'playing') return;
      const r = Math.random();
      if (r < 0.3) game.rotate(Math.random() < 0.5 ? 1 : -1);
      else if (r < 0.5) game.tryShift(Math.random() < 0.5 ? -1 : 1);
      else if (r < 0.6) game.holdPiece();
      else game.hardDrop();
    }, 240);
  }
}
