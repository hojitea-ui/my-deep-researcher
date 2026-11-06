"""6노드 딥리서처: pipeline.py(① 기획 → 리서처 → 종합, 3노드)를 고치지 않고 상속해서
② 배치 · ④ 점검(부족 신고한 절만 다시 보내기) · ⑥ 평가를 더한다.

    질문 → ① plan → ② dispatch ⇉ ③ researcher × N → ④ review ─(부족·바퀴 남음)→ ② dispatch
                                                          └────────────→ ⑤ synthesize → ⑥ evaluate

교안에서 확인한 규칙(장면 2·4·5):
- 리서처는 원고를 쓰는 호출 한 번에 '충분(예/아니요)'과 '부족(빈 곳 한 문장)'을 함께 적는다.
- ④ 점검은 '아니요'로 신고한 절만 ② 배치로 돌려보낸다. 최대 두 바퀴(1바퀴 모든 절, 2바퀴 부족한 절만).
- 다시 보낼 때 지난 원고와 부족 사유를 겨냥한 지시를 함께 보내고, 피하기 목록에 다른 절의 시작 문서와
  다른 절이 1바퀴에 실제로 읽은 문서를 넣는다.
- ④와 ⑤는 그 절의 마지막 원고만 쓴다.

사용자가 정한 규칙(2026-11-06):
- 2바퀴 시작 문서는 기본 지정 없음(자율 재탐색). 부족 사유에 코퍼스 문서 제목이 명확히 적혀 있고, 그 문서가
  피하기 목록에 없고 아직 아무도 읽지 않았을 때만 코드 규칙으로 지정한다. ②·④는 모델을 부르지 않는다.
- 2바퀴 리서처는 자기가 지난 바퀴에 읽은 문서를 다시 읽지 않는다(피하기 목록에 넣는다).
- 원고 프롬프트에 '질문·지시의 전제·인과관계는 자료로 확인된 만큼만 쓰고, 아니면 밝혀라'를 더한다.
pipeline.py의 기존 프롬프트는 그대로 쓰고, 신고 칸은 write_prompt 결과의 JSON 형식 줄만 늘려서 붙인다.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import wraps
from pathlib import Path
from typing import Any, Callable, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

import events
import pipeline
from metrics import evaluate_report
from pipeline import (
    MIN_SECTION_CHARS,
    Corpus,
    DeepResearch,
    Prompt,
    ResearchState,
    Section,
    Settings,
    Step,
    Task,
    parse_json_object,
    salvage_body,
    write_prompt,
)

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"

_OLD_JSON = 'JSON으로만: {"본문":"..."}'
_REPORT_RULE = (
    "질문과 지시에 담긴 전제·인과관계는 자료로 확인된 만큼만 쓰고, 자료가 뒷받침하지 않거나 다르게 말하면 "
    "그렇다고 밝혀라.\n"
    "지시를 모은 자료로 다 채웠으면 충분을 \"예\"로, 다 채우지 못했으면 \"아니요\"로 하고 "
    "부족에 무엇이 비었는지 한 문장으로 적어라.\n"
)
_NEW_JSON = 'JSON으로만: {"본문":"...","충분":"예 또는 아니요","부족":"빈 곳 한 문장 (충분이면 빈 문자열)"}'


def write_report_prompt(task: Task, notes: list[tuple[str, str]], prior: str, gap: str) -> Prompt:
    """pipeline.write_prompt 그대로 + 자기 신고 칸 두 개. 다시 맡긴 절이면 지난 원고와 부족 사유를 붙인다."""
    base = write_prompt(task, notes)
    if _OLD_JSON not in base.system:
        raise RuntimeError("pipeline.write_prompt 의 형식 줄이 바뀌었습니다")
    system = base.system.replace(_OLD_JSON, _REPORT_RULE + _NEW_JSON)
    user = base.user
    if prior:
        user += f"\n[지난 원고]\n{prior}\n[지난번에 부족했던 점] {gap or '(적힌 사유 없음)'}"
    return Prompt(system, user)


def redispatch_brief(brief: str, gap: str) -> str:
    return f"{brief} (다시 맡김: 지난 원고에서 부족했던 점은 '{gap or '사유 미기재'}'이다. 이 빈 곳을 채울 자료를 찾아라.)"


_HANGUL_OR_WORD = re.compile(r"[0-9A-Za-z가-힣]")


def titles_in(text: str, titles: list[str]) -> list[str]:
    """부족 사유에 그대로 적힌 코퍼스 문서 제목을 나온 순서대로 찾는다.

    «제목» 표기이거나, 제목 바로 앞이 글자가 아닐 때만 인정한다('차'가 '마차' 속에서 잡히지 않게).
    뒤에는 조사가 붙어도 된다. 긴 제목을 먼저 잡고, 그 안에 든 짧은 제목은 따로 세지 않는다.
    """
    taken: list[tuple[int, int, str]] = []
    for title in sorted((t for t in titles if len(t) >= 2), key=len, reverse=True):
        start = 0
        while (pos := text.find(title, start)) >= 0:
            start = pos + 1
            if pos > 0 and _HANGUL_OR_WORD.match(text[pos - 1]) and text[pos - 1] != "«":
                continue
            if any(a <= pos < b for a, b, _ in taken):
                continue
            taken.append((pos, pos + len(title), title))
    return [title for _, _, title in sorted(taken)]


def designate_seed(gap: str, titles: list[str], avoid: set[str], read_by_anyone: set[str]) -> tuple[str, dict[str, Any]]:
    """2바퀴 시작 문서 지정 — 코드 규칙만 쓴다(모델 호출 없음).

    부족 사유에 코퍼스 문서 제목이 명확히 적혀 있고, 그 문서가 피하기 목록에 없고 아직 아무도 읽지 않았을 때만
    지정한다. 조건을 채우는 제목이 여럿이면 사유에 먼저 나온 것을 쓴다. 아니면 지정하지 않고 자율 재탐색.
    """
    mentioned = titles_in(gap or "", titles)
    eligible = [t for t in mentioned if t not in avoid and t not in read_by_anyone]
    seed = eligible[0] if eligible else ""
    reason = (
        f"부족 사유에 적힌 «{seed}» 문서를 시작 문서로 지정" if seed
        else "사유에 적힌 문서 제목 없음 → 자율 재탐색" if not mentioned
        else "적힌 문서가 모두 피하기 목록에 있거나 이미 읽힘 → 자율 재탐색"
    )
    return seed, {"사유에서_찾은_제목": mentioned, "지정가능": eligible, "지정": seed or None, "설명": reason}


class Section6(Section):
    충분: bool
    부족: str
    바퀴: int
    시작문서: str


class State6(ResearchState):
    round: int
    outbox: list[dict[str, Any]]
    review_next: str
    metrics: dict[str, Any]
    flags: dict[int, dict[str, Any]]  # ④ 인용 확인에서 걸린 절 (check_citations 가 켜졌을 때만)


class Assignment6(TypedDict):
    question: str
    task: Task
    round: int
    prior: str
    gap: str


@dataclass(frozen=True)
class Settings6(Settings):
    redispatch: bool = True
    max_rounds: int = 2
    # 사용자가 더한 규칙(2026-11-07, 교안 밖·켜고 끔): ④ 점검이 자기 신고와 별도로 인용을 코드로 확인한다.
    # 원고가 아무도 읽지 않은 문서를 인용했거나 인용이 0곳이면 '충분' 신고여도 부족으로 보고 다시 보낸다.
    # 끄면(기본) 교안 규칙 그대로 — '아니요'로 신고한 절만 다시 보낸다.
    check_citations: bool = False


def citation_problems(cited: list[str], read_by_anyone: set[str]) -> dict[str, Any] | None:
    """④ 점검의 인용 확인(check_citations). ⑥ 평가의 허위 인용과 같은 잣대: 어느 절도 읽지 않은 문서."""
    unread = sorted({doc for doc in cited if doc not in read_by_anyone})
    if not cited:
        return {"인용0": True, "읽지않은인용": [], "설명": "[④ 점검] 원고에 «문서명» 인용이 하나도 없음"}
    if unread:
        names = ", ".join(f"«{doc}»" for doc in unread)
        return {"인용0": False, "읽지않은인용": unread, "설명": f"[④ 점검] 아무도 읽지 않은 문서를 인용함: {names}"}
    return None


def _node(name: str) -> Callable:
    """노드 진입·종료를 이벤트로 남긴다. 3D 설비는 이 이벤트에만 반응한다."""

    def decorate(method: Callable) -> Callable:
        @wraps(method)
        def wrapper(self: DeepResearch6, state: dict[str, Any]) -> dict[str, Any]:
            self.emit("node_start", name)
            out = method(self, state)
            self.emit("node_end", name, log=(out.get("log") or [""])[-1])
            return out

        return wrapper

    return decorate


@dataclass(frozen=True)
class DeepResearch6(DeepResearch):
    settings: Settings6 = field(default_factory=Settings6)
    bus: events.EventBus | None = None

    def emit(self, type_: str, node: str | None = None, **data: Any) -> None:
        if self.bus is not None:
            self.bus.emit(type_, node, **data)

    def build_graph(self):
        return (
            StateGraph(State6)
            .add_node("plan", self.plan6)
            .add_node("dispatch", self.dispatch)
            .add_node("researcher", self.researcher6, input_schema=Assignment6)
            .add_node("review", self.review)
            .add_node("synthesize", self.synthesize6)
            .add_node("evaluate", self.evaluate)
            .add_edge(START, "plan")
            .add_edge("plan", "dispatch")
            .add_conditional_edges("dispatch", self.fanout6, ["researcher", "review"])
            .add_edge("researcher", "review")
            .add_conditional_edges("review", lambda state: state["review_next"], ["dispatch", "synthesize"])
            .add_edge("synthesize", "evaluate")
            .add_edge("evaluate", END)
            .compile()
        )

    def run(self, question: str) -> dict[str, Any]:
        start: State6 = {
            "question": question,
            "plan": {"제목": question, "목차": [], "배치": []},
            "sections": [],
            "visited": [],
            "report": "",
            "log": [],
            "round": 1,
            "outbox": [],
            "review_next": "",
            "metrics": {},
            "flags": {},
        }
        return self.build_graph().invoke(start)

    # ① 기획 — pipeline.plan 그대로
    @_node("plan")
    def plan6(self, state: State6) -> dict[str, Any]:
        out = self.plan(state)
        self.emit("plan_done", "plan", 제목=out["plan"]["제목"], 목차=out["plan"]["목차"])
        return out

    # ② 배치 — 코드만. 1바퀴는 모든 절, 2바퀴는 ④가 고른 절만
    @_node("dispatch")
    def dispatch(self, state: State6) -> dict[str, Any]:
        plan, rnd = state["plan"], state["round"]
        outbox: list[dict[str, Any]] = []
        notes: dict[int, dict[str, Any]] = {}
        for index in plan["배치"]:
            if rnd == 1:
                task = self._task(plan["목차"], index)
                prior = gap = ""
            else:
                task, prior, gap, notes[index] = self._retask(plan["목차"], index, state["sections"], state.get("flags") or {})
            outbox.append({"question": state["question"], "task": task, "round": rnd, "prior": prior, "gap": gap})
        self.emit(
            "dispatch", "dispatch", 바퀴=rnd,
            배정=[
                {**{k: a["task"][k] for k in ("번호", "절", "역할", "시작문서", "예산", "피하기")},
                 **({"시작문서_판단": notes[a["task"]["번호"]]} if a["task"]["번호"] in notes else {})}
                for a in outbox
            ],
        )
        return {"outbox": outbox, "log": [f"② 배치   {rnd}바퀴 · 리서처 {len(outbox)}명 동시 출발"]}

    def fanout6(self, state: State6) -> list[Send] | str:
        if not state["outbox"]:
            return "review"
        return [Send("researcher", Assignment6(**assignment)) for assignment in state["outbox"]]

    def _retask(
        self, toc: list[Any], index: int, sections: list[Section6], flags: dict[int, dict[str, Any]],
    ) -> tuple[Task, str, str, dict[str, Any]]:
        """2바퀴 재배정. 지난 원고와 부족 사유는 늘 보낸다. 시작 문서는 기본 자율, 규칙에 맞을 때만 지정한다.

        피하기 목록 = 다른 절의 시작 문서 + 다른 절이 읽은 문서(구역 존중이 켜져 있을 때, 교안 장면 4)
                    + 이 절이 지난 바퀴에 읽은 문서(다시 읽지 않기 — 예산은 새 문서에 쓴다).
        ④ 인용 확인에 걸린 절이면 그 설명을 부족 사유 뒤에 붙여 보낸다. 시작 문서 지정은 리서처가 직접 적은
        부족 사유로만 판단한다(코드가 적은 설명 속 제목으로 지정 규칙이 움직이지 않게).
        """
        base = self._task(toc, index)
        latest = self._latest(sections)
        mine = latest[index]
        own_read = {doc for s in sections if s["번호"] == index for doc in s["읽은문서"]}
        others_read = {doc for s in sections if s["번호"] != index for doc in s["읽은문서"]}
        zone = set(base["피하기"]) | others_read if self.settings.respect_zones else set()
        avoid = sorted(zone | own_read)
        seed, note = designate_seed(mine["부족"], list(self.corpus.docs), set(avoid), own_read | others_read)
        flag = flags.get(index)
        gap = " ".join(part for part in (mine["부족"], flag["설명"] if flag else "") if part)
        task: Task = {**base, "시작문서": seed, "지시": redispatch_brief(base["지시"], gap), "피하기": avoid}
        return task, mine["본문"], gap, note

    # ③ 조사 — 리서처 하나. 스레드에 절 번호를 적어 두면 이 스레드의 모든 이벤트에 붙는다
    def researcher6(self, state: Assignment6) -> dict[str, Any]:
        task, rnd = state["task"], state["round"]
        events.set_context(task["번호"], rnd)
        try:
            self.emit("node_start", "researcher")
            self.emit(
                "researcher_start", "researcher",
                절=task["절"], 역할=task["역할"], 시작문서=task["시작문서"], 예산=task["예산"],
                피하기=task["피하기"], 지시=task["지시"],
            )
            read, notes = self._explore(task)
            body, enough, gap = self._write6(task, notes, state["prior"], state["gap"])
            citations = re.findall(r"«([^»]+)»", body)
            section: Section6 = {
                "번호": task["번호"], "절": task["절"], "역할": task["역할"], "본문": body,
                "읽은문서": read, "인용": citations, "충분": enough, "부족": gap, "바퀴": rnd,
                "시작문서": task["시작문서"],
            }
            verdict = "충분" if enough else "부족"
            log = (
                f"   ③ {task['역할']} «{task['절'][:14]}» {rnd}바퀴 · {len(read)}건 읽고 {len(body)}자 · "
                f"인용 {len(citations)}곳 · {verdict}"
            )
            self.emit("draft", "researcher", **section)
            self.emit("node_end", "researcher", log=log)
            return {"sections": [section], "visited": [[task["절"], doc] for doc in read], "log": [log]}
        finally:
            events.clear_context()

    def _write6(self, task: Task, notes: list[tuple[str, str]], prior: str, gap: str) -> tuple[str, bool, str]:
        raw = self.model(Step.WRITE, write_report_prompt(task, notes, prior, gap))
        reply = parse_json_object(raw)
        body = str(reply.get("본문") or "")
        body = body if len(body) >= MIN_SECTION_CHARS else salvage_body(raw)
        # 신고가 없거나 읽을 수 없으면 '부족 신고'로 치지 않는다 — 부족하다고 스스로 신고한 절만 다시 보낸다
        enough = not str(reply.get("충분", "")).strip().startswith("아니")
        return body, enough, "" if enough else str(reply.get("부족") or "")

    # ④ 점검 — 코드만
    @_node("review")
    def review(self, state: State6) -> dict[str, Any]:
        rnd = state["round"]
        latest = self._latest(state["sections"])
        flags: dict[int, dict[str, Any]] = {}
        if self.settings.check_citations:
            read_by_anyone = {doc for s in state["sections"] for doc in s["읽은문서"]}
            for n, s in latest.items():
                if (problem := citation_problems(s["인용"], read_by_anyone)) is not None:
                    flags[n] = problem
        short = sorted(n for n, s in latest.items() if not s["충분"] or n in flags)
        again = self.settings.redispatch and bool(short) and rnd < self.settings.max_rounds
        nxt = "dispatch" if again else "synthesize"
        self.emit(
            "review", "review", 바퀴=rnd, 부족=short, 다음=nxt,
            사유={n: " ".join(p for p in (latest[n]["부족"], flags[n]["설명"] if n in flags else "") if p) for n in short},
            재위임=self.settings.redispatch, 최대바퀴=self.settings.max_rounds,
            인용확인=self.settings.check_citations, 인용확인_걸림=flags,
        )
        plan = {**state["plan"], "배치": short if again else []}
        why = "다시 보냄" if again else ("바퀴 상한" if short and self.settings.redispatch else "종합으로")
        checked = f" (인용 확인으로 {len(flags)}절)" if self.settings.check_citations else ""
        log = f"④ 점검   {len(latest)}절 중 부족 {len(short)}절{checked} → {why}"
        return {"plan": plan, "round": rnd + 1 if again else rnd, "review_next": nxt, "log": [log], "flags": flags}

    # ⑤ 종합 — pipeline.synthesize 그대로, 절마다 마지막 원고만 넘긴다
    @_node("synthesize")
    def synthesize6(self, state: State6) -> dict[str, Any]:
        latest = list(self._latest(state["sections"]).values())
        out = self.synthesize({**state, "sections": latest})
        self.emit("report", "synthesize", 글자수=len(out["report"]), 본문=out["report"])
        return out

    # ⑥ 평가 — 코드만, 정답표 없이
    @_node("evaluate")
    def evaluate(self, state: State6) -> dict[str, Any]:
        # 모든 바퀴의 읽기를 센다: 다시 쓴 원고는 지난 원고(1바퀴에 읽은 문서)를 이어받을 수 있다
        metrics = evaluate_report(state["report"], [s["읽은문서"] for s in state["sections"]])
        self.emit("metrics", "evaluate", **metrics)
        log = (
            f"⑥ 평가   근거 {metrics['근거비율']:.1%} · 허위 인용 {metrics['허위인용']} · "
            f"읽고 안 쓴 {metrics['읽고안쓴문서']}건 · 편중 {metrics['편중']:.1%} · 중복 {metrics['중복률']:.1%}"
        )
        return {"metrics": metrics, "log": [log]}

    @staticmethod
    def _latest(sections: list[Section6]) -> dict[int, Section6]:
        latest: dict[int, Section6] = {}
        for section in sections:
            current = latest.get(section["번호"])
            if current is None or section["바퀴"] >= current["바퀴"]:
                latest[section["번호"]] = section
        return dict(sorted(latest.items()))


# ── 도메인 값: pipeline.py를 고치지 않고 실행할 때 config 값으로 바꿔 넣는다 ──

_ORIGINAL_ROSTER = dict(pipeline.ROSTER)
_ORIGINAL_DEFAULT_ROLE = pipeline.DEFAULT_ROLE


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def apply_domain(domain: dict[str, Any]) -> None:
    """역할 명단과 기본 역할을 pipeline 모듈의 전역 값에 넣는다. 명단이 없으면 수업 명단으로 되돌린다."""
    roster = domain.get("roster") or _ORIGINAL_ROSTER
    default_role = domain.get("default_role") or _ORIGINAL_DEFAULT_ROLE
    if default_role not in roster:
        raise ValueError(f"기본 역할 '{default_role}'이 역할 명단에 없습니다")
    pipeline.ROSTER.clear()
    pipeline.ROSTER.update(roster)
    pipeline.DEFAULT_ROLE = default_role


def settings_from(config: dict[str, Any], **overrides: Any) -> Settings6:
    values = {**config.get("settings", {}), **overrides}
    return Settings6(**values)


def corpus_stats(corpus: Corpus, window_tokens: int, chars_per_token: float) -> dict[str, Any]:
    chars = sum(len(text) for text in corpus.docs.values())
    inbound: dict[str, int] = {title: 0 for title in corpus.docs}
    for targets in corpus.links.values():
        for target in targets:
            if target in inbound:
                inbound[target] += 1
    return {
        "문서수": len(corpus.docs),
        "글자수": chars,
        "링크수": sum(len(v) for v in corpus.links.values()),
        "추정토큰": round(chars / chars_per_token),
        "창토큰": window_tokens,
        "창배수": round(chars / chars_per_token / window_tokens, 2),
        "나가는링크0": sorted(t for t in corpus.docs if not [x for x in corpus.links.get(t, []) if x in corpus.docs]),
        "문서": [
            {"제목": t, "글자수": len(x), "링크": [y for y in corpus.links.get(t, []) if y in corpus.docs]}
            for t, x in corpus.docs.items()
        ],
    }
