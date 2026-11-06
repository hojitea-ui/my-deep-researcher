// 관제 화면: 실제 호출(SSE)과 기록 재생이 같은 이벤트 배열 → buildState → 3D·패널 순서로 그린다.
import { Factory } from './factory.js';
import { buildState, describe, NODE_ORDER, NODE_LABEL, BAY_LETTERS, STEP_LABEL, fmt, pct } from './state.js';

const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DEV = new URLSearchParams(location.search).has('dev');

// ── 식별자 규칙: 설비 · 연구자 · 문서 · 이벤트 ──
const FACILITY = {
  plan: 'CT-01', dispatch: 'CT-01', researcher: 'RS', review: 'QG-04', synthesize: 'SY-05', evaluate: 'MS-06',
};
const NODE_EN = { plan: 'PLAN', dispatch: 'DISPATCH', researcher: 'RESEARCH', review: 'REVIEW', synthesize: 'SYNTHESIS', evaluate: 'MEASURE' };
const NODE_KO = { plan: '기획', dispatch: '배치', researcher: '조사', review: '점검', synthesize: '종합', evaluate: '평가' };
const ICON = {
  plan: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M5 5.5h6M5 8h6M5 10.5h3"/>',
  dispatch: '<circle cx="3.5" cy="8" r="1.5"/><path d="M5 8h3M8 8l3-4h2.5M8 8l3 4h2.5M8 8h5.5"/>',
  researcher: '<path d="M9.5 2H3v12h5"/><path d="M9.5 2l2.5 2.5V8"/><circle cx="11" cy="11" r="2.2"/><path d="M12.6 12.6l1.9 1.9"/>',
  review: '<path d="M2.5 14V4.5L8 2l5.5 2.5V14"/><path d="M5.5 8.5l2 2 3.5-4"/>',
  synthesize: '<path d="M2 3h3.5L9 8h5M2 13h3.5L9 8M2 8h7"/>',
  evaluate: '<path d="M2.5 11a5.5 5.5 0 0 1 11 0"/><path d="M8 11l2.8-3.4"/><path d="M2 13.5h12"/>',
  doc: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 8h4M6 10.5h4"/>',
};
const icon = (k) => `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${ICON[k]}</svg>`;
const rsId = (n) => `RS-${BAY_LETTERS[n] ?? n}`;
const evId = (seq) => `EV-${String(seq).padStart(4, '0')}`;
const pad = (n, w) => String(n).padStart(w, '0');

// ── 단계: 탐색·읽기 = 데이터(Cyan) / 기획·배치·작성·점검·종합·평가 = 상태(Blue) / 부족·재조사·오류 = 예외(Orange) ──
const STAGE = {
  search: ['탐색', 'data'], read: ['읽기', 'data'], write: ['작성', 'state'], filed: ['제출', 'neutral'],
  short: ['부족 신고', 'warn'], reinvest: ['재조사', 'warn'], plan: ['기획', 'state'], dispatch: ['배치', 'state'],
  review: ['점검', 'state'], synth: ['종합', 'state'], measure: ['평가', 'state'], run: ['실행', 'neutral'], node: ['조사', 'neutral'], fault: ['오류', 'warn'],
};
function stageOf(e) {
  const d = e.data || {};
  if (e.type === 'llm_error' || e.type === 'run_error') return 'fault';
  if (e.type === 'llm_start' || e.type === 'llm_end') return { pick: 'search', read: 'read', write: 'write', plan: 'plan', edit: 'synth' }[d.step] ?? 'run';
  if (e.type === 'draft') return d.충분 ? 'filed' : 'short';
  if (e.type === 'review') return d.부족?.length ? 'short' : 'review';
  if (e.type === 'dispatch') return d.바퀴 > 1 ? 'reinvest' : 'dispatch';
  if (e.type === 'researcher_start') return (e.round ?? 1) > 1 ? 'reinvest' : 'dispatch';
  if (e.type === 'plan_done') return 'plan';
  if (e.type === 'report') return 'synth';
  if (e.type === 'metrics') return d.허위인용 ? 'fault' : 'measure';
  if (e.type === 'node_start' || e.type === 'node_end') {
    if (e.node === 'researcher') return (e.round ?? 1) > 1 ? 'reinvest' : 'node';
    return { plan: 'plan', dispatch: 'dispatch', review: 'review', synthesize: 'synth', evaluate: 'measure' }[e.node] ?? 'run';
  }
  return 'run';
}
const stageGroup = (e) => STAGE[stageOf(e)][1];
function stageChip(e) {
  const [label, g] = STAGE[stageOf(e)];
  const r2 = (e.round ?? 1) > 1 && e.section != null ? '<span class="r2">R2</span>' : '';
  return `${r2}<span class="stg g-${g}">${label}</span>`;
}
function bayStage(x) {
  const d = x.drafts.at(-1);
  if (x.status === 'working') return { pick: 'search', read: 'read', write: 'write' }[x.current?.step] ?? 'node';
  if (d && d.충분 === false) return 'short';
  if (d) return 'filed';
  return x.dispatched ? 'dispatch' : 'run';
}
const bayChip = (x) => { const [label, g] = STAGE[bayStage(x)]; return `${x.round > 1 ? '<span class="r2">R2</span>' : ''}<span class="stg g-${g}">${label}</span>`; };

function actor(e) {
  if (e.section != null) return rsId(e.section);
  if (e.node) return FACILITY[e.node];
  return 'SYS';
}

const app = {
  status: null, events: [], cursor: -1, mode: 'idle', runId: null, follow: true,
  playing: false, speed: 1, es: null, timer: null, streaming: false, tab: 'events', st: null,
  docFilter: 'all', selDoc: null, docCache: {}, selUnit: null, prevBay: {},
};

const tipEl = $('#tip');
const factory = new Factory($('#stage'), {
  onHover: (h) => {
    if (!h) { tipEl.style.display = 'none'; return; }
    tipEl.textContent = h.text;
    tipEl.style.display = 'block';
    tipEl.style.left = `${Math.min(h.x + 14, innerWidth - 330)}px`;
    tipEl.style.top = `${h.y + 14}px`;
  },
  onPick: (pick) => { if (pick?.doc) selectDoc(pick.doc, { switchTab: true }); else if (pick?.unit) selectUnit(pick.unit, { switchTab: true }); },
});

function updateInsets() {
  const vis = (sel) => { const el = $(sel); return el && getComputedStyle(el).display !== 'none' ? el.getBoundingClientRect() : null; };
  const l = vis('#left'), r = vis('#right'), b = vis('#timeline');
  factory.setInsets({ left: l ? l.right : 0, right: r ? innerWidth - r.left : 0, top: 112, bottom: b ? innerHeight - b.top : 0 });
}
addEventListener('resize', updateInsets);

// ── 코퍼스 문서 목록 (실행 기록에 남은 코퍼스가 우선, 없으면 현재 설정의 코퍼스) ──
function corpusDocs(st = app.st) {
  return st?.run?.코퍼스?.문서 ?? app.status?.corpus?.문서 ?? [];
}
function docId(title, st = app.st) {
  const i = corpusDocs(st).findIndex((d) => d.제목 === title);
  return i >= 0 ? `DOC-${pad(i + 1, 3)}` : 'DOC-———';
}

