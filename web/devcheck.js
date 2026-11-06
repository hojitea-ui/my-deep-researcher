// 개발 확인용(?dev=1): 설비 메시끼리 관통하는 곳을 찾는다. 화면에는 쓰지 않는다.
// 방법: 각 메시 표면에 촘촘히 점을 찍고, 그 점이 다른 설비 메시의 부피 안에 들어가면 관통으로 본다.
//       같은 설비(같은 조립체) 안의 부품끼리는 일부러 맞물린 것이므로 보지 않는다.
import * as THREE from 'three';
import { overlap } from './robots.js';

const TOL = 0.012; // 면이 맞닿은 정도(접촉)는 관통으로 보지 않는다

function kindOf(mesh) {
  const g = mesh.geometry;
  if (!g) return null;
  if (g.type === 'BoxGeometry') return 'box';
  if (g.type === 'CylinderGeometry') return 'cyl';
  if (g.type === 'TubeGeometry') return 'tube';
  if (g.type === 'SphereGeometry') return 'sphere';
  if (g.type === 'TorusGeometry') return 'torus';
  return null; // 평면(표지판·바닥 표시)은 보지 않는다
}

// 표면 점 (월드 좌표)
function samples(mesh, step = 0.12) {
  const k = kindOf(mesh);
  const p = mesh.geometry.parameters;
  const out = [];
  const M = mesh.matrixWorld;
  const push = (x, y, z) => out.push(new THREE.Vector3(x, y, z).applyMatrix4(M));
  if (k === 'box') {
    const n = (l) => Math.max(2, Math.ceil(l / step) + 1);
    const [w, h, d] = [p.width, p.height, p.depth];
    const nx = n(w), ny = n(h), nz = n(d);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let l = 0; l < nz; l++) {
      if (!(i === 0 || i === nx - 1 || j === 0 || j === ny - 1 || l === 0 || l === nz - 1)) continue;
      push(-w / 2 + (w * i) / (nx - 1), -h / 2 + (h * j) / (ny - 1), -d / 2 + (d * l) / (nz - 1));
    }
  } else if (k === 'cyl') {
    const r = Math.max(p.radiusTop, p.radiusBottom);
    const na = Math.max(8, Math.ceil((2 * Math.PI * r) / step));
    const ny = Math.max(2, Math.ceil(p.height / step) + 1);
    for (let j = 0; j < ny; j++) {
      const t = j / (ny - 1);
      const y = -p.height / 2 + p.height * t;
      const rr = p.radiusBottom + (p.radiusTop - p.radiusBottom) * t;
      for (let a = 0; a < na; a++) push(rr * Math.cos((a / na) * Math.PI * 2), y, rr * Math.sin((a / na) * Math.PI * 2));
    }
  } else if (k === 'tube') {
    const curve = p.path;
    const len = curve.getLength();
    const n = Math.max(8, Math.ceil(len / step));
    for (let i = 0; i <= n; i++) {
      const c = curve.getPointAt(i / n);
      for (const [dx, dy, dz] of [[0, p.radius, 0], [0, -p.radius, 0], [p.radius, 0, 0], [-p.radius, 0, 0], [0, 0, p.radius], [0, 0, -p.radius]]) push(c.x + dx, c.y + dy, c.z + dz);
    }
  } else if (k === 'sphere') {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 3) push(pos.getX(i), pos.getY(i), pos.getZ(i));
  } else if (k === 'torus') {
    const nu = Math.max(16, Math.ceil((2 * Math.PI * p.radius) / step)), nv = 8;
    for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) {
      const u = (a / nu) * Math.PI * 2, v = (b / nv) * Math.PI * 2, rr = p.radius + p.tube * Math.cos(v);
      push(rr * Math.cos(u), rr * Math.sin(u), p.tube * Math.sin(v));
    }
  }
  return out;
}

// 점이 메시 부피 안에 있는가 (월드 좌표 점). margin 이 음수면 안쪽으로 좁혀(관통), 양수면 바깥으로 넓혀(맞닿음) 본다
function within(mesh, wp, inv, margin) {
  const k = kindOf(mesh);
  const p = mesh.geometry.parameters;
  if (k === 'tube') {
    const curve = p.path;
    const n = 60;
    let best = Infinity;
    for (let i = 0; i <= n; i++) best = Math.min(best, curve.getPointAt(i / n).distanceTo(wp));
    return best < p.radius + margin;
  }
  const q = wp.clone().applyMatrix4(inv);
  if (k === 'box') return Math.abs(q.x) < p.width / 2 + margin && Math.abs(q.y) < p.height / 2 + margin && Math.abs(q.z) < p.depth / 2 + margin;
  if (k === 'cyl') {
    if (Math.abs(q.y) >= p.height / 2 + margin) return false;
    const t = Math.min(1, Math.max(0, (q.y + p.height / 2) / p.height));
    const rr = p.radiusBottom + (p.radiusTop - p.radiusBottom) * t;
    return Math.hypot(q.x, q.z) < rr + margin;
  }
  if (k === 'sphere') return q.length() < p.radius + margin;
  if (k === 'torus') return Math.hypot(Math.hypot(q.x, q.y) - p.radius, q.z) < p.tube + margin;
  return false;
}
const inside = (mesh, wp, inv) => within(mesh, wp, inv, -TOL);

