import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SUN_DIR, BODIES, KEYFRAMES, DISTANCES_KM, ACCENTS } from './config.js';
import * as S from './shaders.js';

const { gsap, ScrollTrigger, Lenis } = window;
gsap.registerPlugin(ScrollTrigger);

const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = reducedMQ.matches;
// Pick up emulation changes made after load (test runners may emulate late).
reducedMQ.addEventListener?.('change', (e) => { reduced = e.matches; });
const prefersReduced = () => reducedMQ.matches;
const isTouch = matchMedia('(pointer: coarse)').matches;
const lowPower = isTouch || navigator.hardwareConcurrency <= 4;
const N = KEYFRAMES.length;
const v3 = (a) => new THREE.Vector3(...a);
const SUN = v3(SUN_DIR).normalize();

/* ---------------- renderer / scene ---------------- */
const canvas = document.getElementById('webgl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
let dpr = Math.min(devicePixelRatio, lowPower ? 1.25 : 1.5);
renderer.setPixelRatio(dpr);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 4000);
scene.add(camera);
const clockStart = performance.now();
const uTime = { value: 0 };

scene.add(new THREE.AmbientLight(0xffffff, 0.12));
const sunLight = new THREE.DirectionalLight(0xfff1e0, 3.2);
sunLight.position.copy(SUN).multiplyScalar(100);
scene.add(sunLight);