// 3D 위에 올렸을 때 나오는 설명 (상태에서 바로 만든다)
factory.tips = {
  doc: (title) => {
    const st = app.st; const doc = st?.docs[title];
    const chars = doc?.chars ?? corpusDocs().find((d) => d.제목 === title)?.글자수;
    const readers = [...new Set((doc?.reads ?? []).map((r) => rsId(r.section)))];
    return `${docId(title)} · «${title}»\n${fmt(chars)}자 · 약 ${fmt(Math.round((chars ?? 0) / 2))} 토큰\n${readers.length ? `읽은 구역: ${readers.join(' · ')}` : '아직 아무도 안 읽음'}\n(클릭하면 문서 상세)`;
  },
  bay: (i) => {
    const s = app.st?.sections[i];
    if (!s) return `${rsId(i)} 연구 구역 · 배정 전`;
    return `${rsId(i)} 연구 구역 · ${s.역할}\n«${s.절}»\n읽은 문서 ${s.reads.length}/${s.예산}: ${s.reads.map((r) => r.doc).join(', ') || '-'}\n읽은 원문 ${fmt(s.docChars)}자 → 원고 ${fmt(s.drafts.at(-1)?.글자 ?? 0)}자`;
  },
  draft: (i, k) => { const d = app.st?.sections[i]?.drafts[k]; return d ? `${rsId(i)} 원고 · ${d.round}바퀴\n${d.글자}자 · 인용 ${d.인용}곳 · ${d.충분 ? '충분' : `부족: ${d.부족}`}` : ''; },
  tower: () => `CT-01 관제탑 · 코디네이터\n① 기획: 목차·역할·시작 문서 배정\n② 배치: 작업 지시서와 피하기 목록 발행\n코디네이터가 본 글자 ${fmt((app.st?.coord.plan ?? 0) + (app.st?.coord.edit ?? 0))}자`,
  gate: () => { const r = app.st?.reviews.at(-1); return `QG-04 품질 검사 게이트\n${r ? `${r.바퀴}바퀴 · 부족 신고 ${r.부족.length}절 → ${r.다음 === 'dispatch' ? '다시 배치' : '종합'}` : '아직 검사 전'}`; },
  syn: () => `SY-05 종합 설비 · 편집자\n절 원고를 순서대로 잇고 머리말·맺음말만 새로 쓴다${app.st?.report ? `\n보고서 ${fmt(app.st.report.글자수)}자` : ''}`,
  station: () => { const m = app.st?.metrics; return m ? `MS-06 계측 스테이션\n근거 비율 ${pct(m.근거비율)} · 허위 인용 ${m.허위인용}\n읽고 안 쓴 ${m.읽고안쓴문서}건 · 편중 ${pct(m.편중)} · 중복 ${pct(m.중복률)}` : 'MS-06 계측 스테이션\n보고서 대기'; },
  report: () => `보고서 ${fmt(app.st?.report?.글자수)}자`,
  robot: (i, kind) => {
    const r = (kind === 'RU' ? factory.robots.ru : factory.robots.dc).find((x) => x.i === i);
    const L = BAY_LETTERS[i];
    return `${kind}-${L} · ${kind === 'RU' ? 'Research Unit' : 'Document Carrier'}\n연구 구역 ${L} 소속\n${r?.label ?? '대기'}\n(클릭하면 설비 상세)`;
  },
  rack: () => { const c = app.st?.run?.코퍼스 ?? app.status?.corpus; return c ? `WH-00 자동 창고 · 코퍼스\n문서 ${c.문서수}건 · ${fmt(c.글자수)}자 · 창의 ${c.창배수}배` : 'WH-00 자동 창고'; },
};

// ── 렌더 ──
let rafPending = false; let pendingSnap = false;
function scheduleRender(snap) { pendingSnap ||= snap; if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; const s = pendingSnap; pendingSnap = false; render(s); }); }

function render(snap = false) {
  const st = buildState(app.events, app.cursor);
  app.st = st;
  factory.speed = app.playing ? app.speed : 1;
  factory.update(st, { snap, status: app.status });
  factory.highlightDoc(app.selDoc);
  renderSystem(st);
  renderLeft(st);
  renderRight(st);
  renderTimeline(st);
}

function renderSystem(st) {
  const box = $('#modeBox');
  box.className = `stat ${app.mode}`;
  $('#modeText').textContent = app.mode === 'live' ? `실제 호출${app.streaming ? ' · 수신 중' : st.ended ? ' · 완료' : ''}`
    : app.mode === 'replay' ? `저장된 기록 재생${st.run?.모드 && st.run.모드 !== '실제 호출' ? ` (${st.run.모드})` : ''}`
      : '대기 · 실행 없음';
  const led = $('#sysLed');
  const [cls, text] = st.error ? ['warn', 'FAULT'] : app.streaming ? ['online live', 'RUNNING'] : app.mode === 'replay' ? ['done', 'REPLAY'] : st.ended ? ['done', 'COMPLETE'] : ['online', 'ONLINE'];
  led.className = `led ${cls}`;
  led.textContent = text;
  $('#modelText').textContent = st.run?.모델 ?? app.status?.model ?? '—';
}

function sec(no, title, meta = '') {
  return `<div class="sec"><span><b>${no}</b> / ${title}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</div>`;
}

