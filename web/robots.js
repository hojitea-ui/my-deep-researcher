// 자율주행 장비 — RU(Research Unit, 연구 구역 소속 로봇) · DC(Document Carrier, 문서·원고 운반 장치)
//
// 원칙: 장비의 위치·동작은 모두 상태(이벤트를 0번부터 접은 결과)에서 계산한다.
//       실제 이벤트가 없으면 움직이지 않고, 시점을 건너뛰면 그 시점의 자리에 바로 놓인다.
//       역할명·담당 업무는 쓰지 않는다. 장비는 구역 번호(A~)로만 리서처와 연결된다.
//
// RU  : 대기(자기 구역 앞) → 탐색·읽기(자료 보관소 랙 앞) → 원고 작성(자기 구역 앞) → 점검 결과 대기(자기 구역 앞)
// DC  : 대기(자기 구역 옆) → 읽기 이벤트 동안 보관소에서 문서를 싣고 구역으로 → 점검 땐 원고를 게이트로 →
//       부족 판정이면 구역으로 반송 → 종합 땐 종합 설비로 → 보고서가 나오면 구역 옆으로 복귀
//
// 동선(물리 엔진 없음)
//  · 구역별 전용 레인: 구역마다 바닥 레인 하나(그 구역의 RU·DC 가 함께 쓴다). 레인은 서로 평행하고,
//    창고에서 먼 구역일수록 바깥 줄을 써서 다른 구역의 분기 지점을 가로지르지 않는다. 각자 자기 구역 앞에서 분기한다.
//      A = 구역 앞줄 · B·C = 구역과 게이트 사이 두 줄 · D = 게이트 앞줄(게이트 기둥을 피해 앞쪽으로 돈다)
//  · 정차 자리(구역 앞·랙 앞·게이트 칸·종합 설비 옆)는 장비마다 따로 있고 서로 겹치지 않는다.
//  · 게이트·종합·복귀처럼 레인을 가로질러야 하는 이동은 통행 우선순위로 푼다:
//    앞으로 갈 길(선점 구간)이 다른 장비의 선점 구간과 겹치면, 이미 그 길에 들어선 장비가 먼저 가고
//    나머지는 겹치기 전에 멈춰 기다린다. 어느 경우에도 다음 걸음이 다른 장비 몸체와 겹치면 움직이지 않는다.
import * as THREE from 'three';

const LETTERS = 'ABCDEFGH';
const SPEED = 11; // 통로 이동 속도(단위/초) — 재생 배속을 곱한다
const COL = {
  body: 0x30383d, plate: 0xbbc3c5, wheel: 0x1e2428, ti: 0xe7e9e7,
  blue: 0x287cc2, cyan: 0x008f91, orange: 0xc16c45, off: 0x4a5359, dim: 0x9aa4a8,
};
// 바닥 몸체(위에서 본 사각형): hw = 옆 반폭, hl = 앞뒤 반길이 (모형 크기 × 배율 + 팔 여유)
const FOOT = { RU: { hw: 0.74, hl: 0.62 }, DC: { hw: 0.61, hl: 0.84 } };
const GAP = 0.05;   // 몸체 사이 최소 간격
const AHEAD = 2.4;  // 선점 구간 길이
const SUB = 0.25;   // 한 번에 움직이는 최대 거리(배속이 커도 건너뛰지 않게 쪼갠다)

// 바닥 배치(공장 좌표). 구역 x 는 공장에서 받는다
const Z = {
  dock: 4.75, work: 4.5,              // 구역 앞 정차 줄 (구역 바닥판 끝 z 3.83)
  lanes: [4.75, 6.35, 7.95],          // 구역 레인 A·B·C (게이트 기둥 z 9.25 보다 뒤)
  front: 12.6,                        // 네 번째 구역 레인 (게이트 바닥판 z 11.8 보다 앞)
  rack: [4.75, 6.35, 7.95, 9.55],     // 랙 앞 자리 줄
  gate: 10.0, syn: 7.95,
};
const X = { rackRU: -13.1, rackDC: -11.55, synCol: 8.0, synSpot: 9.75, side: 1.25 };

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
let floorAt = () => 0; // 몸체가 바닥판에 걸리면 그 높이 (Robots 가 공장 배치로 정한다)
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.55, ...o });
const box = (w, h, d, m) => { const x = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); x.castShadow = true; x.receiveShadow = true; return x; };
const cyl = (r, h, m, seg = 16) => { const x = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m); x.castShadow = true; return x; };
const P = (x, z) => v3(x, 0, z);

