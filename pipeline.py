"""D48 한국 근대사 딥리서처: ① 코디네이터가 목차를 짜고, ② 리서처 여럿이 절을 나눠 조사하고, ③ 편집자가 묶는다.

D48 2일차 노트북(셀 4·5·6·7·14)의 파이프라인만 떼어 한 파일로 정리했다. 프롬프트·데이터 키·로그 문구는
노트북과 같아서, 저장된 기록으로 재생하면 노트북과 같은 보고서가 나온다. Python 3.11 이상.

    pip install langgraph langchain-openai python-dotenv
    python pipeline.py                     # OPENAI_API_KEY 가 있으면 실제 호출, 없으면 저장된 기록으로 재생
    python pipeline.py --replay            # 키가 있어도 재생
    python pipeline.py --sections 3 --budget 2 --no-zones --question "..."
"""

from __future__ import annotations

import argparse
import io
import json
import operator
import os
import re
import time
import urllib.request
import zipfile
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Any, NamedTuple, Protocol, TypedDict, assert_never

import openai
from dotenv import load_dotenv
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

DATA_URL = (
    "https://raw.githubusercontent.com/88chacha/deepresearch-agent-data/"
    "main/data/deepresearch_d48_data.zip"
)
DEFAULT_QUESTION = "1894년에 일어난 주요 사건들은 무엇이고 각각의 원인은 무엇인가?"
DEFAULT_ROLE = "큰그림 담당"
ROSTER = {
    "큰그림 담당": "주제의 윤곽을 잡고 핵심 사건과 인물을 간추린다",
    "시간순 담당": "사건을 일어난 순서대로 늘어놓고 언제였는지를 못 박는다",
    "인물 담당": "한 사람이 무엇에 관여했고 어떤 일을 겪었는지 좇는다",
    "원인 담당": "무엇이 무엇으로 이어졌는지 자료에 적힌 대로 따라간다",
    "비교 담당": "둘 이상을 같은 잣대로 견주어 어디가 다른지 정리한다",
}
CARD_CHARS = 250
MAX_CANDIDATES = 60
MIN_SECTION_CHARS = 100
RETRYABLE = (openai.RateLimitError, openai.APIConnectionError, openai.InternalServerError)


class TocItem(TypedDict):
    절: str
    지시: str
    역할: str
    시작문서: str
    예산: int


class Task(TocItem):
    번호: int
    피하기: list[str]


class Plan(TypedDict):
    제목: str
    목차: list[TocItem]
    배치: list[int]


class Section(TypedDict):
    번호: int
    절: str
    역할: str
    본문: str
    읽은문서: list[str]
    인용: list[str]


class ResearchState(TypedDict):
    question: str
    plan: Plan
    sections: Annotated[list[Section], operator.add]
    visited: Annotated[list[list[str]], operator.add]
    report: str
    log: Annotated[list[str], operator.add]


class Assignment(TypedDict):
    question: str
    task: Task


@dataclass(frozen=True)
class Settings:
    max_sections: int = 4
    budget: int = 3
    use_roles: bool = True
    assign_seeds: bool = True
    respect_zones: bool = True


@dataclass(frozen=True)
class Corpus:
    docs: dict[str, str]
    links: dict[str, list[str]]

    @classmethod
    def load(cls, data_dir: Path) -> Corpus:
        raw = json.loads((data_dir / "corpus.json").read_text(encoding="utf-8"))
        return cls(docs=raw["docs"], links=raw["links"])

    def summary(self) -> str:
        chars = sum(len(text) for text in self.docs.values())
        links = sum(len(targets) for targets in self.links.values())
        return f"문서 {len(self.docs)}건 · {chars:,}자 · 링크 {links}개"

    def cards(self) -> str:
        return "\n".join(f"- {title}: {text[:CARD_CHARS]}".replace("\n", " ") for title, text in self.docs.items())

    def candidates(self, read: list[str], avoid: list[str]) -> list[str]:
        used = set(read) | set(avoid)
        linked = {target for doc in read for target in self.links.get(doc, []) if target in self.docs}
        return (
            sorted(linked - used)
            or [title for title in self.docs if title not in used]
            or [title for title in self.docs if title not in read]
        )