function renderLeft(st) {
  const run = st.run;
  const s = app.status;
  const corpus = run?.코퍼스 ?? s?.corpus;
  const settings = run?.설정 ?? s?.settings ?? {};
  const win = run?.창토큰 ?? s?.window_tokens ?? 128000;
  const tpc = run?.글자당토큰 ?? (s ? 1 / s.chars_per_token : 0.5);
  const h = [];

  h.push(sec('02.1', 'Run · 실행', esc(app.runId ?? 'NO RUN')));
  h.push(`<div class="hero">${esc(run?.질문 ?? '연구 질문을 입력하거나 기록을 불러오세요')}</div>`);
  h.push(`<dl class="kv"><dt>Domain</dt><dd>${esc(run?.도메인이름 ?? s?.domain_name ?? '—')}</dd>
    <dt>Config</dt><dd class="num">절 ≤${settings.max_sections ?? '—'} · 예산 ${settings.budget ?? '—'}건 · 바퀴 ≤${settings.max_rounds ?? '—'}</dd></dl>`);

  h.push(sec('02.2', 'Pipeline · 공정', `R${st.round} / ${settings.max_rounds ?? 2}`));
  h.push('<div class="flow">');
  NODE_ORDER.forEach((n, i) => {
    const state = st.nodes[n].state;
    const led = state === 'active' ? '<span class="led active">ACTIVE</span>' : state === 'done' ? '<span class="led done">DONE</span>' : '<span class="led">WAIT</span>';
    h.push(`<div class="step ${state}"><span class="dot"></span><span class="no">${pad(i + 1, 2)}</span><span class="nm" title="${NODE_EN[n]}">${icon(n)}${NODE_KO[n]}<span>${FACILITY[n] === 'RS' ? 'RS-A~' : FACILITY[n]}</span></span>${led}</div>`);
  });
  h.push('</div>');

  if (corpus) {
    const ratio = corpus.추정토큰 / win;
    const inside = Math.min(1, 1 / Math.max(ratio, 1));
    h.push(sec('02.3', 'Corpus · 코퍼스', `WH-00 · ${corpus.문서수} DOCS`));
    h.push(`<div class="bignum"><b class="num">${fmt(corpus.글자수)}</b><span>자</span><b class="num" style="margin-left:12px">${corpus.창배수}×</b><span>창</span></div><div class="small">약 <span class="num">${fmt(corpus.추정토큰)}</span> 토큰 · 링크 <span class="num">${corpus.링크수}</span></div>
      <div class="meter" title="모델 창 ${fmt(win)} 토큰 대비"><b style="width:${(inside * 100).toFixed(1)}%"></b>${ratio > 1 ? `<b class="over" style="width:${((1 - inside) * 100).toFixed(1)}%"></b>` : ''}<span class="edge" style="left:${(inside * 100).toFixed(1)}%"></span></div>
      <div class="small">모델 창(<span class="num">${fmt(win)}</span> 토큰)의 <b class="num" style="color:var(--ink)">${corpus.창배수}×</b> ${ratio > 1 ? '— 한 번에 다 읽을 수 없어요' : '— 창 안에 들어가요'}</div>`);
  }

  const secs = Object.values(st.sections);
  if (run) {
    const coord = st.coord.plan + st.coord.edit;
    const max = Math.max(coord, ...secs.map((x) => x.charsIn), 1);
    h.push(sec('02.4', 'Isolation · 격리', '본 글자 수'));
    h.push('<div class="iso">');
    h.push(`<div class="row"><span class="id fac">CT-01</span><div class="meter"><b style="width:${(coord / max * 100).toFixed(1)}%"></b></div><span class="v">${fmt(coord)}</span></div>`);
    for (const x of secs) h.push(`<div class="row"><span class="id">${rsId(x.n)}</span><div class="meter"><b class="ice" style="width:${(x.charsIn / max * 100).toFixed(1)}%"></b></div><span class="v">${fmt(x.charsIn)}</span></div>`);
    h.push('</div><div class="small" style="margin-top:6px">코디네이터는 카드와 원고 첫머리만, 리서처는 자기 구역 원문만 봐요.</div>');
  }

  h.push(sec('02.5', 'Bays · 연구 구역', secs.length ? `${secs.filter((x) => x.status === 'working').length} ACTIVE` : 'IDLE'));
  if (!secs.length) h.push('<div class="small">① 기획이 목차를 짜면 구역마다 절이 배정돼요.</div>');
  const readCount = {};
  for (const x of secs) for (const r of x.reads) readCount[r.doc] = (readCount[r.doc] ?? 0) + 1;
  for (const x of secs) {
    const d = x.drafts.at(-1);
    const working = x.status === 'working';
    const short = d && d.충분 === false;
    const ratio = (x.docChars * tpc) / win;
    const cur = x.current ? `${STEP_LABEL[x.current.step] ?? x.current.step}${x.current.doc ? ` «${x.current.doc}»` : ''}` : '';
    const led = working ? '<span class="led active live">RUNNING</span>' : short ? '<span class="led warn">SHORT</span>' : d ? '<span class="led done">FILED</span>' : x.dispatched ? '<span class="led">QUEUED</span>' : '<span class="led">IDLE</span>';
    const now = !x.dispatched ? '배치 전' : working ? (cur || '작업 중') : d ? (d.충분 ? `원고 제출 · ${d.round}바퀴` : `부족 신고 — ${d.부족}`) : '출발 대기';
    const bkey = `${x.status}|${x.current?.step ?? ''}|${x.drafts.length}|${x.reads.length}|${x.round}`;
    const flash = app.prevBay[x.n] && app.prevBay[x.n] !== bkey ? 'flash' : '';
    app.prevBay[x.n] = bkey;
    h.push(`<div class="bay ${working ? 'active' : ''} ${short ? 'short' : ''} ${flash}" data-unit="${rsId(x.n)}">
      <div class="hd"><span class="tag">${rsId(x.n)}</span><span class="role" style="display:flex;align-items:center;gap:6px">${icon('researcher')}${esc(x.역할)}</span>${led}</div>
      <div class="ttl">${esc(x.절)}</div>
      <div class="now ${short ? 'warn' : ''}">${bayChip(x)}${esc(now)}</div>
      <div class="stats3"><div><span class="lbl">Read</span><b>${x.reads.length}/${x.예산}</b></div><div><span class="lbl">Window</span><b>${(ratio * 100).toFixed(1)}%</b></div><div><span class="lbl">Draft</span><b>${d ? fmt(d.글자) : '—'}</b></div></div>
      <div class="chips">${x.reads.map((r) => `<button class="chip ${readCount[r.doc] > 1 ? 'dup' : ''}" data-doc="${esc(r.doc)}" title="${r.round}바퀴 · ${fmt(r.chars)}자">${esc(r.doc)}</button>`).join('')}</div>
    </div>`);
  }

  const m = st.metrics;
  if (m) {
    h.push(sec('02.6', 'Metrics · 평가', 'MS-06 · 정답표 없음'));
    h.push(`<div class="metrics">
      <div class="metric"><span class="lbl">M1 Grounding</span><b>${pct(m.근거비율)}</b><span>근거 비율 ${m.근거문장}/${m.문장수}</span></div>
      <div class="metric ${m.허위인용 ? 'alarm' : ''}"><span class="lbl">M2 Fake Cite</span><b>${m.허위인용}</b><span>허위 인용 · 0이어야 함</span></div>
      <div class="metric"><span class="lbl">M3 Unused</span><b>${m.읽고안쓴문서}</b><span>읽고 안 쓴 문서</span></div>
      <div class="metric"><span class="lbl">M4 Concentration</span><b>${pct(m.편중)}</b><span>편중 · «${esc(m.최다인용.문서)}»</span></div>
      <div class="metric wide"><span class="lbl">M5 Overlap</span><b>${pct(m.중복률)}</b><span>중복률 · 읽기 ${m.읽기수}회 · 서로 다른 문서 ${m.서로다른문서}건</span></div></div>`);
  }
  if (st.error) h.push(sec('!!', 'Fault') + `<div class="small" style="color:var(--orange)">${esc(st.error)}</div>`);
  $('#leftBody').innerHTML = h.join('');
}