/* ---------------- sky: nebula + stars (follow the camera = at infinity) ---------------- */
const sky = new THREE.Group();
scene.add(sky);
sky.add(new THREE.Mesh(
  new THREE.SphereGeometry(1400, 48, 32),
  new THREE.ShaderMaterial({ vertexShader: S.skyVert, fragmentShader: S.skyFrag, uniforms: { uTime }, side: THREE.BackSide, depthWrite: false })
));
{
  const count = lowPower ? 5000 : 9000;
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), size = new Float32Array(count), phase = new Float32Array(count);
  const bandN = new THREE.Vector3(0.3, 1, 0.25).normalize();
  const tmp = new THREE.Vector3(), c = new THREE.Color();
  const palette = [0xffffff, 0xcfe0ff, 0x9fc0ff, 0xfff0d8, 0xffd2a8];
  for (let i = 0; i < count; i++) {
    tmp.randomDirection();
    if (i % 2 === 0) { // half the stars hug the galactic band
      tmp.addScaledVector(bandN, -tmp.dot(bandN) * (0.75 + Math.random() * 0.25)).normalize();
    }
    tmp.multiplyScalar(900 + Math.random() * 300).toArray(pos, i * 3);
    c.set(palette[(Math.random() * palette.length) | 0]);
    const bright = Math.random() < 0.02 ? 2.6 : 0.6 + Math.random() * 0.9;
    c.multiplyScalar(bright).toArray(col, i * 3);
    size[i] = bright > 2 ? 3.4 + Math.random() * 2.5 : 1 + Math.random() * 1.8;
    phase[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const stars = new THREE.Points(g, new THREE.ShaderMaterial({
    vertexShader: S.starVert, fragmentShader: S.starFrag,
    uniforms: { uTime, uPR: { value: dpr } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  stars.frustumCulled = false;
  sky.add(stars);
}

/* ---------------- planets ---------------- */
const planetMat = (frag, extra = {}) => new THREE.ShaderMaterial({
  vertexShader: S.planetVert, fragmentShader: frag,
  uniforms: { uSun: { value: SUN }, uTime, ...extra },
});
function atmosphere(body, color, scale, intensity) {
  const ra = body.r * scale;
  const m = new THREE.Mesh(new THREE.SphereGeometry(ra, 64, 48), new THREE.ShaderMaterial({
    vertexShader: S.atmoVert, fragmentShader: S.atmoFrag,
    uniforms: { uSun: { value: SUN }, uCenter: { value: v3(body.c) }, uColor: { value: new THREE.Color(color) }, uRp: { value: body.r }, uRa: { value: ra }, uIntensity: { value: intensity } },
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  m.position.copy(v3(body.c));
  scene.add(m);
}
const spinners = [];
function planet(body, material, { tilt = 0, spin = 0.02, seg = 128 } = {}) {
  const pivot = new THREE.Group();
  pivot.position.copy(v3(body.c));
  pivot.rotation.z = tilt;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(body.r, seg, seg * 0.75), material);
  pivot.add(mesh);
  scene.add(pivot);
  spinners.push([mesh, spin]);
  return { pivot, mesh };
}

const earth = planet(BODIES.earth, planetMat(S.earthFrag), { tilt: 0.41, spin: 0.018 });
{
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(BODIES.earth.r * 1.012, 128, 96), new THREE.ShaderMaterial({
    vertexShader: S.planetVert, fragmentShader: S.cloudFrag, uniforms: { uSun: { value: SUN }, uTime },
    transparent: true, depthWrite: false,
  }));
  earth.pivot.add(clouds);
  spinners.push([clouds, 0.024]);
}
atmosphere(BODIES.earth, 0x4f9dff, 1.14, 1.0);

planet(BODIES.moon, planetMat(S.moonFrag), { tilt: 0.1, spin: 0.01, seg: 96 });
planet(BODIES.mars, planetMat(S.marsFrag), { tilt: 0.44, spin: 0.02, seg: 96 });
atmosphere(BODIES.mars, 0xff8a5c, 1.06, 0.8);

const gas = (c, bands, turb, spot, rim) => planetMat(S.gasFrag, {
  uC1: { value: new THREE.Color(c[0]) }, uC2: { value: new THREE.Color(c[1]) }, uC3: { value: new THREE.Color(c[2]) }, uC4: { value: new THREE.Color(c[3]) },
  uBands: { value: bands }, uTurb: { value: turb }, uSpot: { value: spot }, uRim: { value: new THREE.Color(rim) },
});
planet(BODIES.jupiter, gas([0xd8c3a0, 0x9c6b45, 0xefe3cc, 0x6e4a33], 16, 1.6, 1, 0x6688aa), { tilt: 0.05, spin: 0.03 });
atmosphere(BODIES.jupiter, 0xc9a27a, 1.04, 0.5);

const saturn = planet(BODIES.saturn, gas([0xe6d3a8, 0xc7a86f, 0xf1e6c8, 0xa88a58], 22, 0.6, 0, 0x887755), { tilt: 0, spin: 0.028 });
atmosphere(BODIES.saturn, 0xe8cf9a, 1.04, 0.45);
{
  const b = BODIES.saturn;
  saturn.pivot.rotation.set(b.tilt[0] - Math.PI / 2, b.tilt[1], b.tilt[2]);
  saturn.mesh.rotation.x = Math.PI / 2; // keep bands horizontal relative to the ring plane
  const ring = new THREE.Mesh(new THREE.RingGeometry(b.ringIn, b.ringOut, 256, 1), new THREE.ShaderMaterial({
    vertexShader: S.ringVert, fragmentShader: S.ringFrag,
    uniforms: { uSun: { value: SUN }, uPlanet: { value: v3(b.c) }, uPR: { value: b.r }, uIn: { value: b.ringIn }, uOut: { value: b.ringOut } },
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
  }));
  saturn.pivot.add(ring);
}
// spin Saturn around its own pole (object Y after the X rotation above)
spinners.splice(spinners.findIndex(([m]) => m === saturn.mesh), 1);

/* ---------------- camera path ---------------- */
let posCurve, lookCurve;
function buildCurves() {
  const portrait = innerWidth / innerHeight < 0.85;
  const pos = [], look = [];
  for (const k of KEYFRAMES) {
    if (k.pos) { pos.push(v3(k.pos)); look.push(v3(k.lookAt)); continue; }
    const b = BODIES[k.body], c = v3(b.c), r = b.r ?? b.rs * 3;
    pos.push(c.clone().add(v3(k.off).multiplyScalar(portrait ? 1.5 : 1)));
    look.push(portrait ? c.clone().add(new THREE.Vector3(0, -r * 0.85, 0)) : c.clone().add(v3(k.look)));
  }
  posCurve = new THREE.CatmullRomCurve3(pos, false, 'centripetal');
  lookCurve = new THREE.CatmullRomCurve3(look, false, 'centripetal');
}
buildCurves();

/* ---------------- asteroid belt ---------------- */
const belt = { mesh: null, data: [], dust: null };
{
  const count = lowPower ? 900 : 1800;
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = 1 + 0.22 * Math.sin(x * 3.1 + y * 1.7) * Math.cos(z * 2.3 - x) + 0.12 * Math.sin(y * 5.3 + z * 4.1);
    p.setXYZ(i, x * d * 1.25, y * d * 0.85, z * d);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x7a6d60, roughness: 0.95, metalness: 0.05, flatShading: true, transparent: true, opacity: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const path = posCurve.getPoints(600);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3(), col = new THREE.Color();
  let i = 0, guard = 0;
  while (i < count && guard++ < count * 20) {
    t.set(-70 + Math.random() * 160, -16 + Math.random() * 32, -175 - Math.random() * 130);
    if (path.some((pp) => pp.distanceToSquared(t) < 36)) continue;
    const sc = 0.12 + Math.pow(Math.random(), 3) * 2.2;
    const axis = new THREE.Vector3().randomDirection();
    const d = { pos: t.clone(), scale: sc, axis, angle: Math.random() * 6.28, speed: (Math.random() - 0.5) * 0.6 };
    belt.data.push(d);
    q.setFromAxisAngle(axis, d.angle);
    mesh.setMatrixAt(i, m.compose(t, q, s.setScalar(sc)));
    mesh.setColorAt(i, col.setHSL(0.07 + Math.random() * 0.04, 0.18 + Math.random() * 0.15, 0.3 + Math.random() * 0.25));
    i++;
  }
  mesh.count = i;
  scene.add(mesh);
  belt.mesh = mesh;

  const dc = lowPower ? 2000 : 4500, dp = new Float32Array(dc * 3);
  for (let j = 0; j < dc; j++) { dp[j * 3] = -80 + Math.random() * 180; dp[j * 3 + 1] = -20 + Math.random() * 40; dp[j * 3 + 2] = -165 - Math.random() * 150; }
  const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  belt.dust = new THREE.Points(dg, new THREE.PointsMaterial({ size: 0.18, color: 0xd9b48a, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(belt.dust);
}

/* ---------------- warp streaks (camera-space) ---------------- */
const streakU = { uTravel: { value: 0 }, uStretch: { value: 0 }, uDepth: { value: 140 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0xbfd8ff) } };
{
  const n = lowPower ? 350 : 700, pos = new Float32Array(n * 6), tail = new Float32Array(n * 2), seed = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = 3 + Math.pow(Math.random(), 0.6) * 26, z = -Math.random() * 140;
    for (let k = 0; k < 2; k++) {
      pos.set([Math.cos(a) * r, Math.sin(a) * r * 0.7, z], (i * 2 + k) * 3);
      tail[i * 2 + k] = k; seed[i * 2 + k] = (i % 7) / 7;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const streaks = new THREE.LineSegments(g, new THREE.ShaderMaterial({
    vertexShader: S.streakVert, fragmentShader: S.streakFrag,
    uniforms: streakU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  streaks.frustumCulled = false;
  streaks.visible = !reduced;
  camera.add(streaks);
}

/* ---------------- post-processing ---------------- */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bh = new ShaderPass(S.BlackHoleShader);
{
  const u = bh.uniforms, b = BODIES.bh;
  u.uCamPos.value = camera.position; u.uInvProj.value = camera.projectionMatrixInverse; u.uCamWorld.value = camera.matrixWorld;
  u.uViewProj.value = new THREE.Matrix4(); u.uBH.value = v3(b.c); u.uS.value = b.rs; u.uSteps.value = lowPower ? 160 : 260;
  u.uTilt.value = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.22, 0, 0.12))).transpose();
}
composer.addPass(bh);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.85, 0.65, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const film = new ShaderPass(S.FilmShader);
composer.addPass(film);

/* ---------------- DOM: split headlines ---------------- */
function split(el) {
  const out = document.createDocumentFragment();
  const addWords = (text, em) => text.split(/(\s+)/).forEach((w) => {
    if (!w) return;
    if (/^\s+$/.test(w)) { out.append(' '); return; }
    const word = document.createElement('span'); word.className = 'w' + (em ? ' is-em' : '');
    [...w].forEach((ch) => { const c = document.createElement('span'); c.className = 'c'; c.textContent = ch; word.append(c); });
    out.append(word);
  });
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) addWords(n.textContent, false);
    else if (n.tagName === 'BR') out.append(document.createElement('br'));
    else addWords(n.textContent, true);
  });
  el.setAttribute('aria-label', el.textContent.trim().replace(/\s+/g, ' '));
  el.textContent = '';
  el.append(out);
  [...el.children].forEach((c) => c.setAttribute('aria-hidden', 'true'));
}
document.querySelectorAll('[data-split]').forEach(split);

const sections = [...document.querySelectorAll('.chapter')];
const rail = document.querySelector('.rail');
sections.forEach((sec, i) => {
  const b = document.createElement('button');
  b.className = 'rail__item'; b.type = 'button';
  b.innerHTML = `<span class="rail__label">${String(i).padStart(2, '0')} ${sec.dataset.name}</span><span class="rail__bar"></span>`;
  b.setAttribute('aria-label', `Go to ${sec.dataset.name}`);
  b.addEventListener('click', () => goToChapter(i));
  rail.append(b);
});
const railItems = [...rail.children];

/* ---------------- smooth scroll ---------------- */
const lenis = new Lenis({ lerp: reduced ? 1 : 0.075, smoothWheel: !reduced, wheelMultiplier: 0.9, touchMultiplier: 1.4 });
lenis.on('scroll', ScrollTrigger.update);
lenis.stop();
document.querySelector('[data-home]').addEventListener('click', () => goToChapter(0, { duration: 4.5, easing: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2) }));

/* ---------------- pointer + cursor ---------------- */
const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
const cursor = document.querySelector('.cursor');
let cx = innerWidth / 2, cy = innerHeight / 2, tx = cx, ty = cy;
addEventListener('pointermove', (e) => {
  pointer.x = e.clientX / innerWidth * 2 - 1; pointer.y = e.clientY / innerHeight * 2 - 1;
  tx = e.clientX; ty = e.clientY;
  cursor.classList.toggle('is-hover', !!e.target.closest('a, button'));
});
if (isTouch) cursor.remove();

/* ---------------- HUD ---------------- */
const hud = {
  dist: document.querySelector('[data-dist]'), vel: document.querySelector('[data-vel]'),
  ch: document.querySelector('[data-ch]'), clock: document.querySelector('[data-clock]'), hint: document.querySelector('.scroll-hint'),
};
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
const LY = 9.461e12, C = 299792;
function fmtDist(km) {
  if (km >= LY * 0.01) return `${(km / LY).toLocaleString('en', { maximumFractionDigits: km > LY * 10 ? 0 : 2 })} ly`;
  if (km < 1e5) return `${Math.round(km).toLocaleString('en')} km`;
  return `${compact.format(km)} km`;
}
const logD = DISTANCES_KM.map((d) => Math.log10(1 + d));
const distAt = (x) => { const i = Math.min(Math.floor(x), N - 2), f = x - i; return Math.pow(10, logD[i] + (logD[i + 1] - logD[i]) * f) - 1; };

let activeIdx = -1;
function setActive(i) {
  if (i === activeIdx) return;
  activeIdx = i;
  document.documentElement.style.setProperty('--accent', ACCENTS[i]);
  railItems.forEach((b, j) => b.classList.toggle('is-active', j === i));
  hud.ch.textContent = `${String(i).padStart(2, '0')} / ${String(N - 1).padStart(2, '0')}`;
}
const chapterOf = (x) => THREE.MathUtils.clamp(Math.round(x), 0, N - 1);

/* ---------------- unified voyage controller ----------------
 * `voyage.value` is the single "voyage progress" source of truth, expressed in
 * chapter units (0..N-1). The camera curves, HUD distance/velocity, chapter
 * label and rail active item are ALL derived from it. Wheel/scroll and the
 * rail/deep-link controller only propose targets; the frame loop converges
 * `value` onto the current target. That keeps camera + HUD + rail in lock-step
 * through jumps, deep links and resizes.
 */
const JUMP_SECONDS = 2.4;
const JUMP_EASE = (t) => 1 - Math.pow(1 - t, 4);

const voyage = { value: 0, goal: 0, navChapter: null, navStart: 0, navDurMs: JUMP_SECONDS * 1000 };
// Chapter a programmatic jump / deep link should stay anchored to. Re-asserted
// across resizes until the visitor takes over with an input device.
let anchorChapter = null;
let chapterTops = [];

function measureChapters() {
  chapterTops = sections.map((sec) => sec.getBoundingClientRect().top + window.scrollY);
}

// Real scroll offset -> chapter coordinate that is exactly the integer index at
// each section top. Piecewise-linear so variable-height / reflowed chapters and
// post-resize limits still map to the correct chapter (no pull-back).
function rawChapterFromScroll() {
  if (chapterTops.length !== N) measureChapters();
  const y = lenis ? lenis.animatedScroll : window.scrollY;
  const tops = chapterTops;
  if (!tops.length) return 0;
  if (y <= tops[0]) return 0;
  if (y >= tops[N - 1]) return N - 1;
  for (let i = 0; i < N - 1; i++) {
    if (y >= tops[i] && y <= tops[i + 1]) {
      const span = tops[i + 1] - tops[i];
      return i + (span > 0 ? (y - tops[i]) / span : 0);
    }
  }
  return N - 1;
}

// Dwell/easing shape of the path, in chapter units (same curve as before).
function shapedChapter(f) {
  const x = THREE.MathUtils.clamp(f, 0, N - 1);
  const i = Math.min(Math.floor(x), N - 2);
  const e = smoother(THREE.MathUtils.clamp((x - i - 0.18) / 0.64, 0, 1));
  return i + e;
}

// Visitor input cancels any controlled anchor so normal scrolling takes over.
function releaseAnchor() { anchorChapter = null; voyage.navChapter = null; }
addEventListener('wheel', releaseAnchor, { passive: true });
addEventListener('touchstart', releaseAnchor, { passive: true });
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) releaseAnchor();
});

function goToChapter(input, opts = {}) {
  let ch = Number(input);
  ch = Number.isInteger(ch) ? THREE.MathUtils.clamp(ch, 0, N - 1) : 0;
  const duration = opts.duration ?? JUMP_SECONDS;
  const instant = opts.immediate === true || prefersReduced();
  if (instant || typeof lenis === 'undefined' || !lenis) {
    voyage.navChapter = null;
    anchorChapter = ch;
    measureChapters();
    if (lenis) lenis.scrollTo(sections[ch], { immediate: true, force: true });
    voyage.value = ch; voyage.goal = ch;
    prevKm = distAt(ch); velKmS = 0;
    setActive(ch);
    return;
  }
  anchorChapter = null;
  voyage.navChapter = ch;
  voyage.navStart = performance.now();
  voyage.navDurMs = duration * 1000;
  lenis.scrollTo(sections[ch], { duration, easing: opts.easing ?? JUMP_EASE, force: true });
}

// Strict ?at=N: only canonical integers within 0..N-1 apply. A present but
// non-integer / out-of-range value falls back to chapter 0 without throwing.
// Absent `at` returns null so the ordinary top-of-page entry is unchanged.
function readDeepChapter() {
  const raw = new URLSearchParams(location.search).get('at');
  if (raw === null) return null; // no deep link: ordinary top-of-page entry
  const s = raw.trim();
  if (s === '') return 0;
  const n = Number(s);
  // Out-of-range, NaN and non-integer values all fall back to chapter 0.
  if (!Number.isInteger(n) || n < 0 || n > N - 1) return 0;
  return n;
}

// Re-assert a deep-link / settled anchor after late layout shifts (web fonts),
// but never after the visitor has taken over scrolling.
function reassertAnchor() {
  if (anchorChapter == null || voyage.navChapter != null) return;
  const ch = anchorChapter;
  measureChapters();
  if (lenis) { lenis.resize(); lenis.scrollTo(sections[ch], { immediate: true, force: true }); }
  voyage.value = ch; voyage.goal = ch;
  prevKm = distAt(ch); velKmS = 0;
  setActive(ch);
}
addEventListener('load', () => { measureChapters(); requestAnimationFrame(reassertAnchor); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measureChapters(); reassertAnchor(); }).catch(() => {});

// Optional inspection / manual-drive hook. All readouts are live views of the
// single voyage progress; harmless to normal interaction.
window.__ODYSSEY__ = {
  get progress() { return voyage.value; },
  get goal() { return voyage.goal; },
  get chapter() { return chapterOf(voyage.value); },
  get active() { return activeIdx; },
  get navigatingTo() { return voyage.navChapter; },
  snapshot: () => ({
    p: +voyage.value.toFixed(4), goal: +voyage.goal.toFixed(4),
    ch: chapterOf(voyage.value), active: activeIdx,
    nav: voyage.navChapter, anchor: anchorChapter,
    km: distAt(THREE.MathUtils.clamp(voyage.value, 0, N - 1)),
    y: Math.round(window.scrollY),
    cam: [+camera.position.x.toFixed(3), +camera.position.y.toFixed(3), +camera.position.z.toFixed(3)],
  }),
  curvePoint: (ch) => { const v = posCurve.getPoint(THREE.MathUtils.clamp(ch, 0, N - 1) / (N - 1)); return [v.x, v.y, v.z]; },
  go: (n, o) => goToChapter(n, o),
};
window.__odyssey = window.__ODYSSEY__;

// Prime the initial chapter from ?at=N immediately at module evaluation, so the
// HUD/rail/scroll are correct even before the cinematic preloader finishes.
// Boot re-asserts this after ScrollTrigger/Lenis refresh.
const initialDeep = readDeepChapter();
const initialCh = initialDeep ?? 0;
voyage.value = initialCh; voyage.goal = initialCh;
if (initialDeep !== null) anchorChapter = initialCh;
setActive(initialCh);
hud.dist.textContent = fmtDist(distAt(initialCh));
hud.vel.textContent = '0 km/s';
if (initialCh > 0) {
  measureChapters();
  lenis.resize();
  lenis.scrollTo(sections[initialCh], { immediate: true, force: true });
}

/* ---------------- chapter reveals ---------------- */
function countUp(el) {
  const end = parseFloat(el.dataset.count), dec = +(el.dataset.dec || 0), o = { v: 0 };
  gsap.to(o, { v: end, duration: 1.6, ease: 'power3.out', onUpdate: () => { el.textContent = o.v.toLocaleString('en', { minimumFractionDigits: dec, maximumFractionDigits: dec }); } });
}
function setupReveals() {
  sections.forEach((sec) => {
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'power4.out' } });
    const add = (sel, from, to, at) => { const els = sec.querySelectorAll(sel); if (els.length) tl.fromTo(els, from, to, at); };
    add('.kicker', { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9 }, 0);
    add('.headline .c', { yPercent: 115, rotate: 6 }, { yPercent: 0, rotate: 0, duration: 1.15, stagger: reduced ? 0 : 0.018 }, 0.05);
    add('.body, .cta, .quote-by', { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 1, stagger: 0.08 }, 0.35);
    add('.stat', { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, stagger: 0.08 }, 0.5);
    const play = () => { tl.timeScale(1).play(); sec.querySelectorAll('[data-count]').forEach(countUp); };
    const rev = () => tl.timeScale(1.8).reverse();
    ScrollTrigger.create({ trigger: sec, start: 'top 62%', end: 'bottom 38%', onEnter: play, onEnterBack: play, onLeave: rev, onLeaveBack: rev });
  });
}

