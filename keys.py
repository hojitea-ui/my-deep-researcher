"""OpenAI 키 읽기: 지정한 .env 파일에서 OPENAI_API_KEY 한 줄만 직접 읽는다.

load_dotenv()는 파일의 모든 값을 환경 변수로 올리므로 쓰지 않는다.
키 값은 화면·로그·브라우저로 내보내지 않는다. 바깥에는 '있다/없다'만 알린다.
"""

from __future__ import annotations

import re
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent / ".env"
_KEY_LINE = re.compile(r"^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*$")
_SECRET = re.compile(r"sk-[A-Za-z0-9_\-*]{4,}")


def read_openai_key(env_path: Path = ENV_PATH) -> str:
    if not env_path.exists():
        return ""
    for line in env_path.read_text(encoding="utf-8").splitlines():
        found = _KEY_LINE.match(line)
        if found is None:
            continue
        value = found.group(1)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        return value.strip()
    return ""


def key_status(env_path: Path = ENV_PATH) -> str:
    """'ok' · 'missing' · 'malformed' — 키 값 자체는 돌려주지 않는다."""
    key = read_openai_key(env_path)
    if not key:
        return "missing"
    return "ok" if key.startswith("sk-") else "malformed"


def redact(text: str) -> str:
    """오류 메시지 등에 키 조각이 섞여 나가지 않게 가린다."""
    return _SECRET.sub("sk-***", text)
