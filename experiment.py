"""실험: 설정마다 같은 질문을 세 번씩 돌려 지표를 견준다.

교안에서 가져온 비교 두 가지와, 이 저장소에서 더한 규칙 하나를 견준다.
- 장치 하나씩 끄기 (교안 장면 8): 장치를 하나 껐을 때 어느 숫자가 움직였는지로 그 장치가 하는 일을 본다.
  역할(use_roles) · 시작 문서 배정(assign_seeds) · 피하기 목록(respect_zones)은 원본 pipeline.py 의
  --no-roles · --no-assign · --no-zones 와 같은 스위치이고, 다시 보내기(redispatch)는 6노드에서 더한 장치다.
- 같은 예산 나누기 (교안 장면 4): 읽는 양이 같을 때 나누는 모양만 바꾼다(2절×4건 · 4절×2건, 둘 다 8건).
  기본 4절×3건과 견준다.
- ④ 인용 확인(check_citations, 교안 밖 규칙): 끔(기본)과 켬, 그리고 켬 + 다시 보낼 때 허위 인용 정리(clean_citations, 11-10 추가).

    python experiment.py                 # 아직 안 돈 실행만 이어서 돌린다(실제 호출, 키 필요)
    python experiment.py --dry           # 키 없이 가짜 모델로 도구만 점검한다(기록은 임시 폴더)
    python experiment.py --summarize     # 결과를 모아 output/experiments/summary.md 로 정리한다

실행 ID는 exp-<설정>-<질문>-<회차> 로 정해져 있어, 중간에 멈춰도 이어서 돌릴 수 있다.
실행 기록(runs/<ID>.jsonl)은 화면에서 재생할 수 있고, 결과 한 줄은 output/experiments/results.jsonl 에 쌓인다.
"""

from __future__ import annotations

import argparse
import json
import statistics
import tempfile
import time
from pathlib import Path
from typing import Any

import events
import runner
from graph import ROOT, load_config

OUT = ROOT / "output" / "experiments"
RESULTS = OUT / "results.jsonl"
REPEATS = 3
MAX_CALLS = 54  # 사용자가 정한 실제 실행 상한(실패 포함): 처음 50번, 11-10 cite-fix 6번을 더해 54번
QUESTION_IDS = ["Q2", "Q3"]

# 이름 → (무리, 설명, 기본에서 바꾸는 설정)
SETTINGS: dict[str, tuple[str, str, dict[str, Any]]] = {
    "base": ("기본", "4절×3건 · 모든 장치 켬 · 인용 확인 끔", {}),
    "no-roles": ("장치 끄기", "역할을 붙이지 않음(모두 기본 역할)", {"use_roles": False}),
    "no-assign": ("장치 끄기", "시작 문서를 나눠 주지 않음", {"assign_seeds": False}),
    "no-zones": ("장치 끄기", "피하기 목록을 쓰지 않음", {"respect_zones": False}),
    "no-redispatch": ("장치 끄기", "④ 점검이 부족한 절을 다시 보내지 않음", {"redispatch": False}),
    "s2b4": ("같은 예산", "2절×4건 (읽기 8건)", {"max_sections": 2, "budget": 4}),
    "s4b2": ("같은 예산", "4절×2건 (읽기 8건)", {"max_sections": 4, "budget": 2}),
    "cite-on": ("인용 확인", "④ 인용 확인 켬", {"check_citations": True}),
    # 11-10 추가: cite-on 에서 다시 쓴 원고가 지난 원고의 허위 인용을 베꼈다. 다시 보낼 때 지워서 넘기는 보강을 견준다
    "cite-fix": ("인용 확인", "④ 인용 확인 켬 + 다시 보낼 때 허위 인용 지우고 인용할 수 있는 문서 알려 주기",
                 {"check_citations": True, "clean_citations": True}),
}
METRICS = [("근거비율", "근거 비율", "pct"), ("허위인용", "허위 인용", "int"), ("읽고안쓴문서", "읽고 안 쓴 문서", "int"),
           ("편중", "편중", "pct"), ("중복률", "중복률", "pct")]


def questions() -> dict[str, str]:
    raw = json.loads((ROOT / "data" / "questions.json").read_text(encoding="utf-8"))
    return {q["id"]: q["질문"] for q in raw["questions"]}


def plan() -> list[tuple[str, str, int]]:
    return [(name, qid, k) for qid in QUESTION_IDS for name in SETTINGS for k in range(1, REPEATS + 1)]