/* ---------------- frame loop ---------------- */
let velS = 0, travel = 0, last = performance.now(), prevKm = 0, velKmS = 0;
let frameAvg = 16, frames = 0;
const smoother = (x) => x * x * x * (x * (x * 6 - 15) + 10);
const tmpPos = new THREE.Vector3(), tmpLook = new THREE.Vector3();
const bm = new THREE.Matrix4(), bq = new THREE.Quaternion(), bs = new THREE.Vector3();

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  uTime.value = (now - clockStart) / 1000;

  // A native scrollbar / keyboard scroll that starts during a programmatic
  // jump means the visitor is taking over — drop the controlled target.
  if (voyage.navChapter != null && lenis.isScrolling === 'native') voyage.navChapter = null;

  // The single voyage progress: propose a target from real scroll, then let
  // the rendered value converge on it. Everything below reads `voyage.value`.
  const f = rawChapterFromScroll();
  const goal = shapedChapter(f);
  voyage.goal = goal;
  const lenisIdle = !lenis.isSmooth && Math.abs(lenis.velocity || 0) < 0.02;
  if (prefersReduced()) {
    voyage.value = goal; // reduced motion: follow instantly, no smoothing lag
  } else {
    // Smooth camera trail while scrolling; converge quickly once scroll stops
    // so HUD/rail settle on canonical chapter values without a long tail.
    const rate = lenisIdle ? 13 : 5;
    voyage.value += (goal - voyage.value) * (1 - Math.exp(-rate * dt));
  }

  if (voyage.navChapter != null) {
    // Controlled jump: once Lenis finishes, correct scroll to the exact
    // section and pin progress on the chapter so all readouts converge.
    const ch = voyage.navChapter;
    if (lenisIdle) {
      lenis.scrollTo(sections[ch], { immediate: true, force: true });
      voyage.value = ch; voyage.goal = ch;
      voyage.navChapter = null; anchorChapter = ch;
    }
  } else if (lenisIdle && Math.abs(goal - voyage.value) < 0.01) {
    voyage.value = goal; // snap ordinary rests onto canonical chapter values
  }
  const atRest = voyage.navChapter == null && lenisIdle && Math.abs(voyage.goal - voyage.value) < 0.002;
  const camT = THREE.MathUtils.clamp(voyage.value / (N - 1), 0, 1);

  const vel = reduced ? 0 : Math.min(Math.abs(lenis.velocity) / 45, 1);
  velS += (vel - velS) * Math.min(1, dt * 4);

  posCurve.getPoint(camT, tmpPos);
  lookCurve.getPoint(camT, tmpLook);
  pointer.sx += (pointer.x - pointer.sx) * 0.05; pointer.sy += (pointer.y - pointer.sy) * 0.05;
  camera.position.copy(tmpPos);
  camera.lookAt(tmpLook);
  if (!reduced) {
    camera.translateX(pointer.sx * 0.6); camera.translateY(-pointer.sy * 0.4);
    camera.rotateZ(-Math.sign(lenis.velocity || 0) * velS * 0.05);
  }
  camera.fov = 45 + velS * 17;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  sky.position.copy(camera.position);

  for (const [m, s] of spinners) m.rotation.y += dt * s;
  saturn.mesh.rotation.y += dt * 0.028;

  // the belt fades in on approach so it doesn't clutter the Earth/Moon shots
  const beltFade = THREE.MathUtils.smoothstep(-camera.position.z, 60, 125);
  belt.mesh.material.opacity = beltFade; belt.mesh.visible = beltFade > 0;
  belt.mesh.material.depthWrite = beltFade > 0.98;
  belt.dust.material.opacity = beltFade * 0.55;
  // asteroids tumble only while nearby
  if (camera.position.z < -150 && camera.position.z > -340) {
    const mesh = belt.mesh;
    for (let i = 0; i < mesh.count; i++) {
      const d = belt.data[i]; d.angle += d.speed * dt;
      bq.setFromAxisAngle(d.axis, d.angle);
      mesh.setMatrixAt(i, bm.compose(d.pos, bq, bs.setScalar(d.scale)));
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  travel += dt * (6 + velS * 260);
  streakU.uTravel.value = travel;
  streakU.uStretch.value = velS * 22;
  streakU.uOpacity.value = Math.pow(velS, 1.4) * 1.6;

  const x = THREE.MathUtils.clamp(voyage.value, 0, N - 1);
  const u = bh.uniforms;
  u.uTime.value = uTime.value;
  u.uOn.value = THREE.MathUtils.smoothstep(x, 5.05, 5.6);
  u.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  bloom.strength = 0.85 - u.uOn.value * 0.4;
  bloom.radius = 0.65 - u.uOn.value * 0.3;
  film.uniforms.uTime.value = uTime.value;
  film.uniforms.uCA.value = reduced ? 0 : 0.0015 + velS * 0.009;

  composer.render();

  // HUD: chapter label, rail active item, distance and velocity all read the
  // same unified progress `x`, so they cannot disagree with the camera.
  setActive(chapterOf(x));
  const km = distAt(x);
  const instKmS = Math.abs(km - prevKm) / Math.max(dt, 1e-3);
  if (atRest) velKmS = 0;
  else velKmS += (instKmS - velKmS) * Math.min(1, dt * 3);
  prevKm = km;
  hud.dist.textContent = fmtDist(km);
  hud.vel.textContent = velKmS < 1 ? '0 km/s' : velKmS < C ? `${compact.format(velKmS)} km/s` : `Warp ${Math.log10(velKmS / C).toFixed(1)}`;
  const s = Math.floor(uTime.value);
  hud.clock.textContent = `T+ ${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  hud.hint.classList.toggle('is-hidden', f > 0.08);

  cx += (tx - cx) * 0.18; cy += (ty - cy) * 0.18;
  if (cursor.isConnected) cursor.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;

  // adaptive resolution: drop DPR if the GPU can't keep up (the black hole is the expensive bit)
  frameAvg += (dt * 1000 - frameAvg) * 0.05;
  if (++frames > 90 && frameAvg > 24 && dpr > 0.7) {
    dpr = Math.max(0.7, dpr - 0.2); frames = 0;
    renderer.setPixelRatio(dpr); composer.setPixelRatio(dpr); composer.setSize(innerWidth, innerHeight);
  }
}

/* ---------------- boot ---------------- */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  buildCurves();
  // `voyage.value` is a scalar chapter coordinate, so it stays valid on the
  // rebuilt curves — the camera keeps flying on the new path instead of being
  // left at an old-curve position. Refresh scroll geometry, then re-target any
  // controlled jump / deep-link anchor to the chapter's NEW pixel offset.
  lenis.resize();
  ScrollTrigger.refresh();
  measureChapters();
  if (voyage.navChapter != null) {
    const ch = voyage.navChapter;
    if (prefersReduced()) {
      lenis.scrollTo(sections[ch], { immediate: true, force: true });
      voyage.value = ch; voyage.goal = ch;
    } else {
      // Continue the same jump on the new layout rather than restarting it:
      // re-target the section's new pixel offset with the remaining time.
      const remainSec = Math.max(0.12, (voyage.navDurMs - (performance.now() - voyage.navStart)) / 1000);
      lenis.scrollTo(sections[ch], { duration: remainSec, easing: JUMP_EASE, force: true });
    }
  } else if (anchorChapter != null) {
    const ch = anchorChapter;
    lenis.scrollTo(sections[ch], { immediate: true, force: true });
    voyage.value = ch; voyage.goal = ch;
    prevKm = distAt(ch); velKmS = 0;
  }
});

async function boot() {
  const countEl = document.querySelector('.loader__count'), bar = document.querySelector('.loader__bar span');
  const o = { v: 0 };
  const counter = gsap.to(o, { v: 100, duration: 2.2, ease: 'power2.inOut', onUpdate: () => {
    countEl.textContent = String(Math.round(o.v)).padStart(3, '0');
    bar.style.transform = `scaleX(${o.v / 100})`;
  } });
  await new Promise((r) => requestAnimationFrame(r));
  // warm up: compile every material and the black-hole pass before the reveal
  camera.position.set(0, 0, 15); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  if (renderer.compileAsync) await renderer.compileAsync(scene, camera); else renderer.compile(scene, camera);
  bh.uniforms.uOn.value = 1; composer.render(); bh.uniforms.uOn.value = 0;
  await counter;

  gsap.ticker.add((time) => { lenis.raf(time * 1000); frame(performance.now()); });
  gsap.ticker.lagSmoothing(0);

  const tl = gsap.timeline();
  tl.to('.loader__inner', { yPercent: -120, opacity: 0, duration: 0.9, ease: 'power3.in' })
    .to('.loader', { opacity: 0, duration: 0.8, onComplete: () => document.querySelector('.loader').remove() }, '-=0.2')
    .to(film.uniforms.uFade, { value: 0, duration: 2.2, ease: 'power2.out' }, '<')
    .fromTo('.hud', { opacity: 0 }, { opacity: 1, duration: 1.2, stagger: 0.1 }, '-=1.4')
    .add(() => {
      lenis.start(); setupReveals(); document.body.classList.add('is-ready');
      // Deep link ?at=N enters through the exact same controlled path as a
      // rail click. Validate strictly and sync scroll + voyage together.
      lenis.resize();
      ScrollTrigger.refresh();
      measureChapters();
      const deep = readDeepChapter();
      if (deep !== null) goToChapter(deep, { immediate: true });
    }, '-=1.6');
}
boot();
