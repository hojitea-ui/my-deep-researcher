// 이벤트 배열 → 화면 상태. 실제 실행과 기록 재생이 같은 함수를 쓴다.
// 어느 시점으로 이동하든 0번부터 그 시점까지 다시 접어서 계산하므로 병렬 상태와 3D가 늘 같은 값을 본다.

export const NODE_ORDER = ['plan', 'dispatch', 'researcher', 'review', 'synthesize', 'evaluate'];
export const NODE_LABEL = {
  plan: '① 기획', dispatch: '② 배치', researcher: '③ 조사',
  review: '④ 점검', synthesize: '⑤ 종합', evaluate: '⑥ 평가',
};
export const BAY_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
export const STEP_LABEL = { plan: '목차 짜기', read: '문서 읽기', pick: '다음 문서 고르기', write: '원고 쓰기', edit: '머리말·맺음말' };

export function buildState(events, cursor) {
  const s = {
    run: null, nodes: {}, active: null, round: 1, plan: null, sections: {},
    coord: { plan: 0, edit: 0 }, docs: {}, reviews: [], dispatches: [],
    report: null, metrics: null, ended: false, error: null, summary: null,
    callStart: {}, cursor: -1, event: null,
  };
  for (const n of NODE_ORDER) s.nodes[n] = { state: 'idle', count: 0 };
  const end = Math.min(cursor, events.length - 1);
  for (let i = 0; i <= end; i++) apply(s, events[i]);
  s.cursor = end;
  s.event = end >= 0 ? events[end] : null;
  return s;
}

function section(s, n) {
  if (!(n in s.sections)) {
    s.sections[n] = {
      n, letter: BAY_LETTERS[n] ?? String(n), 절: '', 역할: '', 시작문서: '', 지시: '', 피하기: [], 예산: 0,
      status: 'idle', round: 1, reads: [], current: null, charsIn: 0, docChars: 0,
      drafts: [], thread: null, calls: 0, dispatched: false,
    };
  }
  return s.sections[n];
}

function apply(s, e) {
  const d = e.data || {};
  switch (e.type) {
    case 'run_start':
      s.run = { ...d, ts: e.ts };
      for (const doc of d.코퍼스?.문서 ?? []) s.docs[doc.제목] = { chars: doc.글자수, links: doc.링크, reads: [] };
      break;
    case 'node_start': {
      const node = s.nodes[e.node];
      node.state = 'active';
      node.count += 1;
      s.active = e.node;
      if (e.node === 'researcher') {
        const x = section(s, e.section);
        x.status = 'working';
        x.round = e.round;
        x.thread = e.thread;
      } else if (e.node === 'dispatch' || e.node === 'review') {
        // 새 바퀴가 시작되면 뒤 단계는 다시 기다리는 상태가 된다
        if (e.node === 'dispatch') { s.nodes.researcher.state = 'idle'; s.nodes.review.state = 'idle'; }
      }
      break;
    }
    case 'node_end':
      if (e.node === 'researcher') {
        section(s, e.section).status = 'done';
        const busy = Object.values(s.sections).some((x) => x.status === 'working');
        if (!busy) s.nodes.researcher.state = 'done';
      } else {
        s.nodes[e.node].state = 'done';
      }
      break;
    case 'plan_done':
      s.plan = { 제목: d.제목, 목차: d.목차 };
      d.목차.forEach((t, i) => {
        const x = section(s, i);
        Object.assign(x, { 절: t.절, 역할: t.역할, 시작문서: t.시작문서, 예산: t.예산, 지시: t.지시 });
      });
      break;
    case 'dispatch':
      s.round = d.바퀴;
      s.dispatches.push(d);
      for (const a of d.배정) {
        const x = section(s, a.번호);
        Object.assign(x, { 피하기: a.피하기, round: d.바퀴, status: 'dispatched', current: null, dispatched: true, 예산: a.예산, lastStep: null });
        if (d.바퀴 > 1) x.시작문서지금 = a.시작문서;
      }
      break;
    case 'researcher_start':
      Object.assign(section(s, e.section), { 지시: d.지시 });
      break;
    case 'llm_start':
      s.callStart[d.call] = e.seq;
      if (e.section == null) {
        if (d.step === 'plan') s.coord.plan += d.chars_in;
        if (d.step === 'edit') s.coord.edit += d.chars_in;
      } else {
        const x = section(s, e.section);
        x.charsIn += d.chars_in;
        x.calls += 1;
        x.current = { step: d.step, doc: d.doc ?? null, call: d.call, seq: e.seq };
        x.lastStep = d.step; // 호출과 호출 사이에도 로봇이 하던 일을 유지하게 마지막 단계를 남긴다
        if (d.step === 'read') x.lastDoc = d.doc ?? null;
        if (d.step === 'read' && d.doc && s.docs[d.doc]) {
          s.docs[d.doc].reads.push({ section: e.section, round: e.round, done: false, call: d.call });
        }
      }
      break;
    case 'llm_end':
      if (e.section != null) {
        const x = section(s, e.section);
        if (d.step === 'read') {
          x.reads.push({ doc: d.doc, chars: d.doc_chars, round: e.round });
          x.docChars += d.doc_chars ?? 0;
          const r = s.docs[d.doc]?.reads.find((v) => v.call === d.call);
          if (r) r.done = true;
        }
        if (d.step === 'pick') x.lastPick = d.picked ?? null;
        x.current = null;
      }
      break;
    case 'llm_error':
      s.error = d.error;
      break;
    case 'draft': {
      const x = section(s, e.section);
      x.drafts.push({
        round: d.바퀴, 글자: d.본문.length, 인용: d.인용.length, 충분: d.충분, 부족: d.부족,
        본문: d.본문, 읽은문서: d.읽은문서,
      });
      x.status = 'drafted';
      break;
    }
    case 'review':
      s.reviews.push(d);
      break;
    case 'report':
      s.report = { 글자수: d.글자수, 본문: d.본문 };
      break;
    case 'metrics':
      s.metrics = d;
      break;
    case 'run_end':
      s.ended = true;
      s.summary = d;
      s.active = null;
      break;
    case 'run_error':
      s.ended = true;
      s.error = d.error;
      s.active = null;
      break;
    default:
      break;
  }
}