// ── 설비 상세: 3D 에서 설비를 누르면 여기로 온다. 역할명은 실행 기록(코디네이터 목차)에서만 읽는다 ──
const UNIT_NAME = { 'WH-00': '자동 창고', 'CT-01': '관제탑', 'QG-04': '검사 게이트', 'SY-05': '종합 설비', 'MS-06': '계측 스테이션' };
function unitList(st) {
  const secs = Object.values(st.sections);
  const n = secs.length || st.run?.설정?.max_sections || app.status?.settings?.max_sections || 4;
  const bays = Array.from({ length: n }, (_, i) => rsId(i));
  return ['WH-00', 'CT-01', ...bays, 'QG-04', 'SY-05', 'MS-06'];
}
function unitState(st, u) {
  const nd = st.nodes;
  if (u.startsWith('RS-')) {
    const x = st.sections[BAY_LETTERS.indexOf(u.slice(3))];
    if (!x) return ['', 'IDLE', '배정 전'];
    const [label, g] = STAGE[bayStage(x)];
    return [g === 'warn' ? 'warn' : x.status === 'working' ? 'active live' : x.drafts.length ? 'done' : '', g === 'warn' ? 'SHORT' : x.status === 'working' ? 'RUNNING' : x.drafts.length ? 'FILED' : 'IDLE', `${x.절 || '연구 구역'} · ${label}`];
  }
  const map = { 'CT-01': nd.plan.state === 'active' || nd.dispatch.state === 'active' ? 'active' : st.plan ? 'done' : '', 'QG-04': nd.review.state, 'SY-05': nd.synthesize.state, 'MS-06': nd.evaluate.state };
  if (u === 'WH-00') { const r = Object.values(st.sections).filter((x) => x.current?.step === 'read').length; return [r ? 'active live' : '', r ? 'ISSUE' : 'STORED', r ? `문서 반출 ${r}건` : '보관 중']; }
  const s = map[u];
  const warn = (u === 'QG-04' && st.reviews.at(-1)?.다음 === 'dispatch' && !st.report) || (u === 'MS-06' && st.metrics?.허위인용);
  return [warn ? 'warn' : s === 'active' ? 'active live' : s === 'done' ? 'done' : '', warn ? 'ALERT' : s === 'active' ? 'RUNNING' : s === 'done' ? 'DONE' : 'IDLE', UNIT_NAME[u]];
}
function renderUnits(st) {
  const rows = unitList(st).map((u) => {
    const [cls, led, sub] = unitState(st, u);
    const name = u.startsWith('RS-') ? `연구 구역 ${u.slice(3)}` : UNIT_NAME[u];
    return `<div class="doc unit ${app.selUnit === u ? 'sel' : ''}" data-unit="${u}"><span class="utag ${cls.includes('warn') ? 'warn' : cls.includes('active') ? 'on' : ''}">${u}</span><span class="nm">${esc(name)}<small class="sub">${esc(sub)}</small></span><span class="led ${cls}">${led}</span></div>`;
  });
  const key = `${app.cursor}:${app.selUnit}:${app.events.length}`;
  if ($('#unitList').dataset.key !== key) { $('#unitList').dataset.key = key; $('#unitList').innerHTML = rows.join(''); }
  $('#unitDetail').innerHTML = unitDetailHtml(st, app.selUnit);
}
function recentEvents(st, u, k = 8) {
  const evs = app.events.slice(0, st.cursor + 1).filter((e) => actor(e) === u || (u === 'WH-00' && e.type === 'llm_start' && e.data.step === 'read'));
  return evs.slice(-k).reverse().map((e) => `<button class="chip evchip" data-seek="${e.seq}">${stageChip(e)}${evId(e.seq)} · ${esc(describe(e).slice(0, 34))}</button>`).join('') || '<span class="small">아직 이벤트가 없어요</span>';
}
function unitDetailHtml(st, u) {
  if (!u) return '<div class="small">3D 공장의 설비를 누르거나 목록에서 고르면 상세가 나와요.</div>';
  const win = st.run?.창토큰 ?? app.status?.window_tokens ?? 128000;
  const tpc = st.run?.글자당토큰 ?? 0.5;
  const h = [sec('04.1', 'Unit Spec', u)];
  if (u.startsWith('RS-')) {
    const x = st.sections[BAY_LETTERS.indexOf(u.slice(3))];
    h.push(`<div class="h1" style="display:flex;align-items:center;gap:8px">${icon('researcher')}${esc(x?.절 || `연구 구역 ${u.slice(3)}`)}</div>`);
    if (!x) return h.join('') + '<div class="small">① 기획이 목차를 짜면 이 구역에 절이 배정돼요.</div>';
    const d = x.drafts.at(-1);
    const ratio = (x.docChars * tpc) / win;
    h.push(`<table class="spec">
      <tr><th>Stage</th><td>${bayChip(x)}</td></tr>
      <tr><th>Role</th><td>${esc(x.역할 || '—')}</td></tr>
      <tr><th>Round</th><td class="num">R${x.round}${x.thread ? ` · 스레드 ${esc(x.thread)}` : ''}</td></tr>
      <tr><th>Start Doc</th><td>${x.시작문서 ? `<button class="chip" data-doc="${esc(x.시작문서)}">${esc(x.시작문서)}</button>` : '자율'}</td></tr>
      <tr><th>Avoid</th><td class="num">${x.피하기.length}건</td></tr>
      <tr><th>Window</th><td><div class="meter" style="margin:3px 0"><b style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></b></div><span class="num">${fmt(x.docChars)}자 · 창의 ${(ratio * 100).toFixed(1)}%</span></td></tr>
      ${factory.robots.handles(BAY_LETTERS.indexOf(u.slice(3))) ? `<tr><th>Robot</th><td><span class="utag">RU-${u.slice(3)}</span> ${esc(factory.robots.ru.find((r) => r.i === BAY_LETTERS.indexOf(u.slice(3)))?.label ?? '—')}</td></tr><tr><th>Carrier</th><td><span class="utag">DC-${u.slice(3)}</span> ${esc(factory.robots.dc.find((r) => r.i === BAY_LETTERS.indexOf(u.slice(3)))?.label ?? '—')}</td></tr>` : ''}
      <tr><th>Draft</th><td>${d ? `<span class="num">${fmt(d.글자)}자 · 인용 ${d.인용}곳</span> · ${d.충분 ? '충분' : `<span style="color:var(--orange);font-weight:600">부족 — ${esc(d.부족)}</span>`}` : '—'}</td></tr>
    </table>`);
    h.push(sec('04.2', 'Reads', `${x.reads.length}/${x.예산}`) + `<div class="chips">${x.reads.map((r) => `<button class="chip data" data-doc="${esc(r.doc)}">R${r.round} · ${esc(r.doc)}</button>`).join('') || '<span class="small">아직 읽은 문서가 없어요</span>'}</div>`);
  } else if (u === 'CT-01') {
    h.push(`<div class="h1">${icon('plan')} 관제탑 · 코디네이터</div><table class="spec">
      <tr><th>Title</th><td>${esc(st.plan?.제목 ?? '—')}</td></tr>
      <tr><th>Sections</th><td class="num">${st.plan?.목차.length ?? 0}절 · ${st.round}바퀴</td></tr>
      <tr><th>Seen</th><td class="num">기획 ${fmt(st.coord.plan)}자 · 편집 ${fmt(st.coord.edit)}자</td></tr></table>`);
    if (st.plan) h.push(sec('04.2', 'Table of Contents') + st.plan.목차.map((t, i) => `<div class="small" style="margin:4px 0"><span class="utag">${rsId(i)}</span> ${esc(t.절)} · ${esc(t.역할)} · 시작 «${esc(t.시작문서 || '자율')}»</div>`).join(''));
  } else if (u === 'QG-04') {
    h.push(`<div class="h1">${icon('review')} 검사 게이트 · ④ 점검</div>`);
    h.push(st.reviews.length ? st.reviews.map((r) => `<table class="spec"><tr><th>Round</th><td class="num">R${r.바퀴}</td></tr><tr><th>Short</th><td>${r.부족.length ? r.부족.map((n) => `<span class="utag warn">${rsId(n)}</span> ${esc(r.사유[n] ?? '')}`).join('<br>') : '없음'}</td></tr><tr><th>Next</th><td>${r.다음 === 'dispatch' ? '<span style="color:var(--orange);font-weight:600">반송 → 재조사</span>' : '통과 → 종합'}</td></tr></table>`).join('') : '<div class="small">아직 검사 전이에요.</div>');
  } else if (u === 'SY-05') {
    h.push(`<div class="h1">${icon('synthesize')} 종합 설비 · 편집자</div><table class="spec"><tr><th>Report</th><td class="num">${st.report ? `${fmt(st.report.글자수)}자` : '—'}</td></tr><tr><th>Seen</th><td class="num">원고 첫머리 ${fmt(st.coord.edit)}자</td></tr></table>`);
  } else if (u === 'MS-06') {
    const m = st.metrics;
    h.push(`<div class="h1">${icon('evaluate')} 계측 스테이션 · ⑥ 평가</div>`);
    h.push(m ? `<table class="spec"><tr><th>M1</th><td class="num">근거 ${pct(m.근거비율)}</td></tr><tr><th>M2</th><td class="num" ${m.허위인용 ? 'style="color:var(--orange);font-weight:700"' : ''}>허위 인용 ${m.허위인용}</td></tr><tr><th>M3</th><td class="num">읽고 안 쓴 ${m.읽고안쓴문서}건</td></tr><tr><th>M4</th><td class="num">편중 ${pct(m.편중)}</td></tr><tr><th>M5</th><td class="num">중복 ${pct(m.중복률)}</td></tr></table>` : '<div class="small">보고서가 나오면 계측해요.</div>');
  } else if (u === 'WH-00') {
    const c = st.run?.코퍼스 ?? app.status?.corpus;
    h.push(`<div class="h1">${icon('doc')} 자동 창고 · 코퍼스</div>`);
    if (c) h.push(`<table class="spec"><tr><th>Docs</th><td class="num">${c.문서수}건 · ${fmt(c.글자수)}자</td></tr><tr><th>Window</th><td class="num">창의 ${c.창배수}배</td></tr><tr><th>Links</th><td class="num">${c.링크수}개 · 0개 문서 ${c.나가는링크0?.length ?? 0}건</td></tr></table>`);
  }
  h.push(sec('04.3', 'Recent Events', '최근') + `<div class="chips col">${recentEvents(st, u)}</div>`);
  return h.join('');
}
function selectUnit(u, { switchTab = false } = {}) {
  app.selUnit = u;
  if (switchTab) showTab('units');
  render(false);
}

