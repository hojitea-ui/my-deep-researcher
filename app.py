"""데모 서버: 3D 연구 공장 시뮬레이터 + 질문 입력 + 보고서. 표준 라이브러리만 쓴다.

    .venv\\Scripts\\python app.py        →  http://127.0.0.1:8765

실제 실행 중에는 이벤트를 SSE로 흘려보내고, 끝난 실행은 runs/<id>.jsonl 을 그대로 내려보낸다.
화면은 두 경우 모두 같은 이벤트 배열로 상태를 다시 계산한다. 키 값은 어떤 응답에도 담지 않는다.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import events
import runner
from graph import ROOT, corpus_stats, load_config
from keys import key_status, redact

WEB = ROOT / "web"
_current: dict[str, Any] = {"bus": None}
_current_lock = threading.Lock()


def _questions(domain: dict[str, Any]) -> list[dict[str, Any]]:
    if not domain.get("questions"):
        return []
    path = ROOT / domain["questions"]
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    return raw if isinstance(raw, list) else raw.get("questions", [])


def status() -> dict[str, Any]:
    config = load_config()
    key, domain = runner.domain_of(config)
    corpus = runner.load_corpus(domain)
    bus = _current["bus"]
    return {
        "key": key_status(),
        "domain": key,
        "domain_name": domain["name"],
        "default_question": domain["default_question"],
        "questions": _questions(domain),
        "problems": runner.ready_problems(config, key, live=True),
        "corpus": corpus_stats(corpus, config["window_tokens"], config["chars_per_token"]) if corpus else None,
        "settings": config["settings"],
        "model": config["model"],
        "window_tokens": config["window_tokens"],
        "chars_per_token": config["chars_per_token"],
        "running": bus.run_id if bus is not None and not bus.closed else None,
    }


EXCERPT_CHARS = 900


def doc_detail(title: str, domain_name: str | None = None) -> dict[str, Any] | None:
    """문서 상세: 앞부분 본문 · 코퍼스 안 링크 · 수집 때 잰 주제 관련어 밀도. 기록의 도메인을 따른다."""
    config = load_config()
    if domain_name not in config["domains"]:
        domain_name = None
    key, domain = runner.domain_of(config, domain_name)
    corpus = runner.load_corpus(domain)
    if corpus is None or title not in corpus.docs:
        return None
    text = corpus.docs[title]
    info_path = (ROOT / domain["corpus"]).parent / "corpus_info.json"
    density = None
    if info_path.exists():
        scores = json.loads(info_path.read_text(encoding="utf-8")).get("관련어점수", {})
        density = scores.get(title, {}).get("밀도")
    return {
        "제목": title, "도메인": key, "글자수": len(text), "발췌": text[:EXCERPT_CHARS],
        "링크": corpus.links.get(title, []), "관련어밀도": density,
    }


def list_runs(include_dev: bool = False) -> list[dict[str, Any]]:
    out = []
    for path in sorted(runner.RUNS_DIR.glob("*.jsonl"), reverse=True):
        if path.stem.startswith("test") or (path.stem.startswith("dev-") and not include_dev):
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        if not lines:
            continue
        first, last = json.loads(lines[0]), json.loads(lines[-1])
        out.append({
            "id": path.stem,
            "질문": first["data"].get("질문", ""),
            "모드": first["data"].get("모드", ""),
            "도메인": first["data"].get("도메인이름", ""),
            "이벤트": len(lines),
            "상태": {"run_end": "완료", "run_error": "오류"}.get(last["type"], "진행 중/중단"),
        })
    return out


def start_run(question: str) -> str:
    with _current_lock:
        bus = _current["bus"]
        if bus is not None and not bus.closed:
            raise RuntimeError("이미 실행 중인 연구가 있어요")
        config = load_config()
        problems = runner.ready_problems(config, live=True)
        if problems:
            raise ValueError(" · ".join(problems))
        bus = runner.open_bus()
        _current["bus"] = bus

    def work() -> None:
        try:
            runner.execute(question, bus, config)
        except Exception as exc:  # run_error 이벤트는 execute 가 남긴다
            print("실행 실패:", redact(f"{type(exc).__name__}: {exc}"))
        finally:
            bus.close()

    threading.Thread(target=work, name=f"run-{bus.run_id}", daemon=True).start()
    return bus.run_id


class Handler(BaseHTTPRequestHandler):
    server_version = "DeepResearchFactory/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # 요청 로그를 줄인다
        if "/api/stream" not in (args[0] if args else ""):
            return

    def _json(self, body: Any, code: int = 200) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = path.read_bytes()
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix in (".js", ".mjs"):
            ctype = "text/javascript"
        elif path.suffix == ".woff2":
            ctype = "font/woff2"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if path == "/":
            return self._file(WEB / "index.html")
        if path.startswith("/web/"):
            target = (WEB / path[len("/web/"):]).resolve()
            if WEB.resolve() not in target.parents:
                return self.send_error(HTTPStatus.FORBIDDEN)
            return self._file(target)
        if path == "/api/status":
            return self._json(status())
        if path == "/api/runs":
            return self._json(list_runs("dev=1" in (urlparse(self.path).query or "")))
        if path.startswith("/api/runs/"):
            run_id = path.rsplit("/", 1)[-1]
            file = runner.RUNS_DIR / f"{run_id}.jsonl"
            if not run_id.replace("-", "").isalnum() or not file.exists():
                return self.send_error(HTTPStatus.NOT_FOUND)
            return self._json({"id": run_id, "events": events.load_events(file)})
        if path.startswith("/api/stream/"):
            return self._stream(path.rsplit("/", 1)[-1])
        if path == "/api/doc":
            query = parse_qs(urlparse(self.path).query)
            found = doc_detail((query.get("title") or [""])[0], (query.get("domain") or [None])[0])
            return self._json(found) if found else self.send_error(HTTPStatus.NOT_FOUND)
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/run":
            return self.send_error(HTTPStatus.NOT_FOUND)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            question = str(body.get("question") or "").strip()
            if not question:
                raise ValueError("질문을 입력해 주세요")
            run_id = start_run(question)
        except RuntimeError as exc:
            return self._json({"error": str(exc)}, 409)
        except ValueError as exc:
            return self._json({"error": str(exc)}, 400)
        self._json({"run_id": run_id})

    def _stream(self, run_id: str) -> None:
        bus = _current["bus"]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        def send(kind: str, payload: Any) -> None:
            self.wfile.write(f"event: {kind}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()

        try:
            if bus is None or bus.run_id != run_id:
                file = runner.RUNS_DIR / f"{run_id}.jsonl"
                for event in events.load_events(file) if file.exists() else []:
                    send("ev", event)
                send("end", {})
                return
            backlog, subscriber = bus.subscribe()
            try:
                for event in backlog:
                    send("ev", event)
                while True:
                    try:
                        event = subscriber.get(timeout=15)
                    except Exception:
                        self.wfile.write(b": keep-alive\n\n")
                        self.wfile.flush()
                        continue
                    if event is None:
                        break
                    send("ev", event)
                send("end", {})
            finally:
                bus.unsubscribe(subscriber)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return


def main() -> None:
    parser = argparse.ArgumentParser(description="딥리서처 3D 연구 공장")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"딥리서처 연구 공장: http://127.0.0.1:{args.port}  (키 상태: {key_status()})")
    server.serve_forever()


if __name__ == "__main__":
    main()