def ensure_data(data_dir: Path) -> None:
    if (data_dir / "corpus.json").exists():
        return
    data_dir.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(DATA_URL, timeout=60) as response:
        zipfile.ZipFile(io.BytesIO(response.read())).extractall(data_dir)


class Step(StrEnum):
    PLAN = "plan"
    READ = "read"
    PICK = "pick"
    WRITE = "write"
    EDIT = "edit"


class Prompt(NamedTuple):
    system: str
    user: str


class ChatModel(Protocol):
    def __call__(self, step: Step, prompt: Prompt) -> str: ...


def role_line(task: Task) -> str:
    return f"너는 {task['역할']}이다. {ROSTER.get(task['역할'], ROSTER[DEFAULT_ROLE])}."


def plan_prompt(question: str, cards: str, max_sections: int) -> Prompt:
    roster = "\n".join(f"- {name}: {duty}" for name, duty in ROSTER.items())
    return Prompt(
        "너는 리서치 팀의 코디네이터다. 아래 질문에 답하는 보고서의 목차를 짜고, 각 절을 리서처 에이전트 "
        f"하나에게 맡긴다. 절은 최대 {max_sections}개.\n"
        "목차는 반드시 **내용 단위**로 나눠라 — 사건·시기·인물·쟁점처럼 질문이 실제로 묻는 "
        "덩어리로 쪼갠다. '개요·연표·인물·인과분석' 같은 형식 단위로 나누지 마라. 그렇게 나누면 "
        "네 리서처 에이전트가 같은 문서를 네 번 읽는다.\n"
        "절마다 그 절을 쓰는 데 가장 먼저 읽어야 할 문서를 문서 목록에서 하나 배정하라. "
        "절끼리 다른 문서를 주어라.\n"
        f"절의 성격에 맞는 리서처 에이전트를 명단에서 골라 붙여라.\n[리서처 에이전트 명단]\n{roster}\n"
        'JSON으로만: {"제목":"보고서 제목","목차":[{"절":"절 제목","지시":"이 절에서 '
        '밝혀야 할 것 한두 문장","역할":"명단에 있는 이름 그대로","시작문서":"목록에 있는 제목"}]}',
        f"[질문] {question}\n[읽을 수 있는 문서 카드]\n{cards}",
    )


def read_prompt(title: str, text: str, brief: str) -> Prompt:
    return Prompt(
        "너는 자료 조사 담당이다. 아래 문서를 읽고 지시에 관련된 내용만 여섯 문장 이내로 "
        "간추려라. 관련 없으면 '관련 없음'이라고만 답하라.\n"
        f"[지시] {brief}",
        f"[문서: {title}]\n{text}",
    )


def pick_prompt(task: Task, read: list[str], candidates: list[str]) -> Prompt:
    return Prompt(
        f"{role_line(task)} 맡은 절을 쓰기 위해 다음에 읽을 문서를 후보 중에서 정확히 하나 "
        "고른다. 더 읽을 것이 없으면 그만둔다.\n"
        'JSON으로만: {"문서":"후보에 있는 제목"} 또는 {"문서":null}',
        f"[맡은 절] {task['절']}\n[지시] {task['지시']}\n"
        f"[이미 읽음] {', '.join(read) or '없음'}\n[후보] {', '.join(candidates[:MAX_CANDIDATES])}",
    )


def write_prompt(task: Task, notes: list[tuple[str, str]]) -> Prompt:
    material = "\n\n".join(f"[{doc}]\n{note}" for doc, note in notes) or "(읽은 자료 없음)"
    return Prompt(
        f"{role_line(task)} 아래 자료만 근거로 보고서의 한 절을 써라. "
        "여섯 문장 이상 열두 문장 이하, 600자 이상. 문장마다 근거가 된 문서 제목을 «문서명» "
        "으로 붙여라. 자료에 없는 내용은 쓰지 마라.\n"
        'JSON으로만: {"본문":"..."}',
        f"[맡은 절] {task['절']}\n[지시] {task['지시']}\n[모은 자료]\n{material}",
    )