function visibleChain(o) { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; }

// 조립체 이름: 이 루트들의 바로 아래 자식 하나가 설비 하나다
function assemblyOf(obj, roots) {
  let o = obj;
  while (o.parent && !roots.has(o.parent)) o = o.parent;
  return o;
}

function label(o) {
  if (o.name) return o.name;
  const p = o.getWorldPosition(new THREE.Vector3());
  return `${o.type}@(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`;
}

// 설비 관통 검사. 바닥 판(패드)처럼 '위에 올려놓는' 것은 floor 표시로 빼고, 건물 외피는 검사하지 않는다.
export function checkOverlaps(factory, { include = () => true } = {}) {
  factory.scene.updateMatrixWorld(true);
  const roots = new Set([factory.scene, factory.bays.group, factory.cableGroup, factory.dynamic, factory.robots.group]);
  const items = [];
  factory.scene.traverse((m) => {
    if (!m.isMesh || !kindOf(m) || !visibleChain(m)) return;
    if (m.userData.shell || m.userData.floor || m.userData.fx) return;
    for (let x = m; x; x = x.parent) if (x.userData.shell || x === factory.robots.group) return;
    const asm = m.parent === factory.rack.group || m.parent?.parent === factory.rack.group ? factory.rack.group : assemblyOf(m, roots);
    if (!include(m, asm)) return;
    const box3 = new THREE.Box3().setFromObject(m);
    items.push({ m, asm, box3, inv: m.matrixWorld.clone().invert(), pts: null });
  });
  const hits = new Map();
  // 케이블 양 끝(설비에 꽂히는 접점) 근처는 관통으로 보지 않는다
  const nearEnd = (it, q) => it.m.userData.cableEnds?.some((e) => e.distanceTo(q) < 0.4);
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    const A = items[a], B = items[b];
    if (A.asm === B.asm) continue;
    // 바닥판(패드) 위에 세운 것은 '올려놓은' 것이다. 패드끼리 포개진 경우만 겹침으로 본다
    if (!!A.m.userData.pad !== !!B.m.userData.pad) continue;
    if (!A.box3.intersectsBox(B.box3)) continue;
    A.pts ??= samples(A.m); B.pts ??= samples(B.m);
    const inAB = A.pts.filter((q) => !nearEnd(A, q) && !nearEnd(B, q) && inside(B.m, q, B.inv));
    const inBA = B.pts.filter((q) => !nearEnd(A, q) && !nearEnd(B, q) && inside(A.m, q, A.inv));
    const pts = [...inAB, ...inBA];
    if (!pts.length) continue;
    const c = pts.reduce((s, q) => s.add(q), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const key = `${label(A.asm)} × ${label(B.asm)}`;
    const prev = hits.get(key);
    const entry = { pair: key, a: `${label(A.m)}`, b: `${label(B.m)}`, at: [c.x, c.y, c.z].map((v) => +v.toFixed(2)), n: pts.length };
    if (!prev) hits.set(key, { ...entry, parts: 1 });
    else { prev.parts += 1; prev.n += pts.length; }
  }
  return [...hits.values()].sort((x, y) => y.n - x.n);
}