function letterPlate(letter) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#30383d'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#e7e9e7'; g.font = '700 92px "IBM Plex Mono",Consolas,monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(letter, 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t });
}

// ── 바닥 몸체 충돌(분리축 검사) ──
export function footprint(p, yaw, f) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: p.x, z: p.z, ux: c, uz: -s, vx: s, vz: c, hw: f.hw, hl: f.hl };
}
export function overlap(a, b, m = 0) {
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [ax, az] of [[a.ux, a.uz], [a.vx, a.vz], [b.ux, b.uz], [b.vx, b.vz]]) {
    const ra = a.hw * Math.abs(a.ux * ax + a.uz * az) + a.hl * Math.abs(a.vx * ax + a.vz * az);
    const rb = b.hw * Math.abs(b.ux * ax + b.uz * az) + b.hl * Math.abs(b.vx * ax + b.vz * az);
    if (Math.abs(dx * ax + dz * az) > ra + rb + m) return false;
  }
  return true;
}
const anyOverlap = (as, bs, m) => as.some((a) => bs.some((b) => overlap(a, b, m)));

// ── 장비별 길 그래프: 그 장비가 쓰는 레인·분기 선분만 담는다 ──
const key = (p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
class Network {
  constructor(segments) {
    // 선분 = [a, b, 가중치]. 끝점·교차점마다 잘라 마디를 만든다(모든 선분은 축에 나란하다)
    const pts = [];
    for (const [a, b] of segments) pts.push(a, b);
    for (const [a, b] of segments) for (const [c, d] of segments) {
      const h1 = Math.abs(a.z - b.z) < 1e-6, h2 = Math.abs(c.z - d.z) < 1e-6;
      if (h1 && !h2) { const x = c.x, z = a.z; if (x >= Math.min(a.x, b.x) - 1e-6 && x <= Math.max(a.x, b.x) + 1e-6 && z >= Math.min(c.z, d.z) - 1e-6 && z <= Math.max(c.z, d.z) + 1e-6) pts.push(P(x, z)); }
    }
    this.nodes = new Map();
    for (const p of pts) this.nodes.set(key(p), P(p.x, p.z));
    this.adj = new Map([...this.nodes.keys()].map((k) => [k, new Map()]));
    for (const [a, b, w = 1] of segments) {
      const on = [...this.nodes.values()].filter((p) => onSeg(p, a, b)).sort((p, q) => p.distanceTo(a) - q.distanceTo(a));
      for (let k = 1; k < on.length; k++) this._edge(on[k - 1], on[k], w);
    }
    this.segments = segments;
  }
  _edge(p, q, w) {
    const kp = key(p), kq = key(q), c = p.distanceTo(q) * w;
    if (c < 1e-6) return;
    if (!(this.adj.get(kp).get(kq) <= c)) { this.adj.get(kp).set(kq, c); this.adj.get(kq).set(kp, c); }
  }
  // 현재 위치(그래프 위의 점)에서 목표 마디까지 — 모퉁이마다 작은 벌점을 줘서 꺾임이 적은 길을 고른다
  route(from, to) {
    const tk = key(to);
    if (!this.nodes.has(tk)) return [from.clone(), to.clone()];
    const start = new Map(); // 출발점이 선분 중간이면 양 끝 마디로 잇는다
    if (this.nodes.has(key(from))) start.set(key(from), 0);
    else {
      for (const [a, b] of this.segments) if (onSeg(from, a, b)) {
        const on = [...this.nodes.values()].filter((p) => onSeg(p, a, b));
        const along = (p) => (p.clone().sub(a)).dot(b.clone().sub(a).normalize());
        const t = along(from);
        const lo = on.filter((p) => along(p) <= t).sort((p, q) => along(q) - along(p))[0];
        const hi = on.filter((p) => along(p) >= t).sort((p, q) => along(p) - along(q))[0];
        for (const p of [lo, hi]) if (p) start.set(key(p), Math.min(start.get(key(p)) ?? Infinity, p.distanceTo(from)));
      }
      if (!start.size) { // 그래프 밖(만들어질 때 등): 가장 가까운 마디로
        let best = null; for (const p of this.nodes.values()) if (!best || p.distanceTo(from) < best.distanceTo(from)) best = p;
        start.set(key(best), best.distanceTo(from));
      }
    }
    const dist = new Map(start), prev = new Map(), done = new Set();
    while (true) {
      let u = null, du = Infinity;
      for (const [k, d] of dist) if (!done.has(k) && d < du) { u = k; du = d; }
      if (u === null || u === tk) break;
      done.add(u);
      for (const [v, c] of this.adj.get(u)) {
        const turn = prev.has(u) && bends(this.nodes.get(prev.get(u)), this.nodes.get(u), this.nodes.get(v)) ? 0.3 : 0;
        const nd = du + c + turn;
        if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); }
      }
    }
    if (!dist.has(tk)) return [from.clone(), to.clone()];
    const seq = [];
    for (let k = tk; k; k = prev.get(k)) seq.unshift(this.nodes.get(k).clone());
    return [from.clone(), ...seq].filter((p, i, a) => i === 0 || p.distanceTo(a[i - 1]) > 1e-3);
  }
}
function onSeg(p, a, b) {
  const ab = b.clone().sub(a), ap = p.clone().sub(a);
  const L = ab.length();
  if (L < 1e-9) return p.distanceTo(a) < 1e-4;
  const t = ap.dot(ab) / (L * L);
  return t >= -1e-6 && t <= 1 + 1e-6 && ap.sub(ab.multiplyScalar(t)).length() < 1e-4;
}
function bends(a, b, c) { const u = b.clone().sub(a).normalize(), w = c.clone().sub(b).normalize(); return u.dot(w) < 0.999; }

