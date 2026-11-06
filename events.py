"""실행 이벤트: 모델 호출 래퍼 · 스레드별 절 번호 · 기록(JSONL)과 실시간 구독.

실제 실행과 기록 재생은 같은 이벤트 데이터를 쓴다. 실행 중에는 EventBus가 이벤트를
runs/<id>.jsonl 에 한 줄씩 적으면서 구독자(SSE)에게 흘려보내고, 재생은 그 파일을 그대로 읽는다.
"""

from __future__ import annotations

import itertools
import json
import queue
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from keys import redact
from pipeline import ChatModel, Prompt, Step, parse_json_object

_local = threading.local()

STEP_NODE = {
    Step.PLAN: "plan",
    Step.READ: "researcher",
    Step.PICK: "researcher",
    Step.WRITE: "researcher",
    Step.EDIT: "synthesize",
}


def set_context(section: int | None, round_: int | None) -> None:
    """researcher()가 도는 스레드에 절 번호와 바퀴를 적어 둔다. 그 스레드의 모든 이벤트에 붙는다."""
    _local.section = section
    _local.round = round_


def clear_context() -> None:
    _local.section = None
    _local.round = None


def current_section() -> int | None:
    return getattr(_local, "section", None)


def current_round() -> int | None:
    return getattr(_local, "round", None)


class EventBus:
    def __init__(self, run_id: str, path: Path | None = None) -> None:
        self.run_id = run_id
        self.path = path
        self._lock = threading.Lock()
        self._events: list[dict[str, Any]] = []
        self._subscribers: list[queue.Queue] = []
        self._t0 = time.monotonic()
        self._file = path.open("a", encoding="utf-8") if path else None
        self._thread_names: dict[int, str] = {}
        self.closed = False

    def _thread_label(self) -> str:
        ident = threading.get_ident()
        if ident not in self._thread_names:
            self._thread_names[ident] = f"T{len(self._thread_names)}"
        return self._thread_names[ident]

    def emit(self, type_: str, node: str | None = None, **data: Any) -> dict[str, Any]:
        section = data.pop("section", current_section())
        round_ = data.pop("round", current_round())
        with self._lock:
            event = {
                "seq": len(self._events),
                "t": round(time.monotonic() - self._t0, 3),
                "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "type": type_,
                "node": node,
                "thread": self._thread_label(),
                "section": section,
                "round": round_,
                "data": data,
            }
            self._events.append(event)
            if self._file:
                self._file.write(json.dumps(event, ensure_ascii=False) + "\n")
                self._file.flush()
            for subscriber in self._subscribers:
                subscriber.put(event)
        return event

    def subscribe(self) -> tuple[list[dict[str, Any]], queue.Queue]:
        with self._lock:
            subscriber: queue.Queue = queue.Queue()
            if self.closed:
                subscriber.put(None)
            else:
                self._subscribers.append(subscriber)
            return list(self._events), subscriber

    def unsubscribe(self, subscriber: queue.Queue) -> None:
        with self._lock:
            if subscriber in self._subscribers:
                self._subscribers.remove(subscriber)

    def close(self) -> None:
        with self._lock:
            self.closed = True
            if self._file:
                self._file.close()
                self._file = None
            for subscriber in self._subscribers:
                subscriber.put(None)
            self._subscribers.clear()


class RecordingModel:
    """ChatModel 래퍼. 원래 모델(OpenAIModel 등)을 그대로 부르고, 앞뒤로 이벤트를 남긴다.

    chars_in 은 모델이 실제로 본 글자 수다(OpenAIModel이 user를 max_chars에서 자르는 것까지 반영).
    격리 증명(코디네이터가 본 글자 수 vs 리서처가 본 글자 수)은 이 값을 절 번호별로 더해서 낸다.
    """

    _ids = itertools.count(1)

    def __init__(self, inner: ChatModel, bus: EventBus, max_user_chars: int | None = None) -> None:
        self._inner = inner
        self._bus = bus
        self._max_user_chars = max_user_chars

    def __call__(self, step: Step, prompt: Prompt) -> str:
        user = prompt.user if self._max_user_chars is None else prompt.user[: self._max_user_chars]
        call = next(self._ids)
        node = STEP_NODE[step]
        info: dict[str, Any] = {}
        if step is Step.READ:
            found = re.match(r"\[문서: (.+?)\]\n", prompt.user)
            info["doc"] = found.group(1) if found else None
            info["doc_chars"] = len(prompt.user) - (found.end() if found else 0)
        self._bus.emit(
            "llm_start", node, step=str(step), call=call,
            chars_in=len(prompt.system) + len(user), system=prompt.system, user=user, **info,
        )
        started = time.monotonic()
        try:
            reply = self._inner(step, prompt)
        except Exception as exc:  # 기록만 남기고 그대로 올린다
            self._bus.emit("llm_error", node, step=str(step), call=call, error=redact(f"{type(exc).__name__}: {exc}")[:400])
            raise
        if step is Step.PICK:
            info["picked"] = parse_json_object(reply).get("문서")
        self._bus.emit(
            "llm_end", node, step=str(step), call=call,
            ms=round((time.monotonic() - started) * 1000), chars_out=len(reply), reply=reply, **info,
        )
        return reply


def load_events(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