// ── 장비 이동 모의 실행: 기록의 이벤트를 하나씩 넘기며(재생과 같은 간격 규칙) 장비를 움직이고, 매 걸음 확인한다 ──
//  · 장비끼리 몸체가 겹친 순간  · 장비 몸체가 설비 메시 안으로 들어간 순간  · 끝까지 목표에 닿지 못한 장비(교착)
export function simulateRobots(factory, events, buildState, { speed = 1, gapScale = 1, settle = 6, fps = 60, staticEvery = 6 } = {}) {
  const R = factory.robots;
  const dt = 1 / fps;
  const res = { speed, gapScale, overlaps: [], statics: [], stuck: [], maxWait: 0, waits: 0, backoffs: 0 };
  const statics = staticMeshes(factory);
  const seen = new Set();
  const check = (cursor, t) => {
    const all = [...R.ru, ...R.dc];
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) {
      if (overlap(all[a].body(), all[b].body(), -0.005)) {
        const k = `${all[a].kind}${all[a].i}-${all[b].kind}${all[b].i}@${cursor}`;
        if (!seen.has(k)) { seen.add(k); res.overlaps.push({ cursor, t: +t.toFixed(2), a: `${all[a].kind}-${'ABCD'[all[a].i]}`, b: `${all[b].kind}-${'ABCD'[all[b].i]}`, at: [all[a].group.position.x, all[a].group.position.z].map((v) => +v.toFixed(2)) }); }
      }
      res.maxWait = Math.max(res.maxWait, all[a].waited || 0, all[b].waited || 0);
    }
  };
  const checkStatic = (cursor) => {
    factory.scene.updateMatrixWorld(true);
    for (const v of [...R.ru, ...R.dc]) for (const hit of robotVsStatic(v, statics)) {
      const k = `${v.kind}${v.i}-${hit}`;
      if (!seen.has(k)) { seen.add(k); res.statics.push({ cursor, robot: `${v.kind}-${'ABCD'[v.i]}`, mesh: hit, at: [v.group.position.x, v.group.position.z].map((x) => +x.toFixed(2)) }); }
    }
  };
  let t = 0;
  factory.update(buildState(events, 0), { snap: true });
  for (let c = 0; c < events.length; c++) {
    factory.update(buildState(events, c), { snap: false });
    const a = events[c - 1], b = events[c];
    const gap = c === events.length - 1 ? settle : Math.min(1.2, Math.max(0.12, b.t - (a?.t ?? b.t))) * gapScale / speed;
    const steps = Math.max(1, Math.round(gap * fps));
    for (let s = 0; s < steps; s++) {
      R.tick(dt, speed); t += dt; check(c, t);
      if (s % staticEvery === 0) checkStatic(c);
    }
  }
  checkStatic(events.length - 1);
  for (const v of [...R.ru, ...R.dc]) if (v.path) res.stuck.push({ robot: `${v.kind}-${'ABCD'[v.i]}`, at: [v.group.position.x, v.group.position.z].map((x) => +x.toFixed(2)), waited: +(v.waited || 0).toFixed(2), blocker: v.blocker ? `${v.blocker.kind}-${'ABCD'[v.blocker.i]}` : null });
  res.waits = R.stats.waits; res.backoffs = R.stats.backoffs;
  return res;
}

// 시점 건너뛰기: 모든 시점에서 바로 놓인 자리끼리 겹치지 않는지
export function checkSnaps(factory, events, buildState) {
  const R = factory.robots;
  const out = [];
  const statics = staticMeshes(factory);
  for (let c = 0; c < events.length; c++) {
    factory.update(buildState(events, c), { snap: true });
    factory.scene.updateMatrixWorld(true);
    const all = [...R.ru, ...R.dc];
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) if (overlap(all[a].body(), all[b].body(), 0.02)) out.push({ cursor: c, a: `${all[a].kind}-${'ABCD'[all[a].i]}`, b: `${all[b].kind}-${'ABCD'[all[b].i]}` });
    for (const v of all) for (const hit of robotVsStatic(v, statics)) out.push({ cursor: c, robot: `${v.kind}-${'ABCD'[v.i]}`, mesh: hit });
  }
  return out;
}

function staticMeshes(factory) {
  factory.scene.updateMatrixWorld(true);
  const list = [];
  factory.scene.traverse((m) => {
    if (!m.isMesh || !kindOf(m) || !visibleChain(m)) return;
    for (let x = m; x; x = x.parent) if (x.userData.shell || x === factory.robots.group || x === factory.dynamic || x === factory.cableGroup) return;
    if (m.userData.fx) return;
    list.push(m);
  });
  return list.map((m) => ({ m, box3: new THREE.Box3().setFromObject(m), inv: m.matrixWorld.clone().invert() }));
}

// 장비 몸체(섀시·범퍼·데크)의 표면 점이 설비 메시 안에 있는지
function robotVsStatic(v, statics) {
  const parts = []; v.group.traverse((c) => { if (c.isMesh && c.geometry.type === 'BoxGeometry' && c.geometry.parameters.width >= 0.8) parts.push(c); });
  const hits = [];
  for (const part of parts) {
    part.updateMatrixWorld(true);
    const pb = new THREE.Box3().setFromObject(part);
    const pts = samples(part, 0.1);
    for (const s of statics) {
      if (!pb.intersectsBox(s.box3)) continue;
      if (pts.some((q) => inside(s.m, q, s.inv))) hits.push(label(s.m.parent?.name ? s.m.parent : s.m));
    }
  }
  return [...new Set(hits)];
}

