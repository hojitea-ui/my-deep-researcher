"""실행 한 번: 도메인 값 적용 → 모델 준비 → 6노드 그래프 → 기록 저장.

    python runner.py --question "..."            # 실제 호출 (.env 의 키 필요)
    python runner.py --domain lesson --replay-lesson   # 개발 확인용: 키 없이 수업 기록으로 그래프만 돌려 본다
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from langchain_openai import ChatOpenAI
from pydantic import SecretStr

import events
from graph import ROOT, DeepResearch6, apply_domain, corpus_stats, load_config, settings_from
from keys import key_status, read_openai_key, redact
from pipeline import ChatModel, Corpus, OpenAIModel, ReplayModel

RUNS_DIR = ROOT / "runs"
OUTPUT_DIR = ROOT / "output"
_run_lock = threading.Lock()


class KeyedOpenAIModel(OpenAIModel):
    """pipeline.OpenAIModel 과 같은 설정·같은 재시도. 키만 환경 변수가 아니라 인자로 받는다."""

    def __init__(self, api_key: str, name: str = "gpt-4o-mini", max_chars: int = 60_000, attempts: int = 3) -> None:
        self._llm = ChatOpenAI(model=name, temperature=0, timeout=60, max_retries=0, api_key=SecretStr(api_key))
        self._max_chars = max_chars
        self._attempts = attempts


def new_run_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def domain_of(config: dict[str, Any], name: str | None = None) -> tuple[str, dict[str, Any]]:
    key = name or config["active_domain"]
    return key, config["domains"][key]


def load_corpus(domain: dict[str, Any]) -> Corpus | None:
    path = ROOT / domain["corpus"]
    return Corpus.load(path.parent) if path.exists() and path.name == "corpus.json" else None


def ready_problems(config: dict[str, Any], domain_name: str | None = None, live: bool = True) -> list[str]:
    _, domain = domain_of(config, domain_name)
    problems = []
    if load_corpus(domain) is None:
        problems.append("코퍼스(corpus.json)가 아직 없어요")
    if domain.get("roster_required") and not domain.get("roster"):
        problems.append("역할 명단이 아직 없어요")
    if live and key_status() != "ok":
        problems.append(".env 에 OPENAI_API_KEY 가 없거나 sk- 로 시작하지 않아요")
    return problems


def execute(
    question: str,
    bus: events.EventBus,
    config: dict[str, Any],
    domain_name: str | None = None,
    inner: ChatModel | None = None,
    mode: str = "실제 호출",
    save: bool = True,
    **setting_overrides: Any,
) -> dict[str, Any]:
    """그래프를 한 번 돌린다. 이벤트는 bus 로, 결과는 runs/ · output/ 에 남는다. 한 번에 하나씩만 돈다."""
    with _run_lock:
        key, domain = domain_of(config, domain_name)
        corpus = load_corpus(domain)
        if corpus is None:
            raise RuntimeError("코퍼스가 없습니다")
        apply_domain(domain)
        settings = settings_from(config, **setting_overrides)
        if inner is None:
            inner = KeyedOpenAIModel(read_openai_key(), config["model"], config["max_user_chars"])
        stats = corpus_stats(corpus, config["window_tokens"], config["chars_per_token"])
        import pipeline  # apply_domain 이 바꾼 명단을 기록에 남긴다

        bus.emit(
            "run_start", None, run_id=bus.run_id, 질문=question, 모드=mode, 도메인=key, 도메인이름=domain["name"],
            모델=config["model"], 설정=settings.__dict__, 역할명단=dict(pipeline.ROSTER), 코퍼스=stats,
            창토큰=config["window_tokens"], 글자당토큰=1 / config["chars_per_token"],
        )
        started = time.monotonic()
        try:
            model = events.RecordingModel(inner, bus, config["max_user_chars"])
            result = DeepResearch6(corpus, model, settings, bus).run(question)
        except Exception as exc:
            bus.emit("run_error", None, error=redact(f"{type(exc).__name__}: {exc}")[:600])
            raise
        finally:
            elapsed = round(time.monotonic() - started, 1)
        bus.emit("run_end", None, 걸린초=elapsed, 보고서글자수=len(result["report"]), 지표=result["metrics"], 로그=result["log"])
        if save:
            _save_outputs(bus.run_id, question, key, mode, result, elapsed)
        return result


def _save_outputs(run_id: str, question: str, domain: str, mode: str, result: dict[str, Any], elapsed: float) -> None:
    (OUTPUT_DIR / "reports").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "reports" / f"{run_id}.md").write_text(result["report"], encoding="utf-8")
    summary = {
        "run_id": run_id, "질문": question, "도메인": domain, "모드": mode, "걸린초": elapsed,
        "지표": result["metrics"], "로그": result["log"],
    }
    with (OUTPUT_DIR / "runs.jsonl").open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(summary, ensure_ascii=False) + "\n")


def preview_plan(question: str, config: dict[str, Any], domain_name: str | None = None) -> dict[str, Any]:
    """① 기획만 한 번 돌려, 코디네이터가 낸 안과 코드가 바로잡은 최종 목차를 나란히 보여 준다(호출 1번)."""
    import pipeline
    from pipeline import parse_json_object

    key, domain = domain_of(config, domain_name)
    problems = ready_problems(config, key, live=True)
    if problems:
        raise SystemExit("미리보기를 할 수 없어요: " + " · ".join(problems))
    corpus = load_corpus(domain)
    apply_domain(domain)
    replies: list[str] = []
    inner = KeyedOpenAIModel(read_openai_key(), config["model"], config["max_user_chars"])

    def capture(step, prompt):
        reply = inner(step, prompt)
        replies.append(reply)
        return reply

    research = DeepResearch6(corpus, capture, settings_from(config))
    out = research.plan({"question": question})
    raw = parse_json_object(replies[0]).get("목차") or []
    print(f"질문: {question}\n보고서 제목: {out['plan']['제목']}\n")
    for i, (item, final) in enumerate(zip(raw + [{}] * len(out["plan"]["목차"]), out["plan"]["목차"])):
        fixes = []
        if item.get("역할") != final["역할"]:
            fixes.append(f"역할 '{item.get('역할')}' → '{final['역할']}'")
        if item.get("시작문서") != final["시작문서"]:
            fixes.append(f"시작 문서 '{item.get('시작문서')}' → '{final['시작문서']}'")
        print(f"[{'ABCDEFGH'[i]}] {final['절']}")
        print(f"    역할: {final['역할']} — {pipeline.ROSTER.get(final['역할'], '')}")
        print(f"    시작 문서: «{final['시작문서'] or '자율'}»  ({len(corpus.docs.get(final['시작문서'], '')):,}자)")
        print(f"    지시: {final['지시']}")
        print(f"    코드가 바로잡은 것: {' · '.join(fixes) if fixes else '없음'}")
    if len(raw) > len(out["plan"]["목차"]):
        print(f"\n코디네이터가 낸 절 {len(raw)}개 중 최대 {config['settings']['max_sections']}개만 남겼어요.")
    return out


def open_bus(run_id: str | None = None) -> events.EventBus:
    RUNS_DIR.mkdir(exist_ok=True)
    run_id = run_id or new_run_id()
    return events.EventBus(run_id, RUNS_DIR / f"{run_id}.jsonl")


def main() -> None:
    parser = argparse.ArgumentParser(description="6노드 딥리서처 한 번 실행")
    parser.add_argument("--question")
    parser.add_argument("--domain")
    parser.add_argument("--replay-lesson", action="store_true", help="개발 확인용: 수업 기록(ReplayModel)으로 돌린다")
    parser.add_argument("--plan-only", action="store_true", help="① 기획 호출 한 번만 돌려 목차·역할·시작 문서를 미리 본다")
    args = parser.parse_args()
    config = load_config()
    key, domain = domain_of(config, args.domain)
    question = args.question or domain["default_question"]
    if args.plan_only:
        return preview_plan(question, config, key)
    problems = ready_problems(config, key, live=not args.replay_lesson)
    if problems:
        raise SystemExit("실행할 수 없어요: " + " · ".join(problems))
    inner = ReplayModel.load(ROOT / "data" / "lesson", question) if args.replay_lesson else None
    mode = "수업 기록 재생(개발 확인용)" if args.replay_lesson else "실제 호출"
    bus = open_bus(("dev-" if args.replay_lesson else "") + new_run_id())
    try:
        result = execute(question, bus, config, key, inner, mode, save=not args.replay_lesson)
    finally:
        bus.close()
    print("\n".join(result["log"]))
    print("기록:", bus.path)


if __name__ == "__main__":
    main()