class Vehicle {
  constructor(group, kind, i) {
    this.group = group; this.body3d = group.children[0]; this.kind = kind; this.i = i; this.foot = FOOT[kind];
    this.rank = (kind === 'RU' ? 0 : 100) + i;
    this.path = null; this.seg = 0; this.key = ''; this.faceTo = null; this.showAt = 0; this.payload = null;
    this.waited = 0; this.blocker = null; this.target = null;
  }
  // 선분 위를 s 만큼 갔을 때의 자리와 방향(실제로 옮기지는 않는다)
  peek(s) {
    const p = this.group.position.clone();
    let seg = this.seg, yaw = this.group.rotation.y;
    while (this.path && seg < this.path.length) {
      const t = this.path[seg];
      const d = t.clone().sub(p); const len = d.length();
      if (len > 1e-6) yaw = Math.atan2(d.x, d.z);
      if (len <= s + 1e-9) { p.copy(t); s -= len; seg += 1; if (s <= 1e-9) break; } else { p.add(d.multiplyScalar(s / len)); break; }
    }
    if (this.path && seg >= this.path.length && this.faceTo) { const d = this.faceTo.clone().sub(p); if (d.lengthSq() > 1e-4) yaw = Math.atan2(d.x, d.z); }
    return { p, seg, yaw };
  }
  advance(s) {
    const r = this.peek(s);
    this.group.position.copy(r.p); this.group.rotation.y = r.yaw; this.seg = r.seg;
    if (this.seg >= this.path.length) { this.path = null; if (this.faceTo) this.face(this.faceTo); }
    this.lift();
  }
  // 몸체만 바닥판 높이로 올린다(논리 위치는 y=0 평면)
  lift() { this.body3d.position.y = floorAt(this.body()) / this.group.scale.y; }
  body() { return footprint(this.group.position, this.group.rotation.y, this.foot); }
  // 선점 구간: 지금 자리부터 앞으로 AHEAD 만큼 (도착하면 마지막으로 돌아설 방향까지)
  claim() {
    const out = [this.body()];
    if (!this.path) return out;
    for (let s = 0.4; s <= AHEAD + 1e-6; s += 0.4) {
      const r = this.peek(s);
      out.push(footprint(r.p, r.yaw, this.foot));
      if (r.seg >= this.path.length) break;
    }
    return out;
  }
  go(path, { snap, faceTo = null, showAt = 0 }) {
    this.faceTo = faceTo; this.showAt = showAt; this.waited = 0; this.blocker = null;
    this.target = path.at(-1).clone();
    if (snap || path.length < 2) {
      this.group.position.copy(path.at(-1));
      this.path = null; this.seg = 0;
      if (faceTo) this.face(faceTo);
      this.lift();
      return;
    }
    this.path = path; this.seg = 1;
  }
  face(p) { const d = p.clone().sub(this.group.position); if (d.lengthSq() > 1e-4) this.group.rotation.y = Math.atan2(d.x, d.z); }
  get leg() { return this.path ? this.seg : Infinity; }
}