def edit_prompt(question: str, title: str, sections: list[Section]) -> Prompt:
    outline = "\n".join(f"{n}. {s['절']}: {s['본문'][:90]}…" for n, s in enumerate(sections, 1))
    return Prompt(
        "너는 보고서를 마무리하는 편집자다. 아래는 리서처 에이전트들이 각자 쓴 절의 제목과 첫머리다. "
        "본문은 고치지 말고, 전체를 여는 머리말과 닫는 맺음말만 써라. 각각 세 문장 이내.\n"
        'JSON으로만: {"머리말":"...","맺음말":"..."}',
        f"[질문] {question}\n[보고서 제목] {title}\n[절 목록]\n{outline}",
    )


def parse_json_object(raw: str) -> dict[str, Any]:
    found = re.search(r"\{.*\}", raw, re.DOTALL)
    if found is None:
        return {}
    try:
        parsed = json.loads(found.group(0))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def salvage_body(raw: str) -> str:
    return re.sub(r'^\s*\{.*?"본문"\s*:\s*"?', "", raw, flags=re.DOTALL)[:2000].strip()


class OpenAIModel:
    def __init__(self, name: str = "gpt-4o-mini", max_chars: int = 60_000, attempts: int = 3) -> None:
        self._llm = ChatOpenAI(model=name, temperature=0, timeout=60, max_retries=0)
        self._max_chars = max_chars
        self._attempts = attempts

    def __call__(self, step: Step, prompt: Prompt) -> str:
        messages = [SystemMessage(prompt.system), HumanMessage(prompt.user[: self._max_chars])]
        for attempt in range(self._attempts - 1):
            try:
                return str(self._llm.invoke(messages).content)
            except RETRYABLE:
                time.sleep(2**attempt)
        return str(self._llm.invoke(messages).content)


@dataclass(frozen=True)
class ReplayModel:
    record: dict[str, Any]
    question: str

    @classmethod
    def load(cls, data_dir: Path, question: str) -> ReplayModel:
        path = data_dir / "결과자료.json"
        if not path.exists():
            raise SystemExit(f"{path} 이 없습니다. 재생하려면 저장된 실행 기록이 필요합니다.")
        return cls(json.loads(path.read_text(encoding="utf-8"))["Q4"]["설정"]["기본"], question)

    def __call__(self, step: Step, prompt: Prompt) -> str:
        match step:
            case Step.PLAN:
                return self._plan()
            case Step.READ:
                return self._lead_sentences(prompt.user)
            case Step.PICK:
                return self._next_document(prompt.user)
            case Step.WRITE:
                return _to_json({"본문": self._dispatch(prompt.user)["원고"]})
            case Step.EDIT:
                return self._intro_and_outro()
            case _:
                assert_never(step)

    def _plan(self) -> str:
        toc = [
            {"절": d["제목"], "지시": self.question, "역할": d["역할"], "시작문서": d["읽은문서"][0]}
            for d in self.record["파견"]
        ]
        title = self.record["최종보고서"].splitlines()[0].removeprefix("# ")
        return _to_json({"제목": title, "목차": toc})

    @staticmethod
    def _lead_sentences(user: str) -> str:
        body = user.split("\n", 1)[1] if "\n" in user else user
        return " ".join(re.split(r"(?<=[.!?])\s+", body.strip())[:2]) + " (재생: 문서 앞부분)"

    def _next_document(self, user: str) -> str:
        found = re.search(r"\[이미 읽음\] (.+)", user)
        already = set(found.group(1).split(", ")) if found else set()
        remaining = [doc for doc in self._dispatch(user)["읽은문서"] if doc not in already]
        return _to_json({"문서": remaining[0] if remaining else None})

    def _dispatch(self, user: str) -> dict[str, Any]:
        found = re.search(r"\[맡은 절\] (.+)", user)
        title = found.group(1).strip() if found else None
        dispatches = self.record["파견"]
        return next((d for d in dispatches if d["제목"] == title), dispatches[0])

    def _intro_and_outro(self) -> str:
        report = self.record["최종보고서"]
        intro = report.split("\n## 1.")[0].split("\n", 1)[1].strip()
        outro = report.split("## 맺음말")[-1].strip()
        return _to_json({"머리말": intro, "맺음말": outro})