// ── 우측: 이벤트 · 설비 · 문서 · 보고서 ──
function evKind(e) {
  const d = e.data || {};
  if (e.type === 'node_start' || e.type === 'node_end') return 'k-node';
  if (e.type === 'draft') return d.충분 ? 'k-draft' : 'k-warn';
  if (e.type === 'review' && d.부족?.length) return 'k-warn';
  if (e.type.endsWith('error')) return 'k-warn';
  return '';
}

let lastLogKey = '';
function renderRight(st) {
  $('#cntEv').textContent = app.events.length ? `· ${app.events.length}` : '';
  $('#cntDoc').textContent = corpusDocs(st).length ? `· ${corpusDocs(st).length}` : '';
  const key = `${app.events.length}:${app.cursor}`;
  if (key !== lastLogKey) {
    lastLogKey = key;
    const rows = app.events.map((e) => `<div class="ev ${evKind(e)} ${e.seq === app.cursor ? 'cur' : ''} ${e.seq > app.cursor ? 'future' : ''}" data-g="${stageGroup(e)}" data-seq="${e.seq}"><span class="i">${evId(e.seq)}</span><span class="t">+${e.t.toFixed(1)}</span><span class="who ${e.section == null ? 'ct' : ''}">${actor(e)}</span><span class="d">${stageChip(e)}${esc(describe(e))}</span></div>`);
    const log = $('#log');
    log.innerHTML = rows.join('') || '<div class="small" style="padding:12px 14px">실행을 시작하거나 저장된 기록을 불러오세요.</div>';
    log.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }
  $('#detail').innerHTML = detailHtml(st);
  renderUnits(st);
  renderDocs(st);
  $('#report').innerHTML = reportHtml(st);
}

function detailHtml(st) {
  const e = st.event;
  if (!e) return '<div class="small">선택한 이벤트가 없어요.</div>';
  const d = e.data || {};
  const h = [sec('03.1', 'Event Spec', evId(e.seq)),
    `<table class="spec">
      <tr><th>Stage</th><td>${stageChip(e)}</td></tr>
      <tr><th>Type</th><td class="num">${esc(e.type)}</td></tr>
      <tr><th>Node</th><td>${e.node ? `${NODE_LABEL[e.node]} · <span class="num">${NODE_EN[e.node]}</span>` : '실행'}</td></tr>
      <tr><th>Actor</th><td class="num">${actor(e)}${e.section != null ? ` · 절 ${e.section}` : ''}</td></tr>
      <tr><th>Thread</th><td class="num">${esc(e.thread)}</td></tr>
      <tr><th>Round</th><td class="num">${e.round ?? '—'}</td></tr>
      <tr><th>Time</th><td class="num">${esc(e.ts)} · T+${e.t.toFixed(3)}s</td></tr>
    </table>`];
  if (e.type === 'llm_start' || e.type === 'llm_end') {
    const start = e.type === 'llm_end' ? app.events[st.callStart[d.call]] : e;
    const sd = start?.data ?? {};
    h.push(`<table class="spec"><tr><th>Step</th><td>${esc(STEP_LABEL[d.step] ?? d.step)}${d.doc ? ` · <button class="chip" data-doc="${esc(d.doc)}">${esc(d.doc)}</button>` : ''}</td></tr>
      <tr><th>Call</th><td class="num">CALL-${pad(d.call, 3)}</td></tr>
      <tr><th>Input</th><td class="num">${fmt(sd.chars_in)}자</td></tr>
      ${e.type === 'llm_end' ? `<tr><th>Output</th><td class="num">${fmt(d.chars_out)}자 · ${d.ms}ms</td></tr>` : ''}</table>`);
    h.push(sec('03.2', 'Prompt · System') + `<pre class="code">${esc(sd.system)}</pre>`);
    h.push(sec('03.3', 'Prompt · User') + `<pre class="code">${esc(sd.user)}</pre>`);
    h.push(e.type === 'llm_end' ? sec('03.4', 'Response') + `<pre class="code reply">${esc(d.reply)}</pre>` : '<div class="small">응답 대기 — 다음 단계에서 응답이 와요.</div>');
  } else {
    h.push(sec('03.2', 'Payload') + `<pre class="code">${esc(JSON.stringify(d, null, 2))}</pre>`);
  }
  return h.join('');
}

function docReaders(st, title) {
  const out = [];
  for (const x of Object.values(st.sections)) for (const r of x.reads) if (r.doc === title) out.push({ n: x.n, round: r.round });
  return out;
}

function renderDocs(st) {
  const docs = corpusDocs(st);
  const maxChars = Math.max(1, ...docs.map((d) => d.글자수));
  const rows = [];
  docs.forEach((d, i) => {
    const readers = docReaders(st, d.제목);
    const f = app.docFilter;
    if (f === 'read' && !readers.length) return;
    if (f === 'unread' && readers.length) return;
    if (f === 'dup' && new Set(readers.map((r) => r.n)).size < 2) return;
    const tags = readers.length ? [...new Set(readers.map((r) => rsId(r.n)))].map((t) => `<i>${t}</i>`).join('') : '<i class="unread">—</i>';
    rows.push(`<div class="doc ${readers.length ? '' : 'unread-row'} ${app.selDoc === d.제목 ? 'sel' : ''}" data-doc="${esc(d.제목)}"><span class="id">DOC-${pad(i + 1, 3)}</span><span class="nm">${esc(d.제목)}<small style="width:${(d.글자수 / maxChars * 100).toFixed(1)}%"></small></span><span class="rd">${tags}</span></div>`);
  });
  const key = `${docs.length}:${app.docFilter}:${app.selDoc}:${app.cursor}`;
  if ($('#docList').dataset.key !== key) {
    $('#docList').dataset.key = key;
    $('#docList').innerHTML = rows.join('') || '<div class="small" style="padding:12px 14px">해당하는 문서가 없어요.</div>';
  }
  $('#docDetail').innerHTML = docDetailHtml(st);
}