export class Robots {
  constructor(factory, layout, count = 1) {
    this.f = factory; this.L = layout; this.count = count;
    this.group = new THREE.Group(); this.group.name = 'robots';
    factory.scene.add(this.group);
    this.paint = new THREE.Group(); this.paint.name = 'robot-lanes';
    factory.scene.add(this.paint);
    this.ru = []; this.dc = [];
    this.t = 0;
    this.stats = { waits: 0, backoffs: 0 };
    // 게이트 바닥판(10.4 × 2.85, 높이 0.14)에 몸체가 걸리면 그만큼 올라선다
    const G = layout.gate;
    const plate = { x: G.x, z: G.z + 0.375, ux: 1, uz: 0, vx: 0, vz: 1, hw: 5.2, hl: 1.425 };
    floorAt = (fp) => (overlap(fp, plate, -0.01) ? 0.14 : 0);
  }

  setCount(count) { this.count = count; this.n = -1; }
  handles(i) { return i < Math.min(this.count, this.f.bays.list.length); }

  // ── 자리: 구역 번호 i 마다 정해진 곳 ──
  places(i) {
    const bays = this.f.bays.list;
    const n = bays.length;
    const bx = bays[i]?.x ?? 0;
    const front = i >= Z.lanes.length;
    const lane = front ? Z.front + (i - Z.lanes.length) * 1.6 : Z.lanes[i];
    const rackZ = Z.rack[Math.min(i, Z.rack.length - 1)] + Math.max(0, i - (Z.rack.length - 1)) * 1.6;
    const gx = this.L.gate.x + (i - (n - 1) / 2) * 1.5;
    const ruX = bx - X.side, dcX = bx + X.side;
    return {
      bx, lane, rackZ, front,
      dock: P(ruX, Z.dock), work: P(ruX, Z.work), bayFace: P(ruX, -20),
      rack: P(X.rackRU, rackZ), rackFace: P(X.rackRU - 5, rackZ),
      dcBay: P(dcX, Z.dock), dcBayFace: P(dcX - 5, Z.dock),
      dcLoad: P(X.rackDC, rackZ), dcLoadFace: P(X.rackDC - 5, rackZ),
      dcGate: P(gx, Z.gate), dcGateFace: P(gx, Z.gate + 5),
      // 게이트로 가는 줄: 자기 구역 레인을 쓴다. A 처럼 레인이 구역 앞줄이면 게이트 뒤 바깥 줄(Z.lanes[2])
      approach: i === 0 ? Z.lanes[Math.min(2, Z.lanes.length - 1)] : lane,
      dcSyn: P(X.synSpot, Z.syn - 1.6 + 1.5 * (n - 1 - i)), dcSynFace: P(X.synSpot + 5, Z.syn - 1.6 + 1.5 * (n - 1 - i)),
    };
  }

  // 장비별 길 그래프
  _networks(i) {
    const p = this.places(i);
    const ru = [
      [p.dock, p.work],
      [p.dock, P(p.dock.x, p.lane)], [P(p.dock.x, p.lane), P(X.rackRU, p.lane)], [P(X.rackRU, p.lane), p.rack],
    ];
    const syn = 1.15; // 종합·복귀 선분: 그 이동 때만 쓰이게 조금 비싸게
    const gx = p.dcGate.x;
    const dc = [
      // 문서 운반: 구역 옆 → 레인 → 랙 앞
      [p.dcBay, P(p.dcBay.x, p.lane)], [P(p.dcBay.x, p.lane), P(X.rackDC, p.lane)], [P(X.rackDC, p.lane), p.dcLoad],
      // 점검: 구역 옆 → 게이트 접근 줄 → 게이트 칸
      [p.dcBay, P(p.dcBay.x, p.approach)], [P(p.dcBay.x, p.approach), P(gx, p.approach)], [P(gx, p.approach), p.dcGate],
      // 종합: 게이트 칸 → (뒤로 빠져) 종합 줄 → 종합 설비 옆 세로 통로 → 자리
      [p.dcGate, P(gx, Z.syn), syn], [P(gx, Z.syn), P(X.synCol, Z.syn), syn], [P(X.synCol, Z.syn), P(X.synCol, p.dcSyn.z), syn], [P(X.synCol, p.dcSyn.z), p.dcSyn, syn],
    ];
    // 보고서 뒤 복귀: 종합 설비 옆 → 구역 옆
    if (p.dcBay.x > X.synCol) dc.push([p.dcSyn, P(p.dcBay.x, p.dcSyn.z), syn], [P(p.dcBay.x, p.dcSyn.z), p.dcBay, syn]);
    else dc.push([P(X.synCol, Z.syn), P(p.dcBay.x, Z.syn), syn], [P(p.dcBay.x, Z.syn), p.dcBay, syn]);
    return { ru: new Network(ru), dc: new Network(dc), lanes: ru.slice(1).concat(dc.slice(0, 3)) };
  }