// 이벤트 한 줄 요약 (로그 목록용)
export function describe(e) {
  const d = e.data || {};
  const who = e.section != null ? `${BAY_LETTERS[e.section] ?? e.section}` : '관제';
  switch (e.type) {
    case 'run_start': return `실행 시작 · ${d.모드} · ${d.질문}`;
    case 'node_start': return `${NODE_LABEL[e.node]} 시작${e.section != null ? ` · 구역 ${who}` : ''}`;
    case 'node_end': return `${NODE_LABEL[e.node]} 끝${e.section != null ? ` · 구역 ${who}` : ''}`;
    case 'plan_done': return `목차 ${d.목차.length}절 · ${d.제목}`;
    case 'dispatch': return `${d.바퀴}바퀴 배치 · 리서처 ${d.배정.length}명`;
    case 'researcher_start': return `구역 ${who} 출발 · 시작 «${d.시작문서 || '자율'}»`;
    case 'llm_start': return `${who} ▸ ${STEP_LABEL[d.step] ?? d.step}${d.doc ? ` «${d.doc}»` : ''} · 입력 ${fmt(d.chars_in)}자`;
    case 'llm_end': return `${who} ◂ ${STEP_LABEL[d.step] ?? d.step} 응답${d.step === 'pick' ? ` → ${d.picked ? `«${d.picked}»` : '그만 읽기'}` : ''} · ${d.ms}ms`;
    case 'llm_error': return `${who} 모델 호출 오류`;
    case 'draft': return `구역 ${who} 원고 ${d.본문.length}자 · 인용 ${d.인용.length}곳 · ${d.충분 ? '충분' : '부족'}`;
    case 'review': return `점검 ${d.바퀴}바퀴 · 부족 ${d.부족.length}절${d.인용확인 ? ` (인용 확인 ${Object.keys(d.인용확인_걸림 || {}).length}절)` : ''} → ${d.다음 === 'dispatch' ? '다시 배치' : '종합'}`;
    case 'report': return `보고서 ${fmt(d.글자수)}자`;
    case 'metrics': return `평가 · 근거 ${pct(d.근거비율)} · 허위 인용 ${d.허위인용}`;
    case 'run_end': return `실행 끝 · ${d.걸린초}초`;
    case 'run_error': return `실행 오류`;
    default: return e.type;
  }
}

export const fmt = (n) => (n ?? 0).toLocaleString('ko-KR');
export const pct = (x) => `${((x ?? 0) * 100).toFixed(1)}%`;