function docDetailHtml(st) {
  const title = app.selDoc;
  if (!title) return '<div class="small">문서를 고르거나 3D 창고의 화물을 누르면 상세가 나와요.</div>';
  const meta = corpusDocs(st).find((d) => d.제목 === title);
  const info = app.docCache[cacheKey(title)];
  const readers = docReaders(st, title);
  const cites = st.report ? (st.report.본문.match(new RegExp(`«${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}»`, 'g')) ?? []).length : null;
  const firstRead = (n) => app.events.find((e) => e.type === 'llm_start' && e.data.step === 'read' && e.data.doc === title && e.section === n);
  const h = [sec('04.1', 'Document Spec', docId(title, st)), `<div class="h1" style="display:flex;align-items:center;gap:8px">${icon('doc')}${esc(title)}</div>`,
    `<table class="spec">
      <tr><th>Chars</th><td class="num">${fmt(meta?.글자수)}자 · 약 ${fmt(Math.round((meta?.글자수 ?? 0) / 2))} 토큰</td></tr>
      <tr><th>Links</th><td class="num">코퍼스 안 ${meta?.링크?.length ?? 0}개</td></tr>
      <tr><th>Read by</th><td>${readers.length ? readers.map((r) => { const ev = firstRead(r.n); return `<button class="chip" data-seek="${ev?.seq ?? ''}">${rsId(r.n)} · R${r.round}${ev ? ` · ${evId(ev.seq)}` : ''}</button>`; }).join(' ') : '<span class="small">아직 아무도 안 읽음</span>'}</td></tr>
      <tr><th>Cited</th><td class="num">${cites == null ? '보고서 전' : `보고서 인용 ${cites}곳`}</td></tr>
      ${info?.관련어밀도 != null ? `<tr><th>Relevance</th><td class="num">주제 관련어 1만 자당 ${info.관련어밀도}회</td></tr>` : ''}
    </table>`];
  if (meta?.링크?.length) h.push(sec('04.2', 'Links', `${meta.링크.length}`) + `<div class="chips">${meta.링크.map((l) => `<button class="chip" data-doc="${esc(l)}">${esc(l)}</button>`).join('')}</div>`);
  h.push(sec('04.3', 'Excerpt', '본문 앞부분'));
  h.push(info ? `<pre class="code">${esc(info.발췌)}${info.글자수 > info.발췌.length ? '\n…' : ''}</pre>` : '<div class="small">불러오는 중…</div>');
  return h.join('');
}

const cacheKey = (title) => `${app.st?.run?.도메인 ?? app.status?.domain ?? ''}::${title}`;
async function selectDoc(title, { switchTab = false } = {}) {
  app.selDoc = title;
  if (switchTab) showTab('docs');
  render(false);
  const key = cacheKey(title);
  if (!app.docCache[key]) {
    const domain = app.st?.run?.도메인 ?? '';
    const r = await fetch(`/api/doc?title=${encodeURIComponent(title)}${domain ? `&domain=${encodeURIComponent(domain)}` : ''}`);
    app.docCache[key] = r.ok ? await r.json() : { 발췌: '(본문을 불러오지 못했어요 — 이 기록의 코퍼스가 지금 설정과 다를 수 있어요)', 글자수: 0 };
    if (app.selDoc === title) $('#docDetail').innerHTML = docDetailHtml(app.st);
  }
}

// ── 보고서 받기: 지금 보고 있는 시점의 이벤트 상태로 MD 파일을 만든다(서버·모델 호출 없음) ──
const pctText = (v) => `${(v * 100).toFixed(1)}%`;
const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const reportFileName = (st) => `report-${st.run?.run_id ?? app.runId ?? 'run'}.md`;

function reportMarkdown(st) {
  const run = st.run ?? {};
  const set = run.설정 ?? {};
  const body = st.report.본문.trim();
  const [title, rest] = body.startsWith('# ') ? [body.split('\n', 1)[0], body.slice(body.indexOf('\n') + 1).trim()] : [`# ${run.질문 ?? '보고서'}`, body];
  const t = run.ts ? new Date(run.ts) : null;
  const two = (n) => String(n).padStart(2, '0');
  const when = t ? `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}` : '—';
  const where = app.mode === 'replay' ? `저장된 기록 재생 화면 · ${evId(st.cursor)} 시점` : '실제 호출 화면';
  const meta = [
    `> **질문** ${run.질문 ?? '—'}`,
    `> **실행** ${run.run_id ?? '—'} · ${run.모드 ?? '—'} · ${when} · 모델 ${run.모델 ?? '—'}`,
    `> **설정** 절 최대 ${set.max_sections ?? '—'}개 · 절마다 문서 ${set.budget ?? '—'}건 · 최대 ${set.max_rounds ?? '—'}바퀴 · 다시 보내기 ${set.redispatch === false ? '꺼짐' : '켜짐'} · 인용 확인 ${set.check_citations ? '켜짐' : '꺼짐'}`,
    `> **받은 곳** Research Factory ${where}`,
  ];
  // 인용 블록 안의 줄을 빈 '>' 줄로 나눠, 뷰어가 한 문단으로 합치지 않게 한다
  const out = [title, '', meta.join('\n>\n'), '', '---', '', rest, '', '---', '', '## ⑥ 평가 지표', ''];
  const m = st.metrics;
  if (m) {
    const top = m.최다인용?.문서 ? ` («${m.최다인용.문서}» ${m.최다인용.곳}곳)` : '';
    const fake = m.허위인용문서?.length ? ` (${m.허위인용문서.map((d) => `«${d}»`).join(', ')})` : '';
    out.push(
      '| 지표 | 값 |', '|---|---|',
      `| 근거 비율 | ${pctText(m.근거비율)} (${m.문장수}문장 중 ${m.근거문장}문장) |`,
      `| 허위 인용 | ${m.허위인용}곳${cell(fake)} |`,
      `| 읽고 안 쓴 문서 | ${m.읽고안쓴문서}건${m.읽고안쓴목록?.length ? cell(` (${m.읽고안쓴목록.join(', ')})`) : ''} |`,
      `| 편중 | ${pctText(m.편중)}${cell(top)} |`,
      `| 중복률 | ${pctText(m.중복률)} (읽기 ${m.읽기수}번 · 서로 다른 문서 ${m.서로다른문서}건) |`,
      '', '정답표나 판정 모델 없이, 보고서와 실제로 읽은 기록만으로 센 값입니다.',
    );
  } else {
    out.push('⑥ 평가 전 시점에서 받은 파일이라 지표가 아직 없습니다.');
  }
  return out.join('\n') + '\n';
}