  _build(i) {
    const letter = LETTERS[i] ?? String(i);
    // RU: 소형 산업용 자율주행 로봇 — 낮은 섀시 · 바퀴 4 · 라이다 · 마스트와 2관절 팔 · 상태 띠
    const ruRoot = new THREE.Group(); ruRoot.name = `RU-${letter}`;
    const ru = new THREE.Group(); ruRoot.add(ru);
    const chassis = box(1.0, 0.42, 0.78, mat(COL.ti, { metalness: 0.25, roughness: 0.42 })); chassis.position.y = 0.37; ru.add(chassis);
    const bumper = box(1.04, 0.14, 0.82, mat(COL.body)); bumper.position.y = 0.2; ru.add(bumper);
    const top = box(0.92, 0.06, 0.7, mat(COL.plate, { metalness: 0.7, roughness: 0.3 })); top.position.y = 0.61; ru.add(top);
    const band = box(1.06, 0.07, 0.84, mat(COL.body, { emissive: new THREE.Color(COL.off), emissiveIntensity: 0.0 })); band.position.y = 0.48; ru.add(band);
    for (const [x, z] of [[-0.38, 0.3], [0.38, 0.3], [-0.38, -0.3], [0.38, -0.3]]) { const w = cyl(0.15, 0.1, mat(COL.wheel, { metalness: 0.2 }), 14); w.rotation.z = Math.PI / 2; w.position.set(x, 0.15, z); ru.add(w); }
    const lidar = cyl(0.13, 0.12, mat(COL.wheel)); lidar.position.set(0, 0.7, 0.24); ru.add(lidar);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), letterPlate(letter)); plate.rotation.x = -Math.PI / 2; plate.position.set(0.22, 0.645, -0.12); ru.add(plate);
    const mast = box(0.12, 0.55, 0.12, mat(COL.body)); mast.position.set(-0.28, 0.9, -0.2); ru.add(mast);
    const shoulder = new THREE.Group(); shoulder.position.set(-0.28, 1.17, -0.2); ru.add(shoulder);
    const upper = box(0.09, 0.09, 0.62, mat(COL.plate, { metalness: 0.7 })); upper.position.z = 0.31; shoulder.add(upper);
    const elbow = new THREE.Group(); elbow.position.z = 0.62; shoulder.add(elbow);
    const fore = box(0.08, 0.08, 0.45, mat(COL.body)); fore.position.z = 0.22; elbow.add(fore);
    const grip = box(0.18, 0.1, 0.08, mat(COL.plate)); grip.position.z = 0.47; elbow.add(grip);
    const tool = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: COL.off })); tool.position.z = 0.53; elbow.add(tool);
    ruRoot.userData = { tip: () => this.f.tips.robot?.(i, 'RU'), unit: `RS-${letter}` };
    chassis.userData = ruRoot.userData; top.userData = ruRoot.userData;
    this.f.tipMeshes.push(chassis, top);
    ruRoot.scale.setScalar(1.4);
    this.group.add(ruRoot);
    const R = new Vehicle(ruRoot, 'RU', i);
    Object.assign(R, { band, shoulder, elbow, tool, mode: 'idle' });
    const p = this.places(i);
    R.group.position.copy(p.dock); R.face(p.bayFace);

    // DC: 평평한 무인 운반 장치 — 알루미늄 데크 · 데이터 띠(Cyan) · 적재물. 긴 변이 진행 방향(로컬 z)
    const dcRoot = new THREE.Group(); dcRoot.name = `DC-${letter}`;
    const dc = new THREE.Group(); dcRoot.add(dc);
    const base = box(0.9, 0.26, 1.25, mat(0xd4d9da, { metalness: 0.45, roughness: 0.35 })); base.position.y = 0.24; dc.add(base);
    const skirt = box(0.92, 0.08, 1.27, mat(COL.body)); skirt.position.y = 0.12; dc.add(skirt);
    const strip = box(0.93, 0.05, 1.28, mat(COL.body, { emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.0 })); strip.position.y = 0.32; dc.add(strip);
    const beacon = cyl(0.07, 0.12, new THREE.MeshBasicMaterial({ color: COL.off }), 10); beacon.position.set(0.33, 0.44, 0.5); dc.add(beacon);
    const dplate = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), letterPlate(letter)); dplate.rotation.x = -Math.PI / 2; dplate.position.set(-0.3, 0.375, -0.46); dc.add(dplate);
    const crate = box(0.56, 0.42, 0.72, mat(0xd6e6e6, { metalness: 0.25, roughness: 0.45, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.5 })); crate.position.y = 0.6; crate.visible = false; dc.add(crate);
    dcRoot.userData = { tip: () => this.f.tips.robot?.(i, 'DC'), unit: `RS-${letter}` };
    base.userData = dcRoot.userData; crate.userData = dcRoot.userData;
    this.f.tipMeshes.push(base, crate);
    dcRoot.scale.setScalar(1.3);
    this.group.add(dcRoot);
    const D = new Vehicle(dcRoot, 'DC', i);
    Object.assign(D, { strip, beacon, crate, task: 'home' });
    D.group.position.copy(p.dcBay); D.face(p.dcBayFace);
    const nets = this._networks(i);
    R.net = nets.ru; D.net = nets.dc;
    return [R, D, nets.lanes];
  }

  _sync() {
    const n = Math.min(this.count, this.f.bays.list.length);
    if (n === this.n && this.bayKey === this.f.bays.n) return;
    this.n = n; this.bayKey = this.f.bays.n;
    this.group.clear();
    this.f.tipMeshes = this.f.tipMeshes.filter((m) => !m.userData?.unit?.startsWith?.('RS-') || m.userData.bay);
    this.ru = []; this.dc = [];
    const lanes = [];
    for (let i = 0; i < n; i++) { const [R, D, segs] = this._build(i); this.ru.push(R); this.dc.push(D); lanes.push(...segs); }
    this._paintLanes(lanes);
  }

  // 바닥 레인 표시: 구역 레인과 분기만 얇은 중성색 선으로 칠한다(겹치는 선분은 한 번만)
  _paintLanes(segs) {
    this.paint.clear();
    const m = new THREE.MeshBasicMaterial({ color: 0x8a9599, transparent: true, opacity: 0.4, depthWrite: false });
    const seen = [];
    for (const [a, b] of segs) {
      const len = a.distanceTo(b);
      if (len < 0.05) continue;
      // 같은 줄 위에 이미 칠한 구간은 빼고 칠한다
      const h = Math.abs(a.z - b.z) < 1e-6;
      let [lo, hi] = h ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.z, b.z), Math.max(a.z, b.z)];
      const c = h ? a.z : a.x;
      for (const s of seen) if (s.h === h && Math.abs(s.c - c) < 1e-6) { if (s.lo <= lo && s.hi >= lo) lo = Math.max(lo, s.hi); if (s.lo <= hi && s.hi >= hi) hi = Math.min(hi, s.lo); }
      if (hi - lo < 0.05) continue;
      seen.push({ h, c, lo, hi });
      const w = 0.09;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(h ? hi - lo : w, h ? w : hi - lo), m);
      mesh.rotation.x = -Math.PI / 2; mesh.renderOrder = -1;
      mesh.position.set(h ? (lo + hi) / 2 : c, 0.025, h ? c : (lo + hi) / 2);
      this.paint.add(mesh);
    }
  }

  // ── RU 상태: 이벤트에서 계산 ──
  ruState(st, i) {
    const x = st.sections[i];
    const p = this.places(i);
    const nd = st.nodes;
    if (!x || !x.dispatched) return { key: 'idle', to: p.dock, face: p.bayFace, mode: 'idle', label: '대기 · 배정 전' };
    const d = x.drafts.at(-1);
    const thisRound = d && d.round === x.round;
    if (x.status === 'working' || x.status === 'dispatched') {
      const step = x.current?.step ?? x.lastStep;
      if (step === 'pick' || step === 'read') {
        const doc = x.current?.doc ?? x.lastDoc;
        return { key: `rack-${x.round}`, to: p.rack, face: p.rackFace, mode: step === 'read' ? 'read' : 'search', label: step === 'read' ? `읽기 · «${doc ?? '문서'}» 수집` : '문서 탐색 · 자료 보관소' };
      }
      if (step === 'write') return { key: `work-${x.round}`, to: p.work, face: p.bayFace, mode: 'write', label: '원고 작성 · 처리 설비 앞' };
      return { key: `dock-on-${x.round}`, to: p.dock, face: p.bayFace, mode: 'active', label: '활성 · 작업 준비' };
    }
    // 점검 중에는 원고를 DC 가 게이트로 옮기고, RU 는 자기 구역 앞에서 결과를 기다린다
    if (nd.review.state === 'active' && thisRound) return { key: `review-${x.round}`, to: p.dock, face: p.bayFace, mode: 'review', label: '점검 결과 대기 · 구역 앞' };
    if (d && d.충분 === false && !st.report) return { key: `short-${x.round}`, to: p.dock, face: p.bayFace, mode: 'short', label: '부족 신고 · 재조사 대기' };
    return { key: 'done', to: p.dock, face: p.bayFace, mode: d ? 'done' : 'active', label: d ? '원고 제출 · 대기' : '활성' };
  }

  // ── DC 상태: 문서 이벤트와 원고 흐름에서 계산 ──
  dcState(st, i) {
    const x = st.sections[i];
    const p = this.places(i);
    const nd = st.nodes;
    const at = (to, face) => ({ to, face });
    if (x?.current?.step === 'read') return { key: `doc-${x.current.call}`, legs: [at(p.dcLoad, p.dcLoadFace), at(p.dcBay, p.dcBayFace)], payload: 'doc', label: `문서 운반 · «${x.current.doc}» → 연구 구역 ${LETTERS[i]}` };
    const d = x?.drafts.at(-1);
    if (d && !st.report && nd.synthesize.state === 'active') return { key: 'syn', legs: [at(p.dcSyn, p.dcSynFace)], payload: 'draft', label: '원고 운반 → 종합 설비' };
    if (d && !st.report) {
      const lastReview = st.reviews.at(-1);
      // 반송은 점검 결정부터 재조사 배치 전까지만. 재조사가 배치되면 지난 원고는 구역에 내려놓은 것으로 본다
      const returned = lastReview?.다음 === 'dispatch' && lastReview.부족.includes(i) && d.round === lastReview.바퀴 && x.round === d.round;
      if (lastReview?.다음 === 'dispatch' && lastReview.부족.includes(i) && x.round > d.round) return { key: `free-${x.round}`, legs: [at(p.dcBay, p.dcBayFace)], payload: null, label: '재조사 · 새 문서 대기' };
      const reviewing = st.reviews.some((r) => r.바퀴 === d.round) || (nd.review.state === 'active' && d.round === st.round);
      if (returned) return { key: `ret-${d.round}`, legs: [at(p.dcBay, p.dcBayFace)], payload: 'short', label: '부족 원고 반송 → 연구 구역' };
      if (reviewing) return { key: `gate-${d.round}`, legs: [at(p.dcGate, p.dcGateFace)], payload: d.충분 ? 'draft' : 'short', label: '원고 운반 → 검사 게이트' };
      return { key: `out-${d.round}`, legs: [at(p.dcBay, p.dcBayFace)], payload: 'draft', label: '원고 대기 · 구역 출력대' };
    }
    return { key: 'home', legs: [at(p.dcBay, p.dcBayFace)], payload: null, label: `대기 · 연구 구역 ${LETTERS[i] ?? i} 옆` };
  }

  update(st, { snap }) {
    this._sync();
    this.st = st;
    for (const R of this.ru) {
      const s = this.ruState(st, R.i);
      R.mode = s.mode; R.label = s.label;
      if (s.key !== R.key || snap) {
        R.key = s.key;
        R.go(R.net.route(R.group.position, s.to), { snap, faceTo: s.face });
      }
      const color = { idle: COL.off, active: COL.blue, search: COL.blue, read: COL.blue, write: COL.blue, review: COL.blue, short: COL.orange, done: COL.dim }[s.mode];
      R.band.material.emissive.set(color);
      R.band.material.emissiveIntensity = s.mode === 'idle' ? 0 : s.mode === 'done' ? 0.25 : 0.9;
      R.tool.material.color.set(s.mode === 'read' || s.mode === 'search' ? COL.cyan : s.mode === 'short' ? COL.orange : s.mode === 'idle' ? COL.off : COL.blue);
    }
    for (const D of this.dc) {
      const s = this.dcState(st, D.i);
      D.label = s.label;
      if (s.key !== D.key || snap) {
        D.key = s.key;
        const path = [];
        let from = D.group.position.clone();
        const marks = [];
        for (const leg of s.legs) { const r = D.net.route(from, leg.to); path.push(...(path.length ? r.slice(1) : r)); marks.push(path.length - 1); from = leg.to; }
        // 문서는 보관소에서 실은 뒤에야 보인다(첫 구간을 지나야 적재)
        D.go(path, { snap, faceTo: s.legs.at(-1).face, showAt: s.payload === 'doc' && s.legs.length > 1 ? marks[0] + 1 : 0 });
        D.payload = s.payload;
      }
      this._paintDC(D);
    }
  }

  _paintDC(D) {
    const loaded = D.payload && (D.leg >= D.showAt || !D.path);
    D.crate.visible = !!loaded;
    if (loaded) {
      const doc = D.payload === 'doc';
      D.crate.scale.set(doc ? 1 : 1.1, doc ? 1 : 0.8, doc ? 1 : 1.05);
      D.crate.material.color.set(doc ? 0xd6e6e6 : 0xf3f4f3);
      D.crate.material.emissive.set(D.payload === 'short' ? COL.orange : COL.cyan);
    }
    const moving = !!D.path;
    D.strip.material.emissiveIntensity = loaded ? 0.9 : moving ? 0.35 : 0;
    D.strip.material.emissive.set(D.payload === 'short' ? COL.orange : COL.cyan);
    D.beacon.material.color.set(loaded ? (D.payload === 'short' ? COL.orange : COL.cyan) : COL.off);
  }

  // ── 이동: 쪼갠 걸음마다 통행 우선순위와 몸체 간격을 확인한다 ──
  _step(all, s, dt) {
    const moving = all.filter((v) => v.path);
    if (!moving.length) return;
    const bodies = new Map(all.map((v) => [v, v.body()]));
    const claims = new Map(moving.map((v) => [v, v.claim()]));
    moving.sort((a, b) => a.rank - b.rank);
    for (const A of moving) {
      const nx = A.peek(s);
      const nb = footprint(nx.p, nx.yaw, A.foot);
      let blocker = null;
      for (const B of all) {
        if (B === A) continue;
        if (overlap(nb, bodies.get(B), GAP)) { blocker = B; break; }            // 다음 걸음이 몸체와 겹치면 멈춘다
        if (!B.path || !anyOverlap(claims.get(A), claims.get(B), GAP)) continue;   // 앞길이 겹치지 않으면 상관없다
        const aIn = claims.get(B).some((c) => overlap(bodies.get(A), c, GAP));      // 내가 이미 B 의 앞길에 들어섰다
        const bIn = claims.get(A).some((c) => overlap(bodies.get(B), c, GAP));      // B 가 이미 내 앞길에 들어섰다
        if (bIn && !aIn) { blocker = B; break; }
        if (aIn && !bIn) continue;
        if (A.rank > B.rank && !(B.blocker === A && B.waited > 0)) { blocker = B; break; } // 우선순위: RU → DC, 구역 순
      }
      if (!blocker) {
        A.advance(s); bodies.set(A, A.body()); A.waited = 0; A.blocker = null;
      } else {
        if (!A.waited) this.stats.waits += 1;
        A.waited += dt; A.blocker = blocker;
        // 서로 길을 막고 멈춘 경우(맞은편에서 마주침): 순위가 낮은 쪽이 지나온 마디로 물러섰다가 같은 길을 다시 간다
        if (A.waited > 1.2 && blocker.blocker === A && blocker.waited > 1.2 && A.rank > blocker.rank && A.seg > 0) {
          const back = A.path[A.seg - 1];
          if (back && back.distanceTo(A.group.position) > 1e-3) {
            this.stats.backoffs += 1;
            const rest = A.path.slice(A.seg);
            A.showAt = A.showAt > A.seg ? A.showAt - A.seg + 2 : 0;
            A.path = [A.group.position.clone(), back.clone(), ...rest]; A.seg = 1; A.waited = 0;
          }
        }
      }
    }
  }

  tick(dt, speed) {
    this.t += dt;
    const all = [...this.ru, ...this.dc];
    const total = SPEED * speed * dt;
    const n = Math.max(1, Math.ceil(total / SUB));
    for (let k = 0; k < n; k++) this._step(all, total / n, dt / n);
    for (const D of this.dc) this._paintDC(D);
    for (const R of this.ru) {
      // 작업 중일 때만 팔을 움직인다: 수집(앞으로 뻗기) · 작성(위아래) · 점검 대기(좌우 훑기)
      const at = !R.path;
      const k = this.t * 3 * speed;
      if (at && (R.mode === 'read' || R.mode === 'search')) { R.shoulder.rotation.x = -0.25 + Math.sin(k) * 0.18; R.elbow.rotation.x = 0.5 + Math.sin(k) * 0.25; R.shoulder.rotation.y = 0; }
      else if (at && R.mode === 'write') { R.shoulder.rotation.x = -0.55 + Math.sin(k * 1.3) * 0.12; R.elbow.rotation.x = 0.9 + Math.cos(k * 1.3) * 0.2; R.shoulder.rotation.y = 0; }
      else if (at && R.mode === 'review') { R.shoulder.rotation.x = -0.4; R.elbow.rotation.x = 0.6; R.shoulder.rotation.y = Math.sin(k * 0.8) * 0.5; }
      else { R.shoulder.rotation.x = 0.9; R.elbow.rotation.x = 1.9; R.shoulder.rotation.y = 0; } // 접은 자세
    }
  }
}
