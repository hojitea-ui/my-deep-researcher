"""한국어 위키백과 코퍼스 수집 — 시드 문서에서 2홉까지 넓혀 문서 30건 이상을 corpus.json 한 파일로 저장한다.

    python collect_corpus.py                 # 맨 위 SEEDS 로 수집 → data/corpus.json · data/corpus_info.json

수업 교안의 '위키백과 코퍼스 수집 프롬프트'를 그대로 따른다.
- MediaWiki API만 쓴다(HTML 크롤링 없음). 본문은 prop=extracts + explaintext, 링크는 prop=links(plnamespace=0).
- 1홉 = 시드 문서. 2홉 후보 = 시드 문서의 본문 링크 가운데 여러 시드가 함께 가리키는 것부터 고른다.
- 연도·목록·틀·분류 문서는 뺀다(틀·분류는 이름공간 0만 받아서 처음부터 빠진다).
- 본문이 3000자 미만인 토막글은 저장하지 않는다. 짧으면 나눠 읽을 이유가 없다.
- links 에는 docs 안에 실제로 있는 제목만 남긴다.
- User-Agent 는 아스키로만. extracts 는 한 번에 한 문서만, 호출 사이에 0.3초 쉰다. continue 가 있으면 이어 받는다.
- 마지막에 문서 수 · 총 글자 수 · 문서당 링크 수의 중앙값 · 링크가 0개인 문서 목록을 출력한다.

사용자가 더한 제외 기준(2026-11-06): 제목이나 문서 유형이 아니라 '식물의 역사'와의 실질적 관련성으로 거른다.
- 2홉 후보 본문에서 주제 관련어(작물 · 농업·식량 · 교역)가 1만 자당 10회 미만이면 뺀다. 시드는 판단 없이 넣는다.
- 동음이의 문서는 뺀다. 제외한 문서와 사유, 이전 코퍼스 대비 바뀐 문서를 data/corpus_info.json 에 남긴다.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

SEEDS: list[str] = [
    # Q2 감자·밀·벼·옥수수는 지역별 인구 증가와 식량 체계에 어떤 차이를 만들었는가?
    "감자", "밀", "벼", "옥수수",
    # Q3 후추와 차에 대한 수요는 대항해시대와 유럽의 해외 진출에 어떤 영향을 주었는가?
    "후추", "차 (음료)", "향신료 무역", "대항해시대",
]

API = "https://ko.wikipedia.org/w/api.php"
USER_AGENT = "my-deep-researcher-corpus/0.1 (educational project)"
MIN_CHARS = 3000
TARGET = 40
PAUSE = 0.3
SKIP_TITLE = re.compile(r"(목록|^\d+년$|^\d+년대$|^기원전 \d+년$|^\d+세기$|^\d+월 \d+일$)")
CUT_HEADINGS = ("각주", "참고 문헌", "참고문헌", "외부 링크", "같이 보기", "더 읽을거리", "출처", "주석")
ROOT = Path(__file__).resolve().parent
NL = "\n"

# ── 주제 관련성: '식물의 역사' 관련어가 본문 1만 자당 몇 번 나오나 ──
MIN_DENSITY = 10.0
_NB = r"(?<![가-힣0-9])"  # 앞이 한글·숫자가 아니어야: '비밀'·'1차' 속의 '밀'·'차'를 세지 않는다
_AFTER = r"(?=[은는이가을를의과와도로에만]|\s|[,.)·]|$)"
RELEVANCE_TERMS = {
    "작물": (
        r"감자|옥수수|후추|향신료|육두구|정향|계피|사탕수수|설탕|커피|카카오나무|코코아|목화|면화|담배|고추|토마토|튤립|보리|대두|쌀"
        + "|" + _NB + r"밀" + _AFTER + "|" + _NB + r"벼" + _AFTER
        + r"|녹차|홍차|우롱차|찻잎|차나무|다도|차 무역|차 교역|차 재배|차를 마시"
    ),
    "농업·식량": r"작물|곡물|곡식|재배|농업|농경|경작|식량|기근|수확|품종|플랜테이션|농산물|파종|관개",
    "교역": r"대항해|향료|교역|무역로|동인도 회사|콜럼버스",
}


def relevance(text: str) -> dict[str, Any]:
    counts = {name: len(re.findall(pattern, text)) for name, pattern in RELEVANCE_TERMS.items()}
    total = sum(counts.values())
    return {"밀도": round(total / max(len(text), 1) * 10000, 1), "합계": total, **counts}


def api(**params: Any) -> dict[str, Any]:
    """호출 사이 0.3초를 쉬고, 429·503(너무 잦은 요청)이면 Retry-After 만큼 기다렸다 다시 한다."""
    query = urllib.parse.urlencode({"format": "json", "formatversion": 2, **params})
    request = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": USER_AGENT})
    for attempt in range(8):
        time.sleep(PAUSE)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 503):
                raise
            wait = min(60, int(exc.headers.get("Retry-After") or 5 * (attempt + 1)))
            print(f"    (위키백과가 잠시 기다리라고 해요: {wait}초)", flush=True)
            time.sleep(wait)
        except urllib.error.URLError:
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"위키백과 API 실패: {params}")


def clean(text: str) -> str:
    """각주·참고 문헌 같은 꼬리 절은 자르고, == 제목 == 표시는 걷어 낸다."""
    for heading in CUT_HEADINGS:
        found = re.search(NL + r"=+\s*" + re.escape(heading) + r"\s*=+", text)
        if found:
            text = text[: found.start()]
    text = re.sub(NL + r"=+\s*(.*?)\s*=+" + NL, lambda m: NL + m.group(1) + NL, text)
    text = re.sub(NL + "{3,}", NL + NL, text)
    return text.strip()


def fetch_doc(title: str) -> dict[str, Any] | None:
    """{제목, 본문, 링크, 동음이의}. 한 호출에 한 문서만 묻는다. 넘겨주기는 따라가고 continue 는 이어 받는다."""
    params: dict[str, Any] = {
        "action": "query", "prop": "extracts|links|pageprops", "explaintext": 1, "exsectionformat": "wiki",
        "plnamespace": 0, "pllimit": "max", "ppprop": "disambiguation", "redirects": 1, "titles": title,
    }
    name, text, links, disambiguation = None, None, [], False
    while True:
        data = api(**params)
        pages = data.get("query", {}).get("pages", [])
        if not pages or pages[0].get("missing") or pages[0].get("invalid"):
            return None
        page = pages[0]
        name = page["title"]
        text = text if text is not None else page.get("extract")
        links += [link["title"] for link in page.get("links", [])]
        disambiguation = disambiguation or "disambiguation" in page.get("pageprops", {})
        if "continue" not in data:
            break
        params.update(data["continue"])
    if text is None:
        return None
    return {"제목": name, "본문": clean(text), "링크": links, "동음이의": disambiguation}


def first_sentence(text: str, limit: int = 120) -> str:
    head = text.strip().split(NL, 1)[0]
    cut = re.split(r"(?<=[.!?])\s", head, maxsplit=1)[0]
    return cut[:limit] + ("…" if len(cut) > limit else "")


def collect(seeds: list[str], target: int = TARGET) -> tuple[dict[str, str], dict[str, list[str]], dict[str, Any]]:
    docs: dict[str, str] = {}
    raw_links: dict[str, list[str]] = {}
    scores: dict[str, dict[str, Any]] = {}
    excluded: list[dict[str, Any]] = []
    seen: set[str] = set()

    def exclude(title: str, reason: str, **extra: Any) -> None:
        excluded.append({"제목": title, "사유": reason, **extra})
        seen.add(title)

    def add(title: str, is_seed: bool) -> bool:
        if title in seen or title in docs:
            return False
        seen.add(title)
        if SKIP_TITLE.search(title):
            exclude(title, "연도·목록 문서")
            return False
        got = fetch_doc(title)
        if got is None:
            exclude(title, "없는 문서")
            return False
        name, text = got["제목"], got["본문"]
        seen.add(name)
        if name in docs:
            return False
        score = relevance(text)
        info = {"글자수": len(text), "관련어밀도": score["밀도"], "첫문장": first_sentence(text)}
        if name != title:
            info["넘겨주기"] = title
        if SKIP_TITLE.search(name):
            exclude(name, "연도·목록 문서", **info)
            return False
        if got["동음이의"]:
            exclude(name, "동음이의 문서", **info)
            return False
        if len(text) < MIN_CHARS:
            exclude(name, f"토막글 ({len(text):,}자 < {MIN_CHARS:,}자)", **info)
            return False
        if not is_seed and score["밀도"] < MIN_DENSITY:
            exclude(name, f"주제 관련어 1만 자당 {score['밀도']}회 (기준 {MIN_DENSITY:g}회 미만)", 관련어=score, **info)
            return False
        docs[name] = text
        raw_links[name] = got["링크"]
        scores[name] = score
        print(f"  + {name} ({len(text):,}자 · 관련어 {score['밀도']}/만자)", flush=True)
        return True

    print(f"1홉 · 시드 {len(seeds)}건 (관련성 판단 없이 넣는다)", flush=True)
    for seed in seeds:
        add(seed, is_seed=True)
    seed_names = list(docs)
    together: Counter[str] = Counter()
    for name in seed_names:
        for link in set(raw_links[name]):
            together[link] += 1
    print(f"2홉 · 시드의 본문 링크 {len(together)}개 중 여러 시드가 함께 가리키는 것부터", flush=True)
    for title, _ in together.most_common():
        if len(docs) >= target:
            break
        add(title, is_seed=False)
    links = {t: sorted({x for x in targets if x in docs and x != t}) for t, targets in raw_links.items()}
    info = {
        "시드": seed_names,
        "기준": {
            "최소글자수": MIN_CHARS, "관련어최소밀도_1만자당": MIN_DENSITY, "목표문서수": target,
            "관련어": RELEVANCE_TERMS, "시드는관련성판단제외": True,
        },
        "함께가리킨시드수": {t: together[t] for t in docs if t not in seed_names},
        "관련어점수": scores,
        "제외": excluded,
    }
    return docs, links, info


def summarize(docs: dict[str, str], links: dict[str, list[str]], window_tokens: int = 128_000, chars_per_token: float = 2) -> dict[str, Any]:
    chars = sum(len(t) for t in docs.values())
    counts = [len(v) for v in links.values()]
    tokens = chars / chars_per_token
    return {
        "문서수": len(docs),
        "총글자수": chars,
        "문서당링크중앙값": statistics.median(counts) if counts else 0,
        "링크0개문서": [t for t, v in links.items() if not v],
        "추정토큰": round(tokens),
        "창토큰": window_tokens,
        "창배수": round(tokens / window_tokens, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="한국어 위키백과 코퍼스 수집 (2홉 + 주제 관련성)")
    parser.add_argument("--target", type=int, default=TARGET)
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "corpus.json")
    parser.add_argument("--previous", type=Path, help="비교할 이전 corpus.json (바뀐 문서 목록을 남긴다)")
    args = parser.parse_args()
    if not SEEDS:
        raise SystemExit("SEEDS 가 비어 있어요. 파일 맨 위 SEEDS 에 시드 문서 제목을 적어 주세요.")
    docs, links, info = collect(SEEDS, args.target)
    summary = summarize(docs, links)
    info = {"요약": summary, **info}
    if args.previous and args.previous.exists():
        before = set(json.loads(args.previous.read_text(encoding="utf-8"))["docs"])
        after = set(docs)
        info["이전대비"] = {
            "이전파일": args.previous.name, "이전문서수": len(before),
            "빠진문서": sorted(before - after), "새로든문서": sorted(after - before), "유지": len(before & after),
        }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"docs": docs, "links": links}, ensure_ascii=False, indent=1), encoding="utf-8")
    (args.out.parent / "corpus_info.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{NL}문서 수 {summary['문서수']}건 · 총 글자 수 {summary['총글자수']:,}자 · 문서당 링크 수 중앙값 {summary['문서당링크중앙값']}")
    print(f"링크가 0개인 문서 {len(summary['링크0개문서'])}건: {', '.join(summary['링크0개문서']) or '없음'}")
    print(f"약 {summary['추정토큰']:,} 토큰 · 모델 창 {summary['창토큰']:,} 토큰의 {summary['창배수']}배")
    print(f"제외 {len(info['제외'])}건 (사유는 corpus_info.json)")
    if "이전대비" in info:
        diff = info["이전대비"]
        print(f"이전 {diff['이전문서수']}건 대비 · 유지 {diff['유지']} · 빠짐 {len(diff['빠진문서'])} · 새로 듦 {len(diff['새로든문서'])}")
    print(f"저장: {args.out}")


if __name__ == "__main__":
    main()
