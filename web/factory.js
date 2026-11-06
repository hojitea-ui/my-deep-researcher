// 3D 연구 공장. 설비의 위치·불빛은 모두 상태(state.js)에서 계산한다.
// 같은 시점이면 같은 장면이 나오고, 재생 중에는 목표 위치로 움직이고, 시점을 건너뛰면 바로 그 자리에 놓인다.
//
// 색 규칙(디자인 브리프): 작동 중 = Industrial Teal · 문서·데이터 = Ice Steel Blue · 부족·경고 = Burnished Amber
//                        · 바탕 = Deep Graphite · 글자·구획 = Industrial Silver. 구역은 색이 아니라 번호 표지판으로 구분한다.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { Robots } from './robots.js';

const C = {
  // Chromatic Industrial — Graphite·Aluminium 설비, Signal Blue = 상태, Process Cyan = 데이터, Industrial Orange = 예외
  bg: 0x2a3136, floor: 0x343c41, concrete: 0x3c454b, plate: 0x41494f, gunmetal: 0x535d63, steel: 0x8a9599,
  dark: 0x2a3136, graphite: 0x30383d, alu: 0xbbc3c5, ti: 0xe7e9e7, silver: 0xbbc3c5,
  blue: 0x287cc2, cyan: 0x008f91, orange: 0xc16c45, idleLamp: 0x4a5359,
  cmyk: [0x00bceb, 0xe83e91, 0xf2d600, 0x343434],
};
const LAYOUT = {
  rackX: -16.6, rackZ0: -9.5, rackZ1: 9.5, rackLevels: 4, levelH: 2.75,
  exitX: -13.1, beltZ: -8, intakeZ: -3.6, outZ: 3.3, hopperZ: -3.3,
  tower: new THREE.Vector3(-8.5, 0, -15.5),
  gate: new THREE.Vector3(0, 0, 10),
  syn: new THREE.Vector3(15, 0, 6.5),
  station: new THREE.Vector3(14.5, 0, -9.5),
  baySpacing: 5.7,
};
const FONT = '"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Malgun Gothic",sans-serif';
const MONO = '"IBM Plex Mono","Cascadia Mono",Consolas,"Pretendard Variable",monospace';
const LETTERS = 'ABCDEFGH';

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.55, ...o });
const glow = (color, intensity = 0.1, base = C.dark) => mat(base, { emissive: new THREE.Color(color), emissiveIntensity: intensity, metalness: 0.3, roughness: 0.4 });
const box = (w, h, d, m) => { const x = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); x.castShadow = true; x.receiveShadow = true; return x; };
const cyl = (r, h, m, seg = 24, r2 = r) => { const x = new THREE.Mesh(new THREE.CylinderGeometry(r, r2, h, seg), m); x.castShadow = true; x.receiveShadow = true; return x; };
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ── 표지판: 그래파이트 판 · ID · 제목 · 상태 막대 ──
function canvasTexture(draw, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function clip(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

// 설비 종류 아이콘 (선 그림). 레퍼런스의 '기능별 아이콘 카드' 문법을 표지판에 옮긴 것
function drawIcon(g, kind, x, y, s, color) {
  g.save();
  g.translate(x, y); g.scale(s / 16, s / 16);
  g.strokeStyle = color; g.lineWidth = 1.4; g.lineCap = 'round'; g.lineJoin = 'round';
  const P = (d) => g.stroke(new Path2D(d));
  if (kind === 'wh') { P('M2 14V2h12v12'); P('M2 6h12M2 10h12'); P('M4 4.2h3M9 8.2h3M5 12.2h4'); }
  else if (kind === 'ct') { P('M6.5 14V7M9.5 14V7'); P('M4 7h8V3.5H4z'); P('M8 3.5V1.5'); P('M3.5 14h9'); }
  else if (kind === 'qg') { P('M3 14V4h10v10'); P('M2 4h12'); P('M5.5 9l2 2 3.5-4'); }
  else if (kind === 'sy') { P('M4 4v8a4 1.6 0 0 0 8 0V4'); P('M4 4a4 1.6 0 0 0 8 0a4 1.6 0 0 0-8 0'); P('M1.5 8H4M12 8h2.5'); }
  else if (kind === 'ms') { P('M2.5 11a5.5 5.5 0 0 1 11 0'); P('M8 11l2.8-3.4'); P('M2 13.5h12'); }
  else { P('M9.5 2H3v12h5'); P('M9.5 2l2.5 2.5V8'); g.beginPath(); g.arc(11, 11, 2.2, 0, Math.PI * 2); g.stroke(); P('M12.6 12.6l1.9 1.9'); }
  g.restore();
}

// 단계 색: 상태(Blue) · 데이터(Cyan) · 예외(Orange) · 중성(Graphite)
const STAGE_COLOR = { active: '#287cc2', data: '#008f91', alert: '#c16c45', done: '#30383d', idle: '#8e999d' };

function drawSign({ id = '', title = '', status = '', state = 'idle', stage = 'idle', icon = 'rs', badge = '' }) {
  return (g, w, h) => {
    const accent = state === 'active' ? '#287cc2' : state === 'alert' ? '#c16c45' : '#30383d';
    const hot = state === 'active' || state === 'alert';
    g.fillStyle = 'rgba(231,233,231,0.97)'; g.fillRect(0, 0, w, h);
    g.strokeStyle = hot ? accent : 'rgba(48,56,61,0.5)'; g.lineWidth = hot ? 7 : 3; g.strokeRect(2, 2, w - 4, h - 4);
    const pad = Math.round(h * 0.09);
    const row1 = Math.round(h * 0.46);
    // 아이콘 칸 (오른쪽 위)
    const s = Math.round(h * 0.36);
    const ix = w - pad - s;
    drawIcon(g, icon, ix, pad + 2, s, hot ? accent : '#30383d');
    // ID 태그
    g.textBaseline = 'middle';
    g.font = `700 ${Math.round(h * 0.25)}px ${MONO}`;
    const idW = g.measureText(id).width + pad * 1.6;
    g.fillStyle = accent; g.fillRect(pad, pad, idW, row1 - pad);
    g.fillStyle = '#ffffff'; g.fillText(id, pad + pad * 0.8, pad + (row1 - pad) / 2 + 1);
    let x = pad + idW + pad * 0.8;
    // 재조사 같은 예외 흐름 배지
    if (badge) {
      g.font = `700 ${Math.round(h * 0.2)}px ${MONO}`;
      const bw = g.measureText(badge).width + pad;
      g.strokeStyle = '#c16c45'; g.lineWidth = 4; g.strokeRect(x, pad + 4, bw, row1 - pad - 8);
      g.fillStyle = '#c16c45'; g.fillText(badge, x + pad / 2, pad + (row1 - pad) / 2 + 1);
      x += bw + pad * 0.7;
    }
    // 이름
    g.fillStyle = '#30383d'; g.font = `800 ${Math.round(h * 0.27)}px ${FONT}`;
    g.fillText(clip(g, title, ix - x - pad), x, pad + (row1 - pad) / 2 + 2);
    // 아랫줄: 단계 점 + 상태
    const y2 = row1 + (h - row1 - 12) / 2;
    const dot = Math.round(h * 0.13);
    g.fillStyle = STAGE_COLOR[stage] ?? STAGE_COLOR.idle; g.fillRect(pad, y2 - dot / 2, dot, dot);
    g.fillStyle = stage === 'alert' ? '#c16c45' : 'rgba(48,56,61,0.88)'; g.font = `600 ${Math.round(h * 0.22)}px ${FONT}`;
    g.fillText(clip(g, status, w - pad * 3 - dot - 50), pad + dot + pad * 0.7, y2 + 1);
    // 상태 막대 + 아주 작은 CMYK 식별 마커
    g.fillStyle = hot ? accent : 'rgba(48,56,61,0.3)'; g.fillRect(4, h - 9, w - 8, 5);
    ['#00bceb', '#e83e91', '#f2d600', '#343434'].forEach((c, k) => { g.fillStyle = c; g.fillRect(w - 12 - (4 - k) * 8, h - 22, 6, 6); });
  };
}

const SIGNS = new Set();
class Sign {
  constructor(w, h, px = 960) {
    this.w = w; this.h = h; this.px = px; this.key = '';
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false }));
    this.mesh.renderOrder = 2;
    SIGNS.add(this);
  }
  set(spec) {
    const key = JSON.stringify(spec);
    if (key === this.key) return;
    this.key = key; this.spec = spec;
    this.mesh.material.map?.dispose();
    this.mesh.material.map = canvasTexture(drawSign(spec), this.px, Math.round(this.px * this.h / this.w));
    this.mesh.material.needsUpdate = true;
  }
  redraw() { if (this.spec) { this.key = ''; this.set(this.spec); } }
}