def _to_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


@dataclass(frozen=True)
class DeepResearch:
    corpus: Corpus
    model: ChatModel
    settings: Settings = field(default_factory=Settings)

    def build_graph(self):
        return (
            StateGraph(ResearchState)
            .add_node("plan", self.plan)
            .add_node("researcher", self.researcher, input_schema=Assignment)
            .add_node("synthesize", self.synthesize)
            .add_edge(START, "plan")
            .add_conditional_edges("plan", self.fanout, ["researcher", "synthesize"])
            .add_edge("researcher", "synthesize")
            .add_edge("synthesize", END)
            .compile()
        )

    def run(self, question: str) -> dict[str, Any]:
        start: ResearchState = {
            "question": question,
            "plan": {"제목": question, "목차": [], "배치": []},
            "sections": [],
            "visited": [],
            "report": "",
            "log": [],
        }
        return self.build_graph().invoke(start)

    def plan(self, state: ResearchState) -> dict[str, Any]:
        question = state["question"]
        prompt = plan_prompt(question, self.corpus.cards(), self.settings.max_sections)
        reply = parse_json_object(self.model(Step.PLAN, prompt))
        toc = self._table_of_contents(reply.get("목차") or [], question)
        plan: Plan = {"제목": reply.get("제목", question), "목차": toc, "배치": list(range(len(toc)))}
        seeds = " · ".join(f"{item['역할']}→«{item['시작문서'] or '자율'}»" for item in toc)
        return {"plan": plan, "log": [f"① 기획   목차 {len(toc)}절 · {seeds}"]}

    def fanout(self, state: ResearchState) -> list[Send] | str:
        plan = state["plan"]
        if not plan["배치"]:
            return "synthesize"
        return [
            Send("researcher", Assignment(question=state["question"], task=self._task(plan["목차"], index)))
            for index in plan["배치"]
        ]

    def researcher(self, state: Assignment) -> dict[str, Any]:
        task = state["task"]
        read, notes = self._explore(task)
        body = self._write(task, notes)
        citations = re.findall(r"«([^»]+)»", body)
        section: Section = {
            "번호": task["번호"],
            "절": task["절"],
            "역할": task["역할"],
            "본문": body,
            "읽은문서": read,
            "인용": citations,
        }
        log = f"   ② {task['역할']} «{task['절'][:14]}» {len(read)}건 읽고 {len(body)}자 · 인용 {len(citations)}곳"
        return {"sections": [section], "visited": [[task["절"], doc] for doc in read], "log": [log]}

    def synthesize(self, state: ResearchState) -> dict[str, Any]:
        sections = sorted(state["sections"], key=lambda section: section["번호"])
        title = state["plan"]["제목"]
        reply = parse_json_object(self.model(Step.EDIT, edit_prompt(state["question"], title, sections)))
        parts = [f"# {title}", str(reply.get("머리말") or "")]
        parts += [f"## {n}. {s['절']}  _({s['역할']})_\n\n{s['본문']}" for n, s in enumerate(sections, 1)]
        parts.append(f"## 맺음말\n\n{reply.get('맺음말') or ''}")
        report = "\n\n".join(part for part in parts if part.strip())
        log = f"③ 종합   {len(sections)}절 이어붙임 → 보고서 {len(report):,}자 (편집자는 절 첫머리만 봤다)"
        return {"report": report, "log": [log]}

    def _table_of_contents(self, items: list[Any], question: str) -> list[TocItem]:
        taken: set[str] = set()
        toc: list[TocItem] = []
        for item in items[: self.settings.max_sections]:
            seed = self._seed(str(item.get("시작문서") or ""), taken)
            if seed:
                taken.add(seed)
            role = item.get("역할", "")
            toc.append({
                "절": item.get("절", "무제"),
                "지시": item.get("지시", question),
                "역할": role if self.settings.use_roles and role in ROSTER else DEFAULT_ROLE,
                "시작문서": seed,
                "예산": self.settings.budget,
            })
        fallback: TocItem = {"절": "개요", "지시": question, "역할": DEFAULT_ROLE, "시작문서": "", "예산": self.settings.budget}
        return toc or [fallback]

    def _seed(self, proposed: str, taken: set[str]) -> str:
        if not self.settings.assign_seeds:
            return ""
        if proposed in self.corpus.docs and proposed not in taken:
            return proposed
        return next((title for title in self.corpus.docs if title not in taken), "")

    def _task(self, toc: list[TocItem], index: int) -> Task:
        others = sorted({item["시작문서"] for i, item in enumerate(toc) if i != index and item["시작문서"]})
        return {**toc[index], "번호": index, "피하기": others if self.settings.respect_zones else []}

    def _explore(self, task: Task) -> tuple[list[str], list[tuple[str, str]]]:
        read: list[str] = []
        notes: list[tuple[str, str]] = []
        seed = task["시작문서"] if task["시작문서"] in self.corpus.docs else None
        for _ in range(task["예산"]):
            doc = seed if seed is not None else self._pick_next(task, read)
            seed = None
            if doc is None:
                break
            notes.append((doc, self.model(Step.READ, read_prompt(doc, self.corpus.docs[doc], task["지시"]))))
            read.append(doc)
        return read, notes

    def _pick_next(self, task: Task, read: list[str]) -> str | None:
        candidates = self.corpus.candidates(read, task["피하기"])
        reply = parse_json_object(self.model(Step.PICK, pick_prompt(task, read, candidates)))
        pick = str(reply.get("문서") or "")
        return pick if pick in self.corpus.docs and pick not in read else None

    def _write(self, task: Task, notes: list[tuple[str, str]]) -> str:
        raw = self.model(Step.WRITE, write_prompt(task, notes))
        body = str(parse_json_object(raw).get("본문") or "")
        return body if len(body) >= MIN_SECTION_CHARS else salvage_body(raw)