def run_id(name: str, qid: str, k: int) -> str:
    return f"exp-{name}-{qid}-{k}"


def done_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {json.loads(line)["run_id"] for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def usage(events_path: Path) -> dict[str, Any]:
    """기록에서 모델 호출 수·글자 수·바퀴·인용 확인에 걸린 절을 센다."""
    calls = chars_in = chars_out = 0
    rounds, sections, flagged, redispatched = 1, 0, 0, 0
    for line in events_path.read_text(encoding="utf-8").splitlines():
        e = json.loads(line)
        d = e.get("data") or {}
        if e["type"] == "llm_start":
            calls += 1
            chars_in += d.get("chars_in", 0)
        elif e["type"] == "llm_end":
            chars_out += d.get("chars_out", 0)
        elif e["type"] == "dispatch":
            rounds = max(rounds, d.get("바퀴", 1))
            if d.get("바퀴", 1) == 1:
                sections = len(d.get("배정", []))
            else:
                redispatched += len(d.get("배정", []))
        elif e["type"] == "review":
            flagged += len(d.get("인용확인_걸림") or {})
    return {"호출": calls, "입력글자": chars_in, "출력글자": chars_out, "바퀴": rounds, "절": sections,
            "다시보낸절": redispatched, "인용확인걸림": flagged}


class FakeModel:
    """--dry 용: 키 없이 그래프가 끝까지 도는지만 본다."""

    def __call__(self, step, prompt) -> str:
        import re

        from pipeline import Step
        if step == Step.PLAN:
            return json.dumps({"제목": "점검", "목차": [{"절": f"절{i}", "지시": "점검", "역할": "", "시작문서": ""} for i in range(4)]}, ensure_ascii=False)
        if step == Step.READ:
            return "요약"
        if step == Step.PICK:
            cands = re.search(r"\[후보\] (.+)", prompt.user)
            return json.dumps({"문서": cands.group(1).split(", ")[0] if cands else None}, ensure_ascii=False)
        if step == Step.WRITE:
            docs = re.findall(r"^\[([^\]\n]+)\]$", prompt.user, re.M)
            doc = next((d for d in docs if d not in ("맡은 절", "지시", "모은 자료")), "없음")
            return json.dumps({"본문": " ".join(f"문장 {i}은 점검용으로 길게 쓴 문장이다 «{doc}»." for i in range(8)), "충분": "예", "부족": ""}, ensure_ascii=False)
        return '{"머리말":"머리말","맺음말":"맺음말"}'


def run_all(dry: bool) -> None:
    config = load_config()
    qs = questions()
    out = OUT if not dry else Path(tempfile.mkdtemp(prefix="exp-dry-"))
    runs_dir = runner.RUNS_DIR if not dry else out
    results = out / "results.jsonl"
    (out / "reports").mkdir(parents=True, exist_ok=True)
    if not dry and runner.ready_problems(config) :
        raise SystemExit("실행할 수 없어요: " + " · ".join(runner.ready_problems(config)))
    todo = [(n, q, k) for n, q, k in plan() if run_id(n, q, k) not in done_ids(results)]
    attempted = sum(1 for _ in done_ids(results))
    print(f"실험 {len(plan())}번 중 남은 {len(todo)}번 · 이미 시도 {attempted}번 · 상한 {MAX_CALLS}번{' · 점검(가짜 모델)' if dry else ''}")
    for name, qid, k in todo:
        if not dry and attempted >= MAX_CALLS:
            print(f"상한 {MAX_CALLS}번에 닿아 멈춘다")
            break
        rid = run_id(name, qid, k)
        group, desc, overrides = SETTINGS[name]
        bus = events.EventBus(rid, runs_dir / f"{rid}.jsonl")
        row: dict[str, Any] = {"run_id": rid, "설정": name, "무리": group, "설명": desc, "바꾼설정": overrides,
                               "질문ID": qid, "질문": qs[qid], "회차": k}
        started = time.monotonic()
        try:
            result = runner.execute(qs[qid], bus, config, inner=FakeModel() if dry else None,
                                    mode="점검" if dry else "실제 호출", save=False, **overrides)
            row.update(지표=result["metrics"], 보고서글자수=len(result["report"]), 오류=None)
            (out / "reports" / f"{rid}.md").write_text(result["report"], encoding="utf-8")
        except Exception as exc:  # 실패도 한 번의 시도로 센다(상한에 포함)
            row.update(지표=None, 보고서글자수=0, 오류=events.redact(f"{type(exc).__name__}: {exc}")[:300])
        finally:
            bus.close()
        row["걸린초"] = round(time.monotonic() - started, 1)
        row.update(usage(bus.path))
        with results.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(row, ensure_ascii=False) + "\n")
        attempted += 1
        m = row["지표"]
        print(f"[{attempted:2d}] {rid:24s} {row['걸린초']:5.1f}초 · 호출 {row['호출']} · "
              + (f"근거 {m['근거비율']:.1%} · 허위 {m['허위인용']} · 안 쓴 {m['읽고안쓴문서']} · 편중 {m['편중']:.1%} · 중복 {m['중복률']:.1%}" if m else f"실패: {row['오류']}"),
              flush=True)
    if dry:
        print("점검 기록:", out)