function floorDecal(text, size, opacity = 0.18, tint = false) {
  const tex = canvasTexture((g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = `rgba(231,233,231,${opacity})`;
    g.font = `700 ${Math.round(h * 0.72)}px ${MONO}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + h * 0.04);
  }, 256, 256);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

// ── 움직임: 목표가 바뀌면 들어 올려 옮기는 경로를 만들고, 건너뛰기면 바로 놓는다 ──
function setTarget(obj, target, { snap, path = null, lift = 1.6, dur = 0.9 }) {
  const m = obj.userData.mover ??= { path: null, p: 1, dur, target: obj.position.clone() };
  if (m.target.distanceTo(target) < 1e-3 && !snap) return;
  m.target = target.clone();
  if (snap) { obj.position.copy(target); m.path = null; m.p = 1; return; }
  const from = obj.position.clone();
  m.path = path ? [from, ...path, target.clone()] : [from, v3(from.x, Math.max(from.y, target.y) + lift, from.z), v3(target.x, Math.max(from.y, target.y) + lift, target.z), target.clone()];
  m.p = 0; m.dur = dur;
}

function stepMover(obj, dt, speed) {
  const m = obj.userData.mover;
  if (!m?.path) return;
  m.p = Math.min(1, m.p + (dt * speed) / m.dur);
  const e = m.p < 0.5 ? 2 * m.p * m.p : 1 - (-2 * m.p + 2) ** 2 / 2;
  const segs = [];
  let total = 0;
  for (let i = 1; i < m.path.length; i++) { const l = m.path[i].distanceTo(m.path[i - 1]); segs.push(l); total += l; }
  let dist = e * total;
  for (let i = 0; i < segs.length; i++) {
    if (dist <= segs[i] || i === segs.length - 1) { obj.position.lerpVectors(m.path[i], m.path[i + 1], segs[i] ? Math.min(1, dist / segs[i]) : 1); break; }
    dist -= segs[i];
  }
  if (m.p >= 1) m.path = null;
}

export class Factory {
  constructor(container, { onHover, onPick } = {}) {
    this.container = container;
    this.onHover = onHover;
    this.onPick = onPick;
    this.speed = 1;
    this.quality = 'high';
    this.t = 0;
    this.tips = {};
    this.tipMeshes = [];
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(C.bg);
    this.scene.fog = new THREE.Fog(C.bg, 120, 210);
    this.frustum = 42;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);
    this.camera.position.set(19.5, 50, 52);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(-2.2, 1.5, -2.6);
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = 0.45;
    this.controls.maxPolarAngle = 1.2;
    this.controls.minZoom = 0.6;
    this.controls.maxZoom = 3;
    this.controls.screenSpacePanning = true;

    this.beltTextures = [];
    this.gateLamps = [];
    this._lights();
    this._static();
    this.dynamic = new THREE.Group();
    this.scene.add(this.dynamic);
    this.rack = { key: '', group: new THREE.Group(), crates: {}, slots: {} }; this.rack.group.name = 'WH-00 rack';
    this.scene.add(this.rack.group);
    this.bays = { n: 0, group: new THREE.Group(), list: [] };
    this.scene.add(this.bays.group);
    this.cables = [];
    this.cableGroup = new THREE.Group();
    this.scene.add(this.cableGroup);
    this.carriers = new Map();
    this.orders = [];
    this.drafts = new Map();
    this.report = null;
    this._buildMarker();
    this.robots = new Robots(this, LAYOUT, 8); // 구역마다 RU·DC 한 쌍 (구역 A 한 쌍으로 이벤트 연동을 확인한 뒤 확장)

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(9, 9);
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (ev) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      this.pointerPx = { x: ev.clientX, y: ev.clientY };
    });
    el.addEventListener('pointerleave', () => { this.pointer.set(9, 9); this.onHover?.(null); });
    el.addEventListener('pointerdown', (ev) => { this._down = { x: ev.clientX, y: ev.clientY }; });
    el.addEventListener('pointerup', (ev) => {
      if (!this._down || Math.hypot(ev.clientX - this._down.x, ev.clientY - this._down.y) > 4) return;
      const hit = this._hit();
      if (hit?.object.userData.doc) this.onPick?.({ doc: hit.object.userData.doc });
      else if (hit?.object.userData.unit) this.onPick?.({ unit: hit.object.userData.unit });
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  setInsets(insets) { this.insets = insets; this.resize(); }
  refreshSigns() { for (const s of SIGNS) s.redraw(); }

  setQuality(q) {
    this.quality = q;
    this.renderer.shadowMap.enabled = q === 'high';
    this.renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio, 2) : 1);
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    const a = w / h;
    Object.assign(this.camera, { left: (-this.frustum * a) / 2, right: (this.frustum * a) / 2, top: this.frustum / 2, bottom: -this.frustum / 2 });
    // 좌우 패널 사이 빈 공간의 가운데에 공장이 오도록 화면 중심을 옮긴다
    const o = this.insets ?? { left: 0, right: 0, top: 0, bottom: 0 };
    this.camera.setViewOffset(w, h, (o.right - o.left) / 2, (o.bottom - o.top) / 2, w, h);
    this.camera.updateProjectionMatrix();
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xe9eef0, 0x262c30, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(30, 60, 24);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -55, right: 55, top: 45, bottom: -45, near: 1, far: 160 });
    key.shadow.bias = -0.0004;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd6ec, 0.55);
    rim.position.set(-40, 26, -40);
    this.scene.add(rim);
  }

  _tip(mesh, fn, unit = null) { mesh.userData.tip = fn; if (unit) mesh.userData.unit = unit; this.tipMeshes.push(mesh); }

  _static() {
    const s = this.scene;
    // 바닥: 짙은 콘크리트 판, 줄눈, 통로 표시
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(140, 100), mat(C.floor, { roughness: 0.92, metalness: 0.08 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; s.add(floor);
    const grid = new THREE.GridHelper(140, 35, 0x434c52, 0x3d464c); grid.position.y = 0.01; s.add(grid);
    // 예전 배치의 바닥 줄(z -5.8, -11.3)은 따라 다니는 것이 없어 없앴다. 장비 레인은 robots.js 가 칠한다
    // 실내 외벽: 건메탈 패널 벽 + 기둥 + 천장 트러스 (건물 외피 — 설비 관통 검사에서 뺀다)
    const addShell = (m) => { m.userData.shell = true; s.add(m); };
    const wallM = mat(C.concrete, { roughness: 0.85, metalness: 0.2 });
    // 뒷벽·트러스는 왼쪽 벽 바깥면(x -38.5)에서, 왼쪽 벽은 뒷벽 바깥면(z -30.5)에서 끝낸다(모서리 밖으로 삐져나오지 않게)
    const wall = box(103.5, 11, 1, wallM); wall.position.set(13.25, 5.5, -30); addShell(wall);
    const wall2 = box(1, 11, 67.5, wallM); wall2.position.set(-38, 5.5, 3.25); addShell(wall2);
    for (let x = -34; x <= 40; x += 9.25) {
      const p = box(1.1, 16, 1.1, mat(C.gunmetal)); p.position.set(x, 8, -29.2); addShell(p);
      const band = box(0.9, 0.18, 0.2, mat(C.alu, { metalness: 0.8, roughness: 0.3 })); band.position.set(x, 9.5, -28.55); addShell(band);
    }
    for (let z = -26; z <= 26; z += 9.25) { const p = box(1.1, 16, 1.1, mat(C.gunmetal)); p.position.set(-37.2, 8, z); addShell(p); }
    const truss = box(103.5, 0.7, 0.7, mat(C.gunmetal)); truss.position.set(13.25, 15.5, -29); addShell(truss);
    // 뒷벽을 따라 반복되는 모듈형 보조 설비(배경)
    const modM = mat(0x9aa4a8, { roughness: 0.42, metalness: 0.65 });
    for (let i = 0; i < 18; i++) {
      const x = 2 + (i % 9) * 3.3 + (i >= 9 ? 1.65 : 0);
      const g = new THREE.Group(); g.position.set(x, 0, i >= 9 ? -21.6 : -25.5); g.userData.shell = true;
      const body = box(2.4, 3.4, 2.2, modM); body.position.y = 1.7; g.add(body);
      const cap = cyl(0.9, 0.5, mat(C.steel), 16); cap.position.y = 3.65; g.add(cap);
      const strip = box(2.42, 0.14, 2.22, mat(C.graphite, { metalness: 0.5 })); strip.position.y = 2.6; g.add(strip);
      s.add(g);
    }

    // 컨베이어 무늬. 투입 라인(창고 → 본선 → 구역 분기)은 구역 수에 맞춰 _buildBays 에서 만든다
    this.beltTex = canvasTexture((g, w, h) => { g.fillStyle = '#262c30'; g.fillRect(0, 0, w, h); g.fillStyle = '#353d42'; for (let i = 0; i < w; i += 32) g.fillRect(i, 0, 14, h); }, 256, 32);
    this.beltTex.wrapS = this.beltTex.wrapT = THREE.RepeatWrapping;

    // WH-00 창고 바닥판과 표지판
    const whPad = box(5.5, 0.12, 22, mat(C.plate, { roughness: 0.8 })); whPad.position.set(LAYOUT.rackX, 0.06, 0); whPad.userData.pad = true; whPad.name = 'WH-00 pad'; s.add(whPad);
    const whDecal = floorDecal('WH', 4.2, 0.18); whDecal.position.set(LAYOUT.rackX + 3.6, 0.03, 9); s.add(whDecal);
    this.rackSign = new Sign(7.2, 1.9); this.rackSign.mesh.position.set(LAYOUT.rackX + 2.6, 13.4, -3.5); s.add(this.rackSign.mesh);

    // CT-01 관제탑 (① 기획 · ② 배치)
    const T = LAYOUT.tower;
    this.tower = new THREE.Group(); this.tower.name = 'CT-01'; this.tower.position.copy(T); s.add(this.tower);
    const base = box(6.4, 1.2, 6.4, mat(C.concrete, { roughness: 0.85 })); base.position.y = 0.6; this.tower.add(base);
    const shaft = cyl(1.4, 10, mat(C.gunmetal, { metalness: 0.65, roughness: 0.38 })); shaft.position.y = 6; this.tower.add(shaft);
    for (let i = 0; i < 4; i++) { const brace = box(0.24, 10.5, 0.24, mat(C.steel)); brace.position.set(i < 2 ? -2.1 : 2.1, 6, i % 2 ? -2.1 : 2.1); this.tower.add(brace); }
    for (const y of [3.5, 7]) { const ring = box(4.6, 0.18, 4.6, mat(C.steel)); ring.position.y = y; this.tower.add(ring); }
    const cab = box(6.2, 2.7, 6.2, mat(C.dark, { metalness: 0.5 })); cab.position.y = 12.35; this.tower.add(cab);
    this.towerBand = box(6.3, 0.55, 6.3, glow(C.blue, 0.12)); this.towerBand.position.y = 12.65; this.tower.add(this.towerBand);
    const roof = box(6.8, 0.4, 6.8, mat(C.gunmetal)); roof.position.y = 13.9; this.tower.add(roof);
    const mast = cyl(0.08, 4, mat(C.steel), 8); mast.position.set(2, 16, 2); this.tower.add(mast);
    this.towerBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), new THREE.MeshBasicMaterial({ color: C.idleLamp })); this.towerBeacon.position.set(2, 18.1, 2); this.tower.add(this.towerBeacon);
    this.towerSign = new Sign(7.2, 1.9); this.towerSign.mesh.position.set(-5.2, 13.2, 3.4); this.tower.add(this.towerSign.mesh);
    for (const m of [base, cab, shaft]) this._tip(m, () => this.tips.tower?.(), 'CT-01');

    // QG-04 품질 검사 게이트 (④ 점검)
    const G = LAYOUT.gate;
    this.gate = new THREE.Group(); this.gate.name = 'QG-04'; this.gate.position.copy(G); s.add(this.gate);
    for (const x of [-4.4, 4.4]) {
      const post = box(1.1, 6.2, 1.5, mat(C.gunmetal, { metalness: 0.6 })); post.position.set(x, 3.1, 0); this.gate.add(post);
      const lamp = box(0.3, 4.6, 0.12, glow(C.blue, 0.08)); lamp.position.set(x + (x < 0 ? 0.56 : -0.56), 3.1, 0.76); this.gate.add(lamp);
      this.gateLamps.push(lamp);
    }
    const beam = box(9.9, 1.15, 1.7, mat(C.dark)); beam.position.y = 6.6; this.gate.add(beam);
    this.gateBar = box(8.4, 0.16, 0.24, glow(C.blue, 0.08)); this.gateBar.position.set(0, 5.8, 0.86); this.gate.add(this.gateBar);
    // 바닥판은 기둥 뒤로 0.3 만 남긴다(예전엔 1.8 뒤까지 나와 게이트 뒤 장비 레인과 겹쳤다)
    const gplate = box(10.4, 0.14, 2.85, mat(C.plate)); gplate.position.set(0, 0.07, 0.375); gplate.userData.pad = true; this.gate.add(gplate);
    const gDecal = floorDecal('04', 2.6, 0.2); gDecal.position.set(-3.6, 0.15, 2.4); this.gate.add(gDecal);
    this.gateSign = new Sign(7.2, 1.9); this.gateSign.mesh.position.set(0, 7.9, 2.2); this.gate.add(this.gateSign.mesh);
    for (const m of [beam, gplate]) this._tip(m, () => this.tips.gate?.(), 'QG-04');

    // SY-05 종합 설비 (⑤ 종합)
    const S = LAYOUT.syn;
    this.syn = new THREE.Group(); this.syn.name = 'SY-05'; this.syn.position.copy(S); s.add(this.syn);
    // 원형 받침: 네모 받침(9.2×9.2)은 RS-D 바닥판·칸막이와 겹쳐 있었다. 원통 설비에 맞춘 원형으로 줄여 겹침을 없앤다
    const pad = cyl(4.3, 0.4, mat(C.concrete, { roughness: 0.85 }), 48); pad.position.y = 0.2; pad.userData.pad = true; this.syn.add(pad);
    const shell = mat(0xc9d0d2, { metalness: 0.72, roughness: 0.26 });
    const vessel = cyl(3, 7, shell, 40); vessel.position.y = 4; this.syn.add(vessel);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(3, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), shell); dome.position.y = 7.5; dome.castShadow = true; this.syn.add(dome);
    const skirt = cyl(3.3, 1.2, mat(C.gunmetal), 40); skirt.position.y = 1; this.syn.add(skirt);
    for (const y of [2.2, 5.6]) { const rib = new THREE.Mesh(new THREE.TorusGeometry(3.04, 0.13, 8, 48), mat(C.graphite, { metalness: 0.7, roughness: 0.35 })); rib.rotation.x = Math.PI / 2; rib.position.y = y; this.syn.add(rib); }
    this.synRing = new THREE.Mesh(new THREE.TorusGeometry(3.08, 0.2, 8, 56), glow(C.blue, 0.08)); this.synRing.rotation.x = Math.PI / 2; this.synRing.position.y = 3.9; this.syn.add(this.synRing);
    const hatch = box(1.6, 2.2, 0.3, mat(C.dark)); hatch.position.set(-1.2, 2.6, 2.95); this.syn.add(hatch);
    const sDecal = floorDecal('05', 2.6, 0.2); sDecal.position.set(1.2, 0.03, 5.6); this.syn.add(sDecal); // 원형 받침 바깥 바닥
    this.synSign = new Sign(7.2, 1.9); this.synSign.mesh.position.set(3.2, 10.6, 3.4); this.syn.add(this.synSign.mesh);
    for (const m of [vessel, pad, skirt]) this._tip(m, () => this.tips.syn?.(), 'SY-05');

    // MS-06 계측 스테이션 (⑥ 평가)
    const M = LAYOUT.station;
    this.station = new THREE.Group(); this.station.name = 'MS-06'; this.station.position.copy(M); s.add(this.station);
    const desk = box(8.2, 1.4, 3.2, mat(C.dark)); desk.position.y = 0.7; this.station.add(desk);
    const frame = box(8.2, 4.6, 0.4, mat(C.gunmetal)); frame.position.set(0, 3.7, -1.4); this.station.add(frame);
    this.stationBars = [];
    for (let i = 0; i < 5; i++) {
      const slot = box(1, 3.4, 0.2, mat(C.graphite)); slot.position.set(-3 + i * 1.5, 3.7, -1.15); this.station.add(slot);
      const bar = box(0.8, 1, 0.24, glow(C.cyan, 0.6)); bar.position.set(-3 + i * 1.5, 2, -1.05); bar.scale.y = 0.001; this.station.add(bar);
      this.stationBars.push(bar);
    }
    this.stationLamp = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), new THREE.MeshBasicMaterial({ color: C.idleLamp })); this.stationLamp.position.set(3.7, 6.3, -1.4); // 프레임 윗면(6.0)에 앉힌다 this.station.add(this.stationLamp);
    const mDecal = floorDecal('06', 2.6, 0.2); mDecal.position.set(-3, 0.03, 2.8); this.station.add(mDecal);
    this.stationSign = new Sign(7.2, 1.9); this.stationSign.mesh.position.set(0, 9, 0); this.station.add(this.stationSign.mesh);
    for (const m of [desk, frame]) this._tip(m, () => this.tips.station?.(), 'MS-06');
  }

  // 컨베이어 한 구간. a→b 방향이 로컬 +x, 왼쪽(+z) 레일은 gaps 구간을 비워 분기 입구를 낸다(로컬 x 범위).
  // 다리는 양 끝에서 안쪽으로 들여 고르게 놓아, 끝에 맞닿는 설비(호퍼·랙)와 겹치지 않게 한다.
  _belt(a, b, width = 1.5, { name = 'belt', gaps = [] } = {}) {
    const g = new THREE.Group(); g.name = name;
    const len = a.distanceTo(b);
    const dir = b.clone().sub(a);
    const angle = Math.atan2(dir.z, dir.x);
    const tex = this.beltTex.clone(); tex.needsUpdate = true; tex.repeat.set(len / 2.5, 1);
    const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, width), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.1 }));
    top.position.y = 0.72; top.receiveShadow = true; top.userData.beltTop = true; g.add(top);
    g.userData.textures = [tex];
    this.beltTextures.push(tex);
    const railM = mat(C.steel, { metalness: 0.7 });
    for (const side of [-1, 1]) {
      // 레일을 구멍(gaps) 기준으로 나눈다
      const cuts = side === 1 ? [...gaps].sort((p, q) => p[0] - q[0]) : [];
      let from = -len / 2;
      for (const [g0, g1] of [...cuts, [len / 2, len / 2]]) {
        if (g0 - from > 0.05) { const rail = box(g0 - from, 0.22, 0.14, railM); rail.position.set((from + g0) / 2, 0.8, side * (width / 2 + 0.07)); g.add(rail); }
        from = g1;
      }
    }
    const inset = 0.6, n = Math.max(2, Math.ceil((len - 2 * inset) / 3) + 1);
    for (let k = 0; k < n; k++) {
      const x = -len / 2 + inset + ((len - 2 * inset) * k) / (n - 1);
      if (gaps.some(([g0, g1]) => x > g0 - 0.15 && x < g1 + 0.15)) continue; // 분기 입구 아래는 비운다
      const leg = box(0.16, 0.66, width, mat(C.gunmetal)); leg.position.set(x, 0.33, 0); g.add(leg);
    }
    g.position.copy(a.clone().add(b).multiplyScalar(0.5));
    g.rotation.y = -angle;
    return g;
  }

  // 투입 라인: WH-00 랙 앞 → 본선(창고 쪽에서 구역 쪽으로) → 구역마다 분기(밀어내기 장치 + 레일 입구) → 구역 호퍼.
  // 같은 높이에서 벨트 윗면이 포개지지 않도록, 분기 벨트는 본선 레일 바깥면에서 시작한다.
  _buildIntakeLine(xs) {
    this.line?.forEach((o) => { this.scene.remove(o); o.userData.textures?.forEach((t) => { t.dispose(); this.beltTextures = this.beltTextures.filter((x) => x !== t); }); });
    this.line = [];
    const W = 1.5, SW = 1.2, rail = 0.14;
    const z = LAYOUT.beltZ;
    const x0 = LAYOUT.rackX + 1.4;            // 랙 앞면(선반 끝 -15.35)에 맞닿는 반출구
    const x1 = xs.at(-1) + SW / 2 + 0.75;     // 마지막 분기 바로 뒤에서 끝낸다(계측 스테이션과 겹치지 않게)
    const mid = (x0 + x1) / 2;
    const gaps = xs.map((x) => [x - mid - SW / 2 - rail, x - mid + SW / 2 + rail]);
    const main = this._belt(v3(x0, 0, z), v3(x1, 0, z), W, { name: 'belt:main', gaps });
    this.scene.add(main); this.line.push(main);
    const steelM = mat(C.steel, { metalness: 0.7 }), darkM = mat(C.gunmetal);
    // 끝막이
    const stop = box(0.14, 0.42, W + 2 * rail, steelM); stop.position.set(x1 + 0.07, 0.83, z); stop.name = 'belt:main-stop';
    this.scene.add(stop); this.line.push(stop);
    xs.forEach((x, i) => {
      const zs = z + W / 2 + 0.01;              // 본선 벨트 가장자리(레일을 비운 입구)에서 이어 붙인다 — 윗면이 포개지지 않는다
      const spur = this._belt(v3(x, 0, zs), v3(x, 0, LAYOUT.hopperZ), SW, { name: `belt:spur-${LETTERS[i] ?? i}` });
      this.scene.add(spur); this.line.push(spur);
      // 분기 표시: 본선 반대편 레일 바깥의 밀어내기 장치(하우징 · 막대 · 밀판)
      const pusher = new THREE.Group(); pusher.name = `belt:diverter-${LETTERS[i] ?? i}`;
      const housing = box(0.9, 0.36, 0.28, darkM); housing.position.set(0, 0.86, -(W / 2 + rail + 0.14)); pusher.add(housing);
      const rod = box(0.08, 0.08, 0.2, steelM); rod.position.set(0, 0.95, -(W / 2 + 0.1)); pusher.add(rod);
      const plate = box(0.8, 0.2, 0.06, steelM); plate.position.set(0, 0.9, -(W / 2 - 0.03)); pusher.add(plate);
      pusher.position.set(x, 0, z);
      this.scene.add(pusher); this.line.push(pusher);
    });
  }

  // ── 케이블 연결망: 철탑 위를 지나는 처진 케이블. 실제로 데이터가 오가는 동안만 빛과 신호가 흐른다 ──
  _pylon(p, h) {
    const g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.name = `pylon(${p.x.toFixed(1)},${p.z.toFixed(1)})`;
    const pole = cyl(0.12, h, mat(C.steel, { metalness: 0.7 }), 8); pole.position.y = h / 2; g.add(pole);
    const arm = box(1.1, 0.1, 0.1, mat(C.steel)); arm.position.y = h - 0.15; g.add(arm);
    const insulator = cyl(0.14, 0.3, mat(C.ti, { metalness: 0.2, roughness: 0.4 }), 8); insulator.position.y = h + 0.05; g.add(insulator);
    this.cableGroup.add(g);
    return v3(p.x, h + 0.15, p.z);
  }

  _cable(key, a, b, sag = 1.6) {
    const mid = a.clone().add(b).multiplyScalar(0.5); mid.y = Math.min(a.y, b.y) - sag;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.09, 6, false), glow(C.cyan, 0.0, 0x6b767b));
    m.name = `cable:${key}`; m.userData.cableEnds = [a.clone(), b.clone()]; // 양 끝은 설비에 꽂힌 접점
    this.cableGroup.add(m);
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), new THREE.MeshBasicMaterial({ color: C.cyan, toneMapped: false }));
    bead.visible = false; bead.userData.fx = true; this.cableGroup.add(bead);
    const cable = { key, curve, mesh: m, bead, state: 'idle', phase: Math.random() };
    this.cables.push(cable);
    return cable;
  }

  _buildCables() {
    this.cableGroup.clear();
    this.cables = [];
    // 관제탑 케이블은 지붕 위가 아니라 관제실 벽면(대상 쪽)에 붙인다
    const towerAnchor = (to) => { const T = LAYOUT.tower; const d = v3(to.x - T.x, 0, to.z - T.z).normalize(); const k = 3.15 / Math.max(Math.abs(d.x), Math.abs(d.z)); return v3(T.x + d.x * k, 12.2, T.z + d.z * k); }; // 관제실 벽면 위의 점
    // 게이트 케이블은 상부 빔 뒷면(구역 쪽)에 따로따로 붙인다. 예전처럼 빔 위 한 점으로 모으면 케이블끼리 겹치고 처짐이 빔을 뚫었다
    const G = LAYOUT.gate;
    const gateAnchor = (x, y = 6.35) => v3(G.x + x, y, G.z - 0.9); // 빔 뒷면: 구역 케이블은 아랫단, 관제탑·종합 케이블은 윗단
    const n = this.bays.list.length;
    const synTop = LAYOUT.syn.clone().add(v3(-2.2, 9.5, -1.5));
    const stTop = this._pylon(LAYOUT.station.clone().add(v3(-4.6, 0, -1.4)), 7.5);
    for (const bay of this.bays.list) {
      // 철탑은 구역 바닥판 모서리 바깥에 세운다(예전 z ±3.9 는 바닥판 테두리를 0.02 파고들었다)
      const top = this._pylon(v3(bay.x - 2.6, 0, -4.05), 7.2);
      bay.cableIn = this._cable(`ct-${bay.i}`, towerAnchor(top), top, 2.2);
      const down = this._pylon(v3(bay.x + 2.6, 0, 4.05), 7.0);
      bay.cableOut = this._cable(`qg-${bay.i}`, down, gateAnchor((bay.i - (n - 1) / 2) * 1.6), 0.9);
    }
    const whTop = this._pylon(v3(LAYOUT.rackX + 2.2, 0, -10.6), 12.4);
    this.cardCable = this._cable('wh-ct', whTop, towerAnchor(whTop), 1.6);
    const loopA = gateAnchor(-3.9, 6.9);
    this.loopCable = this._cable('qg-ct', loopA, towerAnchor(loopA).add(v3(0.6, -0.6, 0)), 1.0);
    this.synCable = this._cable('qg-sy', gateAnchor(3.9, 6.9), synTop, 1.6);
    this.stCable = this._cable('sy-ms', synTop, stTop, 1.8);
  }

  // ── 창고 랙: 코퍼스 문서마다 화물 하나. 화물 높이 = 글자 수 ──
  _buildRack(docs) {
    const key = docs.map((d) => d.제목).join('|');
    if (key === this.rack.key) return;
    this.rack.key = key;
    const grp = this.rack.group;
    grp.clear();
    this.rack.crates = {}; this.rack.slots = {};
    this.tipMeshes = this.tipMeshes.filter((m) => !m.userData.rack);
    const n = docs.length;
    const L = LAYOUT.rackLevels;
    const per = Math.max(1, Math.ceil(n / L));
    const span = LAYOUT.rackZ1 - LAYOUT.rackZ0;
    const pitch = span / per;
    const maxChars = Math.max(...docs.map((d) => d.글자수), 1);
    const frameM = mat(C.gunmetal, { metalness: 0.7, roughness: 0.36 });
    for (let l = 0; l <= L; l++) {
      const shelf = box(2.5, 0.14, span + 1, frameM); shelf.position.set(LAYOUT.rackX, l * LAYOUT.levelH, (LAYOUT.rackZ0 + LAYOUT.rackZ1) / 2); grp.add(shelf);
      const lip = box(0.08, 0.18, span + 1, mat(C.ti, { metalness: 0.3 })); lip.position.set(LAYOUT.rackX + 1.27, l * LAYOUT.levelH + 0.08, (LAYOUT.rackZ0 + LAYOUT.rackZ1) / 2); grp.add(lip);
    }
    for (let i = 0; i <= per; i++) for (const dx of [-1.2, 1.2]) {
      const post = box(0.16, L * LAYOUT.levelH + 0.4, 0.16, frameM); post.position.set(LAYOUT.rackX + dx, (L * LAYOUT.levelH) / 2, LAYOUT.rackZ0 + i * pitch); grp.add(post);
    }
    docs.forEach((doc, i) => {
      const level = Math.floor(i / per), slot = i % per;
      const h = 0.3 + 2.1 * Math.sqrt(doc.글자수 / maxChars);
      const d = Math.min(1.7, pitch * 0.82);
      const m = mat(0x9ba5a9, { metalness: 0.45, roughness: 0.45, emissive: new THREE.Color(C.cyan), emissiveIntensity: 0 });
      const crate = box(1.7, h, d, m);
      const pos = v3(LAYOUT.rackX, level * LAYOUT.levelH + 0.07 + h / 2, LAYOUT.rackZ0 + (slot + 0.5) * pitch);
      crate.position.copy(pos);
      crate.userData = { rack: true, doc: doc.제목, h, d };
      this._tip(crate, () => this.tips.doc?.(doc.제목));
      grp.add(crate);
      this.rack.crates[doc.제목] = crate;
      this.rack.slots[doc.제목] = pos;
    });
  }

  _buildMarker() {
    this.marker = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 9, 8), new THREE.MeshBasicMaterial({ color: C.blue, transparent: true, opacity: 0.85, toneMapped: false }));
    beam.position.y = 4.5; this.marker.add(beam);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.07, 6, 32), new THREE.MeshBasicMaterial({ color: C.blue, toneMapped: false }));
    ring.rotation.x = Math.PI / 2; this.marker.add(ring);
    this.marker.visible = false;
    this.scene.add(this.marker);
  }

  highlightDoc(title) {
    const crate = title ? this.rack.crates[title] : null;
    this.marker.visible = !!crate;
    if (crate) this.marker.position.set(crate.position.x, crate.position.y + crate.userData.h / 2 + 0.1, crate.position.z);
  }

  // ── 연구 구역 RS-A~ ──
  _buildBays(n) {
    if (n === this.bays.n) return;
    this.bays.n = n;
    this.bays.group.clear();
    this.bays.list = [];
    this.tipMeshes = this.tipMeshes.filter((m) => !m.userData.bay);
    const shellM = mat(0xcdd3d5, { metalness: 0.68, roughness: 0.28 });
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * LAYOUT.baySpacing;
      const g = new THREE.Group(); g.position.set(x, 0, 0); g.name = `RS-${LETTERS[i] ?? i}`;
      const base = box(5.3, 0.24, 7.6, mat(C.plate, { roughness: 0.8 })); base.position.y = 0.12; base.userData.pad = true; g.add(base);
      // 바닥 둘레 띠: 작동 중일 때 Teal 로 켜진다
      const rimM = glow(C.blue, 0.0, 0x5a646a);
      for (const [w, d, px, pz] of [[5.3, 0.1, 0, -3.78], [5.3, 0.1, 0, 3.78], [0.1, 7.6, -2.63, 0], [0.1, 7.6, 2.63, 0]]) { const rim = box(w, 0.05, d, rimM); rim.position.set(px, 0.26, pz); g.add(rim); }
      const decal = floorDecal(LETTERS[i] ?? String(i), 3.2, 0.16); decal.position.set(-1.1, 0.25, 2.3); g.add(decal);
      // 프레임
      for (const [px, pz] of [[-2.45, -3.5], [2.45, -3.5], [-2.45, 3.5], [2.45, 3.5]]) { const post = box(0.2, 5, 0.2, mat(C.steel, { metalness: 0.7 })); post.position.set(px, 2.6, pz); g.add(post); }
      for (const pz of [-3.5, 3.5]) { const beam = box(5.1, 0.22, 0.22, mat(C.steel, { metalness: 0.7 })); beam.position.set(0, 5.1, pz); g.add(beam); }
      for (const px of [-2.45, 2.45]) { const beam = box(0.22, 0.22, 7.2, mat(C.steel, { metalness: 0.7 })); beam.position.set(px, 5.1, 0); g.add(beam); }
      // 모듈형 처리 설비: 받침 → 원통 드럼 → 상부 캡, 둘레에 상태 링
      const plinth = box(2.8, 0.5, 2.8, mat(C.gunmetal)); plinth.position.set(0, 0.5, -0.4); g.add(plinth);
      const drum = cyl(1.15, 2.2, shellM, 32); drum.position.set(0, 1.85, -0.4); g.add(drum);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(1.18, 1.18, 0.34, 32, 1, true), glow(C.blue, 0.05)); band.position.set(0, 2.15, -0.4); g.add(band);
      const capTop = cyl(0.8, 0.5, mat(C.gunmetal), 24, 1.1); capTop.position.set(0, 3.2, -0.4); g.add(capTop);
      const vent = cyl(0.22, 0.9, mat(C.dark), 12); vent.position.set(0.4, 3.85, -0.6); g.add(vent);
      const cabinet = box(0.9, 2.3, 1.2, mat(C.dark)); cabinet.position.set(-1.9, 1.4, -1.9); g.add(cabinet);
      const cabLight = box(0.05, 1.2, 0.6, glow(C.blue, 0.06)); cabLight.position.set(-1.42, 1.6, -1.9); g.add(cabLight);
      const hopper = box(1.6, 0.9, 1.1, mat(C.dark)); hopper.position.set(0, 1.0, -2.75); g.add(hopper);
      const tray = box(1.9, 0.3, 1.3, mat(C.dark)); tray.position.set(0, 0.42, 2.75); g.add(tray);
      // 창 게이지: 유리 기둥 + Ice Steel Blue 채움 (읽은 원문이 창에서 차지하는 몫)
      const glass = cyl(0.4, 4.2, new THREE.MeshStandardMaterial({ color: 0x8fb4bf, transparent: true, opacity: 0.16, roughness: 0.1, metalness: 0.1, depthWrite: false }), 20); glass.position.set(-1.95, 2.4, 1.1); glass.castShadow = false; g.add(glass);
      const fill = cyl(0.32, 4.0, glow(C.cyan, 0.65), 20); fill.position.set(-1.95, 0.4, 1.1); fill.scale.y = 0.001; g.add(fill);
      for (const y of [0.3, 4.5]) { const cap = cyl(0.46, 0.18, mat(C.steel), 20); cap.position.set(-1.95, y, 1.1); g.add(cap); }
      // 읽은 문서 적재대: 윗면 높이(1.05)는 그대로, 바닥판(0.24)까지 내려와 떠 있지 않게
      const shelf = box(0.9, 0.81, 3.0, mat(C.steel)); shelf.position.set(1.95, 0.645, 1.1); g.add(shelf);
      const sign = new Sign(6.0, 1.6); sign.mesh.position.set(0, i % 2 ? 8.4 : 6.6, 0.6); g.add(sign.mesh);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), new THREE.MeshBasicMaterial({ color: C.idleLamp })); lamp.position.set(2.45, 5.45, 3.5); g.add(lamp);
      const bay = { i, x, g, band, rimM, cabLight, fill, sign, lamp, minis: [] };
      for (const m of [base, drum, plinth, hopper, tray, cabinet]) { m.userData.bay = true; this._tip(m, () => this.tips.bay?.(i), `RS-${LETTERS[i] ?? i}`); }
      this.bays.group.add(g);
      this.bays.list.push(bay);
    }
    // 컨베이어: 실제 문서가 들어오는 투입 라인만 둔다(창고 → 본선 → 구역 호퍼).
    // 예전의 구역→게이트 배출 벨트와 게이트→종합 벨트는 양 끝이 어느 설비에도 닿지 않았고(게이트 앞 바닥에서 끝나거나 기둥을 향함),
    // 원고 운반·반송은 DC 가 맡으므로 없앴다.
    const xs = this.bays.list.map((b) => b.x);
    this._buildIntakeLine(xs);
    // 구역 사이 칸막이(유리 패널 + 금속 레일)와 구역 바깥 경계 — 칸막이 하나가 설비 하나
    const edges = [xs[0] - LAYOUT.baySpacing / 2, ...xs.slice(1).map((x, k) => (x + xs[k]) / 2), xs.at(-1) + LAYOUT.baySpacing / 2];
    const glass = new THREE.MeshStandardMaterial({ color: 0xbfd0d8, transparent: true, opacity: 0.22, roughness: 0.1, metalness: 0.2, depthWrite: false });
    edges.forEach((ex, k) => {
      const d = new THREE.Group(); d.name = `divider-${k}`;
      const panel = box(0.08, 1.5, 6.6, glass); panel.castShadow = false; panel.position.set(ex, 0.95, 0); d.add(panel);
      const rail = box(0.14, 0.12, 6.8, mat(C.alu, { metalness: 0.8, roughness: 0.28 })); rail.position.set(ex, 1.72, 0); d.add(rail);
      for (const pz of [-3.3, 0, 3.3]) { const post = box(0.16, 1.7, 0.16, mat(C.graphite)); post.position.set(ex, 0.85, pz); d.add(post); }
      this.bays.group.add(d);
    });
    // 바닥 경로: 창고 → 구역(문서) 을 칠한 선으로 (투입 분기 벨트 옆). 장비 레인은 robots.js 가 칠한다
    const path = (ax, az, bx, bz, color, width = 0.22) => {
      const len = Math.hypot(bx - ax, bz - az);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, width), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.rotation.z = -Math.atan2(bz - az, bx - ax);
      m.position.set((ax + bx) / 2, 0.03, (az + bz) / 2); m.renderOrder = -1; this.bays.group.add(m);
    };
    for (const b of this.bays.list) path(b.x - 0.9, LAYOUT.beltZ + 0.9, b.x - 0.9, -3.95, 0x0b7f80);
    // 탐색 빔: 다음 문서를 고르는 동안 구역에서 창고로 뻗는 Cyan 점선
    for (const b of this.bays.list) {
      const geo = new THREE.BufferGeometry().setFromPoints([v3(b.x, 2.4, -3.2), v3(b.x * 0.4 + LAYOUT.rackX * 0.6, 7.5, -6.5), v3(LAYOUT.rackX + 1.4, 5.5, 0)]);
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: C.cyan, dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.9, depthWrite: false }));
      line.computeLineDistances(); line.visible = false; this.bays.group.add(line);
      b.scan = line;
    }
    this._buildCables();
  }

  intake(i) { const b = this.bays.list[i]; return v3(b?.x ?? 0, 1.35, LAYOUT.intakeZ + 0.9); }
  output(i) { const b = this.bays.list[i]; return v3(b?.x ?? 0, 0.95, LAYOUT.outZ); }

  // ── 상태 반영 ──
  update(st, { snap = false, status = null } = {}) {
    this.st = st;
    const docs = st.run?.코퍼스?.문서 ?? status?.corpus?.문서 ?? [];
    this._buildRack(docs);
    const n = st.plan?.목차?.length || st.run?.설정?.max_sections || status?.settings?.max_sections || 4;
    this._buildBays(n);
    const windowTokens = st.run?.창토큰 ?? status?.window_tokens ?? 128000;
    const tokPerChar = st.run?.글자당토큰 ?? (status ? 1 / status.chars_per_token : 0.5);
    const nd = st.nodes;

    // 창고 화물: 읽는 중이면 밝게, 읽힌 문서는 은은하게, 여러 구역이 읽은 문서는 Amber
    for (const [title, crate] of Object.entries(this.rack.crates)) {
      const reads = st.docs[title]?.reads ?? [];
      const done = reads.filter((r) => r.done);
      const sections = new Set(done.map((r) => r.section));
      crate.material.emissive.set(sections.size > 1 ? C.orange : C.cyan);
      crate.material.emissiveIntensity = reads.some((r) => !r.done) ? 0.7 : done.length ? 0.22 : 0;
      crate.material.color.set(done.length ? 0xc3cbcd : 0x9ba5a9);
    }

    // 운반 중인 화물(문서 사본): 읽기 호출이 진행 중인 동안만 존재한다
    const live = new Set();
    for (const sec of Object.values(st.sections)) {
      const cur = sec.current;
      if (!cur || cur.step !== 'read' || !cur.doc) continue;
      const key = `c${cur.call}`;
      live.add(key);
      if (this.carriers.has(key) || this.robots.handles(sec.n)) continue;
      const slot = this.rack.slots[cur.doc];
      const src = this.rack.crates[cur.doc];
      const c = box(1.4, Math.min(src?.userData.h ?? 1, 1.6), 1.2, mat(0xd6e6e6, { metalness: 0.3, roughness: 0.45, emissive: new THREE.Color(C.cyan), emissiveIntensity: 0.55 }));
      c.position.copy(slot ?? v3(LAYOUT.exitX, 1, LAYOUT.beltZ));
      c.userData = { doc: cur.doc };
      c.userData.tip = () => this.tips.doc?.(cur.doc);
      this.dynamic.add(c); this.carriers.set(key, c);
      const ex = v3(LAYOUT.exitX, 1.3, slot?.z ?? LAYOUT.beltZ);
      const target = this.intake(sec.n);
      setTarget(c, target, { snap, path: [ex, v3(LAYOUT.exitX, 1.3, LAYOUT.beltZ), v3(target.x, 1.3, LAYOUT.beltZ)], dur: 1.6 });
    }
    for (const [key, c] of this.carriers) if (!live.has(key)) { this.dynamic.remove(c); this.carriers.delete(key); }

    // 연구 구역
    const lastReview = st.reviews.at(-1);
    for (const bay of this.bays.list) {
      const sec = st.sections[bay.i];
      const working = sec?.status === 'working';
      const step = sec?.current?.step;
      const draft = sec?.drafts?.at(-1);
      // ④ 인용 확인(check_citations)에 걸린 원고: 리서처는 '충분'이라 신고했지만 점검이 부족으로 돌려보냈다
      const flagged = !!(draft && lastReview?.인용확인_걸림?.[bay.i] && lastReview.바퀴 === draft.round);
      const short = draft && (draft.충분 === false || flagged);
      bay.working = working; bay.step = step; bay.short = short; bay.filed = !!draft;
      const ratio = sec ? (sec.docChars * tokPerChar) / windowTokens : 0;
      bay.fill.scale.y = Math.max(0.001, Math.min(1, ratio));
      bay.fill.position.y = 0.4 + (4.0 * bay.fill.scale.y) / 2;
      const reads = sec?.reads?.length ?? 0;
      const r2 = (sec?.round ?? 1) > 1;
      const [stage, statusText] = !sec?.dispatched ? ['idle', '배치 대기']
        : working && step === 'pick' ? ['data', '문서 탐색 중']
        : working && step === 'read' ? ['data', `읽는 중 · ${reads + 1}/${sec.예산}`]
        : working && step === 'write' ? ['active', '원고 작성 중']
        : working ? ['active', '작업 중']
        : flagged ? ['alert', '점검 반려 · 인용 확인']
        : short ? ['alert', '부족 신고']
        : draft ? ['done', `원고 제출 · 인용 ${draft.인용}곳`]
        : ['idle', '출발 대기'];
      bay.sign.set({
        id: `RS-${LETTERS[bay.i] ?? bay.i}`, icon: 'rs', badge: r2 ? 'R2' : '',
        title: sec?.절 || '연구 구역',
        status: r2 && working ? `재조사 · ${statusText}` : statusText,
        state: working ? 'active' : short ? 'alert' : draft ? 'done' : 'idle', stage,
      });
      if (bay.scan) bay.scan.visible = working && step === 'pick';
      bay.lamp.material.color.set(working ? C.blue : short ? C.orange : draft ? C.ti : C.idleLamp);
      // 읽은 문서 선반의 작은 화물 (문서 = Cyan)
      const shelf = sec?.reads ?? [];
      while (bay.minis.length < shelf.length) {
        const k = bay.minis.length;
        const m = box(0.7, 0.42, 0.42, mat(0xc3cbcd, { roughness: 0.5, emissive: new THREE.Color(C.cyan), emissiveIntensity: 0.22 }));
        m.position.set(1.95, 1.27 + Math.floor(k / 5) * 0.46, -0.1 + (k % 5) * 0.55);
        const doc = shelf[k].doc;
        m.userData = { doc };
        m.userData.tip = () => this.tips.doc?.(doc);
        this.tipMeshes.push(m);
        bay.g.add(m); bay.minis.push(m);
      }
      while (bay.minis.length > shelf.length) { const m = bay.minis.pop(); bay.g.remove(m); this.tipMeshes = this.tipMeshes.filter((x) => x !== m); }
      // 케이블 상태: 관제탑→구역은 배치·작업 중, 구역→게이트는 원고가 게이트로 갈 때
      if (bay.cableIn) bay.cableIn.state = nd.dispatch.state === 'active' && sec?.dispatched ? 'flow' : working ? 'on' : 'idle';
      const atGate = draft && (st.reviews.some((r) => r.바퀴 === draft.round) || (nd.review.state === 'active' && draft.round === st.round));
      if (bay.cableOut) bay.cableOut.state = nd.review.state === 'active' && draft ? 'flow' : atGate && !st.report ? 'on' : 'idle';
    }
    const redispatch = lastReview?.다음 === 'dispatch' && !st.report && nd.researcher.state !== 'done';
    if (this.loopCable) this.loopCable.state = redispatch ? 'alert' : 'idle';
    if (this.cardCable) this.cardCable.state = nd.plan.state === 'active' ? 'flow' : 'idle';
    if (this.synCable) this.synCable.state = nd.synthesize.state === 'active' ? 'flow' : st.report ? 'on' : 'idle';
    if (this.stCable) this.stCable.state = nd.evaluate.state === 'active' ? 'flow' : st.metrics ? 'on' : 'idle';

    // 작업 지시서: 기획 뒤에는 관제탑에, 배치 뒤에는 각 구역 표지판 아래에
    const toc = st.plan?.목차 ?? [];
    while (this.orders.length < toc.length) {
      const o = box(1.3, 0.06, 0.9, mat(C.ti, { emissive: new THREE.Color(C.blue), emissiveIntensity: 0.3, metalness: 0.1 }));
      o.position.copy(LAYOUT.tower).add(v3(0, 12.3, 0)); o.visible = false;
      this.dynamic.add(o); this.orders.push(o);
    }
    this.orders.forEach((o, i) => {
      if (i >= toc.length) { o.visible = false; return; }
      o.visible = true;
      const sec = st.sections[i];
      const target = sec?.dispatched ? v3(this.bays.list[i]?.x ?? 0, 5.24, 3.5) /* 앞 들보 윗면(5.21)에 얹는다 */ : LAYOUT.tower.clone().add(v3(3.6, 12.6 + i * 0.12, 3.6));
      setTarget(o, target, { snap, lift: 3, dur: 1.2 });
    });

    // 원고 상자(연구 결과): 구역 출력대 → 검사 게이트 → (부족이면 구역으로 반송) → 종합 설비
    const reviewedRounds = new Set(st.reviews.map((r) => r.바퀴));
    const keep = new Set();
    for (const sec of Object.values(st.sections)) {
      sec.drafts.forEach((dr, k) => {
        const key = `d${sec.n}-${k}`;
        const latest = k === sec.drafts.length - 1;
        let pkg = this.drafts.get(key);
        if (!pkg) {
          pkg = box(1.3, 0.7, 1.0, mat(C.ti, { metalness: 0.2, roughness: 0.45, emissive: new THREE.Color(C.cyan), emissiveIntensity: 0.25 }));
          pkg.position.copy(this.output(sec.n));
          pkg.userData.tip = () => this.tips.draft?.(sec.n, k);
          this.dynamic.add(pkg); this.drafts.set(key, pkg);
          this.tipMeshes.push(pkg);
        }
        keep.add(key);
        const gateSlot = v3(LAYOUT.gate.x + (sec.n - (this.bays.n - 1) / 2) * 1.7, 0.6, LAYOUT.gate.z);
        // 반송은 ④ 점검이 실제로 이 절을 다시 배치하기로 정한 경우에만 일어난다
        const returned = lastReview?.다음 === 'dispatch' && lastReview.부족.includes(sec.n) && dr.round === lastReview.바퀴;
        let target = this.output(sec.n);
        pkg.visible = true;
        pkg.material.emissive.set(dr.충분 ? C.cyan : C.orange);
        if (!latest || st.metrics) {
          pkg.visible = false; // 다시 쓴 원고로 바뀌었거나, 이미 보고서로 녹아 들어갔다
        } else if (st.report) {
          target = LAYOUT.syn.clone().add(v3(0, 5, 0)); pkg.visible = false;
        } else if (nd.synthesize.state === 'active') {
          target = LAYOUT.syn.clone().add(v3(-3.8, 1, (sec.n - (this.bays.n - 1) / 2) * 1.3));
        } else if (returned) {
          target = this.intake(sec.n).add(v3(0, 0.9, 0));
        } else if (reviewedRounds.has(dr.round) || (nd.review.state === 'active' && dr.round === st.round)) {
          target = gateSlot;
        }
        if (this.robots.handles(sec.n)) pkg.visible = false;
        setTarget(pkg, target, { snap, lift: 2.2, dur: 1.1 });
      });
    }
    for (const [key, b] of this.drafts) if (!keep.has(key)) { this.dynamic.remove(b); this.drafts.delete(key); this.tipMeshes = this.tipMeshes.filter((x) => x !== b); }

    // 보고서
    if (st.report) {
      if (!this.report) {
        this.report = box(2.2, 1.1, 1.6, mat(C.ti, { emissive: new THREE.Color(C.cyan), emissiveIntensity: 0.45 }));
        this.report.position.copy(LAYOUT.syn).add(v3(0, 1, -4.6));
        this.report.userData.tip = () => this.tips.report?.();
        this.tipMeshes.push(this.report);
        this.dynamic.add(this.report);
      }
      const target = st.metrics ? LAYOUT.station.clone().add(v3(0, 1.95, 0.6)) : LAYOUT.syn.clone().add(v3(0, 1, -4.6));
      setTarget(this.report, target, { snap, lift: 2.5, dur: 1.2 });
    } else if (this.report) { this.dynamic.remove(this.report); this.tipMeshes = this.tipMeshes.filter((x) => x !== this.report); this.report = null; }

    // 계측 막대 (M1~M5)
    const m = st.metrics;
    const vals = m ? [m.근거비율, m.허위인용 ? 1 : 0, Math.min(1, m.읽고안쓴문서 / Math.max(1, m.서로다른문서)), m.편중, m.중복률] : [0, 0, 0, 0, 0];
    this.stationBars.forEach((bar, i) => {
      bar.scale.y = Math.max(0.001, vals[i] * 3.2);
      bar.position.y = 2 + bar.scale.y / 2;
      bar.material.emissive.set(i === 1 && m?.허위인용 ? C.orange : C.cyan);
    });
    this.stationLamp.material.color.set(m ? (m.허위인용 ? C.orange : C.blue) : C.idleLamp);

    // 설비 표지판
    const corpus = st.run?.코퍼스 ?? status?.corpus;
    this.robots.update(st, { snap });
    const reading = Object.values(st.sections).filter((x) => x.current?.step === 'read').length;
    if (corpus) this.rackSign.set({ icon: 'wh', id: 'WH-00', title: '자동 창고', status: reading ? `문서 반출 ${reading}건` : `문서 ${corpus.문서수}건 보관`, state: reading ? 'active' : 'idle', stage: reading ? 'data' : 'idle' });
    const towerOn = nd.plan.state === 'active' || nd.dispatch.state === 'active';
    this.towerSign.set({ icon: 'ct', id: 'CT-01', title: '관제탑', status: nd.plan.state === 'active' ? '기획 · 목차 작성' : nd.dispatch.state === 'active' ? `배치 · ${st.round}바퀴 지시` : st.plan ? `배치 완료 · ${toc.length}절` : '질문 대기', state: towerOn ? 'active' : st.plan ? 'done' : 'idle', stage: towerOn ? 'active' : st.plan ? 'done' : 'idle' });
    const rv = lastReview;
    const gateAlert = rv?.다음 === 'dispatch' && !st.report;
    this.gateSign.set({ icon: 'qg', id: 'QG-04', title: '검사 게이트', status: nd.review.state === 'active' ? '원고 검사 중' : gateAlert ? `반송 ${rv.부족.length}절 → 재조사` : rv ? '통과 → 종합' : '원고 대기', state: nd.review.state === 'active' ? 'active' : gateAlert ? 'alert' : rv ? 'done' : 'idle', stage: nd.review.state === 'active' ? 'active' : gateAlert ? 'alert' : rv ? 'done' : 'idle' });
    this.synSign.set({ icon: 'sy', id: 'SY-05', title: '종합 설비', status: nd.synthesize.state === 'active' ? '원고 종합 중' : st.report ? `보고서 ${st.report.글자수.toLocaleString('ko-KR')}자` : '원고 대기', state: nd.synthesize.state === 'active' ? 'active' : st.report ? 'done' : 'idle', stage: nd.synthesize.state === 'active' ? 'data' : st.report ? 'done' : 'idle' });
    this.stationSign.set({ icon: 'ms', id: 'MS-06', title: '계측 스테이션', status: nd.evaluate.state === 'active' ? '계측 중' : m ? (m.허위인용 ? `허위 인용 ${m.허위인용}` : `근거 ${(m.근거비율 * 100).toFixed(1)}%`) : '보고서 대기', state: nd.evaluate.state === 'active' ? 'active' : m?.허위인용 ? 'alert' : m ? 'done' : 'idle', stage: nd.evaluate.state === 'active' ? 'active' : m?.허위인용 ? 'alert' : m ? 'data' : 'idle' });
  }

  _frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.t += dt;
    const st = this.st;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4);
    if (st) {
      const nd = st.nodes;
      const towerOn = nd.plan.state === 'active' || nd.dispatch.state === 'active';
      this.towerBand.material.emissiveIntensity = towerOn ? 0.5 + 0.8 * pulse : st.plan ? 0.22 : 0.06;
      this.towerBeacon.material.color.set(towerOn ? (pulse > 0.5 ? C.blue : 0x1b3a55) : C.idleLamp);
      const rv = st.reviews.at(-1);
      const gateAlert = rv?.다음 === 'dispatch' && !st.report;
      const gateColor = gateAlert ? C.orange : C.blue;
      const gateI = nd.review.state === 'active' ? 0.5 + pulse : rv ? 0.4 : 0.06;
      this.gateBar.material.emissive.set(gateColor); this.gateBar.material.emissiveIntensity = gateI;
      for (const l of this.gateLamps) { l.material.emissive.set(gateColor); l.material.emissiveIntensity = gateI * 0.8; }
      this.synRing.material.emissiveIntensity = nd.synthesize.state === 'active' ? 0.6 + pulse : st.report ? 0.35 : 0.06;
      for (const bay of this.bays.list) {
        const on = bay.working;
        bay.band.material.emissive.set(bay.short && !on ? C.orange : C.blue);
        bay.band.material.emissiveIntensity = on ? (bay.step === 'write' ? 0.9 + pulse : 0.5 + 0.5 * pulse) : bay.short ? 0.5 : bay.filed ? 0.18 : 0.04;
        bay.rimM.emissiveIntensity = on ? 0.6 + 0.3 * pulse : 0;
        bay.cabLight.material.emissive.set(C.blue); bay.cabLight.material.emissiveIntensity = on ? 0.9 : 0.05;
      }
      if (this.carriers.size) for (const tex of this.beltTextures) tex.offset.x -= dt * 0.8 * this.speed;
    }
    // 케이블: idle 은 어둡게, on 은 은은한 Teal, flow 는 신호가 흐르고, alert(④→② 반송)는 Amber
    for (const c of this.cables) {
      const s = c.state;
      c.mesh.material.emissive.set(s === 'alert' ? C.orange : C.cyan);
      c.mesh.material.emissiveIntensity = s === 'idle' ? 0.0 : s === 'on' ? 0.45 : 0.9;
      c.bead.visible = s === 'flow' || s === 'alert';
      if (c.bead.visible) {
        c.bead.material.color.set(s === 'alert' ? C.orange : C.cyan);
        c.curve.getPoint((this.t * 0.6 * this.speed + c.phase) % 1, c.bead.position);
      }
    }
    if (this.marker.visible) this.marker.rotation.y += dt * 1.5;
    for (const b of this.bays.list) if (b.scan?.visible) b.scan.material.dashOffset -= dt * 2 * this.speed;
    for (const o of this.dynamic.children) stepMover(o, dt, this.speed);
    this.robots.tick(dt, this.speed);
    this.controls.update();
    const az = this.controls.getAzimuthalAngle();
    for (const s of SIGNS) if (s.mesh.parent) s.mesh.rotation.y = az; // 표지판은 늘 카메라 쪽을 본다
    this._hover();
    this.renderer.render(this.scene, this.camera);
  }

  _hit() {
    if (this.pointer.x > 2) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.tipMeshes, ...this.carriers.values()], false);
    return hits.find((h) => h.object.visible && h.object.userData.tip) ?? null;
  }

  _hover() {
    if (!this.onHover || this.pointer.x > 2) return;
    const hit = this._hit();
    const text = hit ? hit.object.userData.tip() : null;
    this.renderer.domElement.style.cursor = hit?.object.userData.doc || hit?.object.userData.unit ? 'pointer' : '';
    if (text !== this._lastTip || text) this.onHover(text ? { text, ...this.pointerPx } : null);
    this._lastTip = text;
  }
}