// 같은 높이에서 겹친 윗면(깜빡이는 면) 찾기: 컨베이어 윗판끼리 같은 높이로 포개진 곳
export function coplanarBelts(factory) {
  factory.scene.updateMatrixWorld(true);
  const tops = [];
  factory.scene.traverse((m) => { if (m.userData.beltTop && visibleChain(m)) tops.push(m); });
  const out = [];
  for (let i = 0; i < tops.length; i++) for (let j = i + 1; j < tops.length; j++) {
    const A = tops[i], B = tops[j];
    const a = new THREE.Box3().setFromObject(A), b = new THREE.Box3().setFromObject(B);
    if (!a.intersectsBox(b)) continue;
    const ya = a.max.y, yb = b.max.y;
    const inv = B.matrixWorld.clone().invert();
    const pts = samples(A, 0.1).filter((q) => Math.abs(q.y - ya) < 1e-3).filter((q) => { const l = q.clone().applyMatrix4(inv); const p = B.geometry.parameters; return Math.abs(l.x) < p.width / 2 && Math.abs(l.z) < p.depth / 2; });
    if (pts.length && Math.abs(ya - yb) < 0.02) out.push({ a: label(A.parent), b: label(B.parent), y: +ya.toFixed(3), n: pts.length });
  }
  return out;
}

// 떠 있는 물체 찾기: 바닥(y≈0)에 닿은 메시에서 출발해, 맞닿은(간격 EPS 이내) 메시를 차례로 이어 간다.
// 끝까지 이어지지 않는 메시는 어디에도 받쳐지거나 붙어 있지 않은 것이다.
// 움직이는 장비·화물·효과는 빼고, 평면(바닥 표시·표지판)은 따로 모아 돌려준다.
export function checkFloating(factory, { eps = 0.05, dynamic = false } = {}) {
  factory.scene.updateMatrixWorld(true);
  const solids = [], planes = [];
  factory.scene.traverse((m) => {
    if (!m.isMesh || !visibleChain(m) || m.userData.fx) return;
    for (let x = m; x; x = x.parent) if (x === factory.robots.group || (!dynamic && x === factory.dynamic)) return;
    const box3 = new THREE.Box3().setFromObject(m);
    if (!kindOf(m)) { planes.push({ m, box3 }); return; }
    solids.push({ m, box3, wide: box3.clone().expandByScalar(eps), inv: m.matrixWorld.clone().invert(), pts: null, ok: box3.min.y <= eps });
  });
  const pts = (it) => (it.pts ??= samples(it.m, 0.1));
  const touches = (a, b) => {
    if (!a.wide.intersectsBox(b.box3)) return false;
    if (pts(a).some((q) => within(b.m, q, b.inv, eps))) return true;
    // 반대 방향(작은 물체 위에 큰 물체가 얹힌 경우). 관이나 아주 큰 면은 점이 너무 많아 건너뛴다
    if (kindOf(a.m) === 'tube') return false;
    const sizeB = b.box3.getSize(new THREE.Vector3());
    if (sizeB.x * sizeB.y + sizeB.y * sizeB.z + sizeB.x * sizeB.z > 400) return false;
    return pts(b).some((q) => within(a.m, q, a.inv, eps));
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const a of solids) {
      if (a.ok) continue;
      if (solids.some((b) => b.ok && b !== a && touches(a, b))) { a.ok = true; changed = true; }
    }
  }
  const where = (b) => { const c = b.getCenter(new THREE.Vector3()); return [c.x, b.min.y, c.z].map((v) => +v.toFixed(2)); };
  const owner = (m) => { const names = []; for (let x = m.parent; x && x !== factory.scene; x = x.parent) if (x.name) names.push(x.name); return names.join(' < ') || '(장면)'; };
  return {
    floating: solids.filter((s) => !s.ok).map((s) => ({ mesh: label(s.m), kind: kindOf(s.m), in: s.m.parent === factory.dynamic ? '(움직이는 화물)' : owner(s.m), bottomAt: where(s.box3), size: s.box3.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)) })),
    raisedPlanes: planes.filter((p) => p.box3.min.y > 0.25).map((p) => ({ mesh: label(p.m), in: owner(p.m), at: where(p.box3), sign: p.m.renderOrder === 2 })),
  };
}

// 기록의 모든 시점에서(바로 놓기) 화물·지시서·보고서까지 넣어 떠 있는 것을 모은다. 크기가 같은 것은 한 종류로 묶는다
export function scanFloating(factory, events, buildState) {
  const seen = new Map();
  for (let c = 0; c < events.length; c++) {
    factory.update(buildState(events, c), { snap: true });
    for (const f of checkFloating(factory, { dynamic: true }).floating) {
      const key = `${f.in}|${f.kind}|${f.size.join('x')}`;
      const prev = seen.get(key);
      if (!prev) seen.set(key, { ...f, firstAt: c, count: 1, gapMin: f.bottomAt[1] });
      else { prev.count += 1; }
    }
  }
  return [...seen.values()];
}