function downloadReport() {
  const st = app.st;
  if (!st?.report) return;
  const url = URL.createObjectURL(new Blob([reportMarkdown(st)], { type: 'text/markdown;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: reportFileName(st) });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportHtml(st) {
  const h = [];
  // 완성품 반출구: ⑤ 종합이 끝난 시점부터 받을 수 있다
  h.push(`<div class="dl"><button class="btn primary sm" data-act="md"${st.report ? '' : ' disabled'}>MD 받기</button><span class="small">${st.report
    ? `${esc(reportFileName(st))} · 보고서 ${fmt(st.report.글자수)}자${st.metrics ? ' · 지표 포함' : ' · ⑥ 평가 전'}`
    : app.events.some((e) => e.type === 'report') ? '아직 ⑤ 종합 전 시점이에요 · End 키로 끝으로 가면 받을 수 있어요'
    : '⑤ 종합이 끝나면 받을 수 있어요'}</span></div>`);
  const secs = Object.values(st.sections);
  h.push(sec('05.1', 'Section Ledger', '누가 무엇을 읽고 썼나'));
  if (!secs.length) h.push('<div class="small">아직 목차가 없어요.</div>');
  for (const x of secs) {
    h.push(`<div class="rsec"><div class="hd"><span class="tag id" style="padding:4px 6px;background:var(--gr);color:var(--on-dark)">${rsId(x.n)}</span><div><div style="font-weight:700;color:var(--ink)">${esc(x.절)}</div><div class="small">${esc(x.역할)} · 시작 «${esc(x.시작문서 || '자율')}» · 피하기 ${x.피하기.length}건</div></div></div>
      <div class="bd"><div class="chips">${x.reads.map((r) => `<button class="chip" data-doc="${esc(r.doc)}">${esc(r.doc)} · ${fmt(r.chars)}자</button>`).join('') || '<span class="small">읽은 문서 없음</span>'}</div>`);
    x.drafts.forEach((d) => h.push(`<div class="small" style="margin:8px 0 4px"><span class="num">R${d.round}</span> 원고 · ${d.글자}자 · 인용 ${d.인용}곳 · ${d.충분 ? '<span style="color:var(--ink)">충분</span>' : `<span style="color:var(--orange)">부족: ${esc(d.부족)}</span>`}</div><pre class="code">${esc(d.본문)}</pre>`));
    h.push('</div></div>');
  }
  h.push(sec('05.2', 'Final Report', st.report ? `${fmt(st.report.글자수)}자` : 'PENDING'));
  h.push(st.report ? `<pre class="code reply" style="max-height:none">${esc(st.report.본문)}</pre>` : '<div class="small">⑤ 종합이 끝나면 여기 나와요.</div>');
  return h.join('');
}

// ── 하단 타임라인 ──
const BAND_COLOR = { plan: '#bbc3c5', dispatch: '#bbc3c5', researcher: '#287cc2', review: '#8e999d', synthesize: '#d4d9da', evaluate: '#e7e9e7' };
function renderTimeline(st) {
  const n = app.events.length;
  const slider = $('#slider');
  slider.max = Math.max(0, n - 1);
  slider.value = Math.max(0, app.cursor);
  const e = st.event;
  $('#evNo').innerHTML = n ? `${evId(Math.max(0, app.cursor))} <em>/ ${pad(n - 1, 4)}</em>` : 'EV ——— <em>/ ———</em>';
  $('#evT').innerHTML = `<em>T+</em>${e ? e.t.toFixed(1).padStart(5, '0') : '——'}s`;
  $('#evDesc').innerHTML = e ? `${stageChip(e)}<b>${actor(e)}</b> · ${esc(describe(e))}` : '기록을 불러오거나 실행을 시작하세요';
  $('#past').style.width = n > 1 ? `${(app.cursor / (n - 1)) * 100}%` : '0';
  const play = $('#play');
  play.classList.toggle('on', app.playing);
  play.innerHTML = app.playing ? '<span><b>❚❚</b><small>HOLD</small></span>' : '<span><b>▶</b><small>RUN</small></span>';
  if ($('#bands').dataset.key === String(n)) return;
  $('#bands').dataset.key = String(n);
  const pos = (seq) => (n > 1 ? (seq / (n - 1)) * 100 : 0);
  const bands = []; const ticks = []; const labels = [];
  const open = {};
  for (const x of app.events) {
    if (x.type === 'node_start' && x.section == null) { open[x.node] = x.seq; ticks.push(`<span class="tick" style="left:${pos(x.seq)}%"></span>`); labels.push({ seq: x.seq, text: `${pad(NODE_ORDER.indexOf(x.node) + 1, 2)} ${NODE_EN[x.node]}` }); }
    if (x.type === 'node_end' && x.section == null && open[x.node] != null) { bands.push({ a: open[x.node], b: x.seq, node: x.node }); delete open[x.node]; }
  }
  // 조사 구간: 배치가 끝난 뒤부터 그 바퀴의 점검이 시작될 때까지
  const dispEnds = app.events.filter((x) => x.type === 'node_end' && x.node === 'dispatch');
  for (const d of dispEnds) {
    const rv = app.events.find((x) => x.seq > d.seq && x.type === 'node_start' && x.node === 'review');
    bands.push({ a: d.seq, b: rv ? rv.seq : n - 1, node: 'researcher' });
    labels.push({ seq: d.seq + 1, text: '03 RESEARCH' });
  }
  const alerts = app.events.filter((x) => (x.type === 'draft' && x.data.충분 === false) || (x.type === 'metrics' && x.data.허위인용 > 0) || x.type === 'run_error' || x.type === 'llm_error');
  $('#ticks').dataset.alerts = alerts.length;
  const alertHtml = alerts.map((x) => `<span class="alert" style="left:${pos(x.seq)}%" title="${evId(x.seq)} · ${esc(describe(x))}"></span>`).join('');
  $('#bands').innerHTML = bands.map((b) => `<span class="band" style="left:${pos(b.a)}%;width:${Math.max(0.4, pos(b.b) - pos(b.a))}%;background:${BAND_COLOR[b.node]}"></span>`).join('');
  $('#ticks').innerHTML = ticks.join('') + alertHtml;
  // 겹치는 라벨은 건너뛴다
  labels.sort((a, b) => a.seq - b.seq);
  let last = -100;
  $('#scale').innerHTML = labels.filter((l) => { const p = pos(l.seq); if (p - last < 8.5) return false; last = p; return true; })
    .map((l) => `<span style="left:${pos(l.seq)}%">${l.text}</span>`).join('');
}

// ── 이동 ──
function seek(i, snap = true) {
  if (!app.events.length) return;
  app.cursor = Math.max(0, Math.min(app.events.length - 1, i));
  app.follow = app.mode === 'live' && app.cursor === app.events.length - 1;
  render(snap);
}
const step = (k) => seek(app.cursor + k, false);
function nodeJump(dir) {
  const ev = app.events;
  for (let j = app.cursor + dir; j >= 0 && j < ev.length; j += dir) {
    const x = ev[j];
    if ((x.type === 'node_start' || x.type === 'node_end') && x.section == null) return seek(j, false);
    if (x.type === 'run_end' || x.type === 'run_error') return seek(j, false);
  }
  seek(dir > 0 ? ev.length - 1 : 0, false);
}

function play() {
  if (app.playing) return stopPlay();
  if (app.cursor >= app.events.length - 1) seek(0, true);
  app.playing = true;
  tick();
  render(false);
}
function stopPlay() { app.playing = false; clearTimeout(app.timer); renderTimeline(app.st ?? buildState(app.events, app.cursor)); }
function tick() {
  if (!app.playing) return;
  if (app.cursor >= app.events.length - 1) { if (!app.streaming) stopPlay(); else app.timer = setTimeout(tick, 300); return; }
  const a = app.events[app.cursor], b = app.events[app.cursor + 1];
  const gap = Math.min(1.2, Math.max(0.12, (b.t - (a?.t ?? b.t)))) * 1000 / app.speed;
  app.timer = setTimeout(() => { if (!app.playing) return; app.cursor += 1; render(false); tick(); }, gap);
}

// ── 실행 · 기록 ──
async function refreshStatus() {
  app.status = await (await fetch('/api/status')).json();
  const qs = app.status.questions ?? [];
  $('#qlist').innerHTML = [app.status.default_question, ...qs.map((q) => q.질문 ?? q.question ?? q)].filter((v, i, a) => v && a.indexOf(v) === i).map((q) => `<option value="${esc(q)}">`).join('');
  if (!$('#q').value) $('#q').value = app.status.default_question ?? '';
  const problems = app.status.problems ?? [];
  $('#run').disabled = problems.length > 0 || !!app.status.running;
  $('#run').title = problems.join(' · ') || '실제 OpenAI 호출로 연구를 시작해요';
  notice(problems.length ? `실제 호출 준비 중 — ${problems.join(' · ')}` : '');
}

async function refreshRuns() {
  const runs = await (await fetch(`/api/runs${DEV ? '?dev=1' : ''}`)).json();
  $('#runs').innerHTML = runs.length ? runs.map((r) => `<option value="${esc(r.id)}">${esc(r.id)} · ${esc(r.상태)} · ${esc(r.질문.slice(0, 24))}</option>`).join('') : '<option value="">저장된 기록 없음</option>';
  $('#load').disabled = !runs.length;
}

function notice(text) { $('#noticeText').textContent = text; $('#notice').style.display = text ? 'flex' : 'none'; }

async function startRun() {
  const question = $('#q').value.trim();
  if (!question) return notice('질문을 입력해 주세요');
  $('#run').disabled = true;
  const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
  const j = await r.json();
  if (!r.ok) { notice(j.error); await refreshStatus(); return; }
  notice('');
  attach(j.run_id);
}

function attach(id) {
  stopPlay();
  app.es?.close();
  Object.assign(app, { events: [], cursor: -1, mode: 'live', runId: id, follow: true, streaming: true, selDoc: null });
  lastLogKey = '';
  const es = new EventSource(`/api/stream/${id}`);
  app.es = es;
  es.addEventListener('ev', (m) => {
    app.events.push(JSON.parse(m.data));
    if (app.follow) app.cursor = app.events.length - 1;
    scheduleRender(false);
  });
  const done = async () => { es.close(); app.streaming = false; await refreshStatus(); await refreshRuns(); scheduleRender(false); };
  es.addEventListener('end', done);
  es.onerror = done;
  render(true);
}

async function loadRun(id) {
  if (!id) return;
  stopPlay();
  app.es?.close();
  const j = await (await fetch(`/api/runs/${id}`)).json();
  Object.assign(app, { events: j.events, mode: 'replay', runId: id, cursor: 0, follow: false, streaming: false, selDoc: null });
  lastLogKey = '';
  render(true);
}

function showTab(tab) {
  app.tab = tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === `v-${tab}`));
}

// ── 입력 ──
$('#run').onclick = startRun;
$('#load').onclick = () => loadRun($('#runs').value);
$('#first').onclick = () => seek(0, true);
$('#last').onclick = () => seek(app.events.length - 1, true);
$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);
$('#prevNode').onclick = () => nodeJump(-1);
$('#nextNode').onclick = () => nodeJump(1);
$('#play').onclick = play;
$('#speed').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  app.speed = Number(b.dataset.s);
  document.querySelectorAll('#speed button').forEach((x) => x.classList.toggle('on', x === b));
  factory.speed = app.playing ? app.speed : 1;
};
$('#slider').oninput = (e) => { const v = Number(e.target.value); stopPlay(); seek(v, true); };
$('#log').onclick = (e) => { const row = e.target.closest('.ev'); if (row) { stopPlay(); seek(Number(row.dataset.seq), true); } };
$('#docList').onclick = (e) => { const row = e.target.closest('.doc'); if (row) selectDoc(row.dataset.doc); };
$('#report').addEventListener('click', (e) => { if (e.target.closest('[data-act="md"]')) downloadReport(); });
$('#unitList').onclick = (e) => { const row = e.target.closest('.unit'); if (row) selectUnit(row.dataset.unit); };
$('#leftBody').addEventListener('click', (e) => { if (e.target.closest('.chip')) return; const card = e.target.closest('.bay[data-unit]'); if (card) selectUnit(card.dataset.unit, { switchTab: true }); });
$('#docFilters').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  app.docFilter = b.dataset.f;
  document.querySelectorAll('#docFilters button').forEach((x) => x.classList.toggle('on', x === b));
  render(false);
};
// 패널 어디서든 문서 칩을 누르면 문서 상세로, 이벤트 칩을 누르면 그 시점으로
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.dataset.doc) selectDoc(chip.dataset.doc, { switchTab: true });
  else if (chip.dataset.seek) { stopPlay(); showTab('events'); seek(Number(chip.dataset.seek), true); }
});
$('#tLeft').onclick = () => { document.body.classList.toggle('hide-left'); updateInsets(); };
$('#tRight').onclick = () => { document.body.classList.toggle('hide-right'); updateInsets(); };
$('#quality').onclick = (e) => { const q = factory.quality === 'high' ? 'low' : 'high'; factory.setQuality(q); e.target.textContent = q === 'high' ? 'GFX HI' : 'GFX LO'; };
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowRight') { stopPlay(); e.shiftKey ? nodeJump(1) : step(1); }
  else if (e.key === 'ArrowLeft') { stopPlay(); e.shiftKey ? nodeJump(-1) : step(-1); }
  else if (e.key === ' ') { e.preventDefault(); play(); }
  else if (e.key === 'Home') seek(0, true);
  else if (e.key === 'End') seek(app.events.length - 1, true);
});

// 3D 표지판은 캔버스에 글자를 그리므로, 글꼴을 직접 불러온 뒤 다시 그린다(실패해도 대체 글꼴로 그대로 동작)
Promise.allSettled(['700 20px "Pretendard Variable"', '800 20px "Pretendard Variable"', '600 20px "Pretendard Variable"', '700 20px "IBM Plex Mono"', '600 20px "IBM Plex Mono"']
  .map((f) => document.fonts?.load(f, '가A1'))).then(() => { factory.refreshSigns(); render(true); });

// 개발 확인용(?dev=1)에서만 내부 상태를 연다
if (DEV) {
  window.__rf = { app, factory, seek };
  import('./devcheck.js').then((m) => Object.assign(window.__rf, m)); // 설비 관통·장비 겹침 검사
}

(async () => {
  updateInsets();
  await refreshStatus();
  await refreshRuns();
  render(true);
  if (app.status.running) attach(app.status.running);
})();
