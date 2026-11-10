"""실험 기록에서 허위 인용이 어디서 생겼는지 추적한다(REPORT.md 분석용).

허위 인용 = 보고서의 «문서명» 가운데 어느 절도(모든 바퀴 통틀어) 읽지 않은 것. ⑥ 평가와 같은 잣대다.
실행마다 허위 인용 하나하나를 다음으로 나눈다.
- 어디에 나왔나: 절 원고(마지막 원고) / ⑤ 종합이 쓴 머리말·맺음말
- 무엇을 인용했나: 코퍼스에 없는 이름(절 제목·입력 꼬리표 등) / 코퍼스에 있지만 아무도 안 읽은 문서
- ④ 인용 확인(check_citations)이 켜진 실행이면, 그 절이 걸려 다시 보내졌는지

    python analyze_fakes.py            # output/experiments/fakes.json 과 표 출력
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CITE = re.compile(r"«([^»]+)»")


def trace(run_path: Path, corpus: set[str]) -> dict:
    evs = [json.loads(line) for line in run_path.read_text(encoding="utf-8").splitlines()]
    drafts = [e["data"] for e in evs if e["type"] == "draft"]
    reads = {doc for d in drafts for doc in d["읽은문서"]}
    latest: dict[int, dict] = {}
    for d in drafts:
        if d["번호"] not in latest or d["바퀴"] >= latest[d["번호"]]["바퀴"]:
            latest[d["번호"]] = d
    report = next(e["data"]["본문"] for e in evs if e["type"] == "report")
    titles = {d["절"] for d in drafts}
    section_cites = Counter(c for d in latest.values() for c in CITE.findall(d["본문"]))
    report_cites = Counter(CITE.findall(report))
    reviews = [e["data"] for e in evs if e["type"] == "review"]
    flagged_any = {int(n) for r in reviews for n in (r.get("인용확인_걸림") or {})}
    out = []
    for doc, n in report_cites.items():
        if doc in reads:
            continue
        in_sections = section_cites.get(doc, 0)
        where = "절 원고" if in_sections >= n else ("머리말·맺음말" if in_sections == 0 else "절 원고+머리말·맺음말")
        kind = "코퍼스 문서(안 읽음)" if doc in corpus else ("절 제목" if doc in titles else "코퍼스에 없는 이름")
        owners = sorted(d["번호"] for d in latest.values() if doc in CITE.findall(d["본문"]))
        out.append({"인용": doc, "곳": n, "어디": where, "종류": kind, "절": owners,
                    "마지막바퀴": {o: latest[o]["바퀴"] for o in owners},
                    "점검에걸린절": sorted(set(owners) & flagged_any)})
    return {"허위": out, "바퀴": max((r["바퀴"] for r in reviews), default=1),
            "인용확인": any(r.get("인용확인") for r in reviews)}


def main() -> None:
    corpus = set(json.loads((ROOT / "data" / "corpus.json").read_text(encoding="utf-8"))["docs"])
    rows = [json.loads(line) for line in (ROOT / "output" / "experiments" / "results.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    result = {}
    by_kind = defaultdict(Counter)
    for r in rows:
        t = trace(ROOT / "runs" / f"{r['run_id']}.jsonl", corpus)
        result[r["run_id"]] = t
        for f in t["허위"]:
            by_kind[r["설정"]][(f["어디"], f["종류"])] += f["곳"]
        if t["허위"]:
            print(f"{r['run_id']:24s} " + " | ".join(
                f"«{f['인용']}» {f['곳']}곳 · {f['어디']} · {f['종류']} · 절{f['절']} 바퀴{f['마지막바퀴']}"
                + (f" · 점검에 걸림{f['점검에걸린절']}" if f["점검에걸린절"] else "") for f in t["허위"]))
    print("\n설정별 허위 인용(어디·종류별 곳 수)")
    for name, c in by_kind.items():
        print(f"  {name:14s} " + " · ".join(f"{w}/{k} {n}" for (w, k), n in c.most_common()))
    (ROOT / "output" / "experiments" / "fakes.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