def fmt(value: float, kind: str) -> str:
    return f"{value * 100:.1f}%" if kind == "pct" else f"{value:.1f}" if value != int(value) else f"{int(value)}"


def summarize() -> None:
    rows = [json.loads(line) for line in RESULTS.read_text(encoding="utf-8").splitlines() if line.strip()]
    ok = [r for r in rows if r["지표"]]
    table: dict[str, Any] = {}
    lines = ["# 실험 결과 요약", "", f"실행 {len(rows)}번 (성공 {len(ok)} · 실패 {len(rows) - len(ok)}). 칸의 값은 세 번의 평균이고, 괄호는 최솟값–최댓값이다.", ""]
    for qid in QUESTION_IDS:
        lines += [f"## {qid}", "", "| 설정 | 무리 | 근거 비율 | 허위 인용 | 읽고 안 쓴 | 편중 | 중복률 | 절 | 다시 보낸 절 | 호출 | 입력 글자 |",
                  "|---|---|---|---|---|---|---|---|---|---|---|"]
        for name, (group, desc, _) in SETTINGS.items():
            rs = [r for r in ok if r["설정"] == name and r["질문ID"] == qid]
            if not rs:
                lines.append(f"| `{name}` | {group} | — | — | — | — | — | — | — | — | — |")
                continue
            cells = []
            for key, _, kind in METRICS:
                vals = [r["지표"][key] for r in rs]
                cells.append(f"{fmt(statistics.mean(vals), kind)} ({fmt(min(vals), kind)}–{fmt(max(vals), kind)})")
            extra = [fmt(statistics.mean(r[k] for r in rs), "n") for k in ("절", "다시보낸절", "호출")]
            chars = f"{statistics.mean(r['입력글자'] for r in rs):,.0f}"
            lines.append(f"| `{name}` | {group} | " + " | ".join(cells + extra + [chars]) + " |")
            table[f"{qid}/{name}"] = {"n": len(rs), **{key: [r["지표"][key] for r in rs] for key, _, _ in METRICS},
                                      **{k: [r[k] for r in rs] for k in ("절", "다시보낸절", "호출", "입력글자", "인용확인걸림", "보고서글자수")}}
        lines.append("")
    lines += ["## 설정", "", "| 이름 | 무리 | 뜻 | 바꾼 설정 |", "|---|---|---|---|"]
    lines += [f"| `{n}` | {g} | {d} | `{json.dumps(o, ensure_ascii=False) if o else '—'}` |" for n, (g, d, o) in SETTINGS.items()]
    total_in = sum(r["입력글자"] for r in rows)
    lines += ["", f"모델 호출 {sum(r['호출'] for r in rows):,}번 · 입력 {total_in:,}자 · 출력 {sum(r['출력글자'] for r in rows):,}자 · 걸린 시간 {sum(r['걸린초'] for r in rows) / 60:.1f}분"]
    fails = [r for r in rows if not r["지표"]]
    if fails:
        lines += ["", "실패한 실행:", *[f"- `{r['run_id']}`: {r['오류']}" for r in fails]]
    (OUT / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (OUT / "summary.json").write_text(json.dumps(table, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description="설정별 3회 반복 실험")
    parser.add_argument("--dry", action="store_true", help="키 없이 가짜 모델로 도구만 점검한다")
    parser.add_argument("--summarize", action="store_true", help="결과를 모아 summary.md 로 정리한다")
    args = parser.parse_args()
    if args.summarize:
        summarize()
    else:
        run_all(args.dry)


if __name__ == "__main__":
    main()