def load_api_key() -> str:
    load_dotenv()
    key = os.getenv("OPENAI_API_KEY", "")
    if key and not key.startswith("sk-"):
        raise SystemExit("키 형식이 이상합니다. sk- 로 시작해야 합니다. 안내 문구를 키 자리에 넣지 마세요.")
    return key


def positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("1 이상이어야 합니다")
    return value


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="D48 한국 근대사 딥리서처 파이프라인")
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--replay", action="store_true", help="키가 있어도 저장된 기록으로 재생한다")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parent / "data")
    parser.add_argument("--sections", type=positive_int, default=Settings.max_sections, help="목차의 최대 절 수")
    parser.add_argument("--budget", type=positive_int, default=Settings.budget, help="리서처 한 명이 읽을 문서 수")
    parser.add_argument("--no-roles", action="store_true", help="모든 리서처를 같은 범용 리서처로 둔다")
    parser.add_argument("--no-assign", action="store_true", help="시작 문서를 나눠 주지 않는다")
    parser.add_argument("--no-zones", action="store_true", help="다른 절이 맡은 시작 문서도 읽게 둔다")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    ensure_data(args.data_dir)
    corpus = Corpus.load(args.data_dir)
    replay = args.replay or not load_api_key()
    print(corpus.summary())
    print("모드:", "저장된 기록 재생" if replay else "실제 호출")
    if replay and args.question != DEFAULT_QUESTION:
        print("⚠️ 재생 모드는 작성 시점 질문(1894년 사건)의 기록을 돌려줍니다. 질문을 바꿔도 결과는 같습니다.")
    model: ChatModel = ReplayModel.load(args.data_dir, args.question) if replay else OpenAIModel()
    settings = Settings(
        max_sections=args.sections,
        budget=args.budget,
        use_roles=not args.no_roles,
        assign_seeds=not args.no_assign,
        respect_zones=not args.no_zones,
    )
    result = DeepResearch(corpus, model, settings).run(args.question)
    print("\n".join(result["log"]), end="\n\n")
    print(result["report"])


if __name__ == "__main__":
    main()
