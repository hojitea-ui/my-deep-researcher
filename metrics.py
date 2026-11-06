"""지표 — 정답표도 판정 모델도 쓰지 않는다. 만들어진 보고서와 실제로 읽은 자료만 본다.

교안 장면 8의 다섯 숫자와 각 숫자가 지켜보는 장치:
    근거 비율     «문서명»이 붙은 문장 비율          → 절마다 읽는 문서 수 · 다시 맡기기 (② 배치 · ④ 점검)
    허위 인용     아무도 읽지 않은 문서를 인용한 곳   → 경보: 0이어야 한다
    읽고 안 쓴 문서 읽었는데 보고서에 안 나온 문서    → 시작 문서 배정 (① 기획 · 문서 카드)
    편중         가장 많이 인용된 문서의 몫          → 배정 · 피하기 목록 (① 기획 · ② 배치)
    중복률       여러 절이 겹쳐 읽은 몫              → 배정 · 피하기 목록 (① 기획 · ② 배치)

문장 자르기는 교안 수치를 그대로 재현하는 규칙을 쓴다: 마침표·물음표·느낌표 뒤 공백이나 줄바꿈에서
자르고, 10자 미만 조각("## 1." 같은 번호)은 버린다. 결과자료.json Q4 기본 기록에서 46문장 중 31문장,
67.4%가 나온다. «문서명»이 마침표 뒤에 붙어 다음 문장 몫으로 세어지는 문제(교안: 바로 세면 85.4%)는
알고 둔 채로 같은 잣대를 유지한다 — 규칙을 바꾸면 지표가 좋아진 것처럼 보이는 사고가 난다.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any, Iterable

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
MIN_SENTENCE_CHARS = 10
CITATION = re.compile(r"«([^»]+)»")


def sentences(report: str) -> list[str]:
    parts = (part.strip() for part in SENTENCE_SPLIT.split(report))
    return [part for part in parts if len(part) >= MIN_SENTENCE_CHARS]


def evaluate_report(report: str, reads_by_section: Iterable[list[str]]) -> dict[str, Any]:
    reads = [doc for docs in reads_by_section for doc in docs]
    read_set = set(reads)
    sents = sentences(report)
    grounded = sum(1 for sentence in sents if CITATION.search(sentence))
    cites = CITATION.findall(report)
    counts = Counter(cites)
    fake = [doc for doc in cites if doc not in read_set]
    unused = sorted(read_set - set(cites))
    top_doc, top_count = counts.most_common(1)[0] if counts else ("", 0)
    return {
        "근거비율": _ratio(grounded, len(sents)),
        "근거문장": grounded,
        "문장수": len(sents),
        "허위인용": len(fake),
        "허위인용문서": sorted(set(fake)),
        "읽고안쓴문서": len(unused),
        "읽고안쓴목록": unused,
        "편중": _ratio(top_count, len(cites)),
        "최다인용": {"문서": top_doc, "곳": top_count},
        "인용수": len(cites),
        "중복률": _ratio(len(reads) - len(read_set), len(reads)),
        "읽기수": len(reads),
        "서로다른문서": len(read_set),
        "경보": len(fake) > 0,
    }


def _ratio(part: int, whole: int) -> float:
    return round(part / whole, 4) if whole else 0.0
