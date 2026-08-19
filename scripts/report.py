"""측정 결과 집계 및 리포트 (ASSET_TRANSFER_TEST_PLAN.md §8).

    python scripts/report.py results/transfer_20260810_2100_commercial.json
    python scripts/report.py results/transfer_*_loopback.json results/transfer_*_commercial.json

여러 파일을 함께 주면 경로(label)별로 나란히 놓고, loopback 상한 대비 commercial
처리량 비율까지 계산한다 (§8.3).

집계 규칙 (§8.1) — 표본 수에 따라 신뢰할 수 있는 백분위만 낸다.
    n < 30        p50 만
    30 ≤ n < 100  p50, p95
    n ≥ 100       p50, p95, p99
n=10 에서 p99 는 최댓값을 그렇게 부르는 것에 불과하므로 계산하지 않는다.

출력: results/summary_{YYYYMMDD}.md
"""
from __future__ import annotations

import _pathfix  # noqa: F401

import argparse
import datetime
import json
import statistics
import sys
from pathlib import Path

from common import RESULTS_DIR

NA = "—"


def percentile(values: list[float], q: float) -> float:
    """nearest-rank. 표본이 적을 때 보간값보다 해석이 명확하다."""
    if not values:
        return float("nan")
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(q / 100 * len(s) + 0.5)) - 1))
    return s[k]


def stats_for(values: list[float]) -> dict:
    """§8.1 의 표본 수 규칙을 적용한 요약. 못 내는 백분위는 None 으로 비운다."""
    n = len(values)
    if n == 0:
        return {"n": 0, "p50": None, "p95": None, "p99": None, "mean": None,
                "stddev": None, "cv": None}
    mean = statistics.fmean(values)
    stddev = statistics.stdev(values) if n > 1 else 0.0
    return {
        "n": n,
        "p50": percentile(values, 50),
        "p95": percentile(values, 95) if n >= 30 else None,
        "p99": percentile(values, 99) if n >= 100 else None,
        "mean": mean,
        "stddev": stddev,
        "cv": (stddev / mean) if mean else None,
    }


def fmt(value: float | None, digits: int = 1) -> str:
    return NA if value is None else f"{value:,.{digits}f}"


def load(paths: list[Path]) -> list[dict]:
    sessions = []
    for p in paths:
        data = json.loads(p.read_text())
        if "meta" not in data or "samples" not in data:
            raise SystemExit(f"{p}: transfer_*.json 형식이 아니다 (meta/samples 없음)")
        data["_path"] = str(p)
        sessions.append(data)
    return sessions


def clean(samples: list[dict]) -> tuple[list[dict], int]:
    """스로틀 오염 샘플과 실패 요청을 뺀다. 제외한 개수를 함께 돌려준다 (§5.3, §8.3)."""
    kept, dropped = [], 0
    for s in samples:
        if s.get("throttled"):
            dropped += 1
            continue
        if s.get("http_code") and int(s["http_code"]) >= 400:
            dropped += 1
            continue
        if float(s.get("elapsed_ms") or 0) <= 0:
            dropped += 1
            continue
        kept.append(s)
    return kept, dropped


# --------------------------------------------------------------------------
# 표 1 — 다운로드
# --------------------------------------------------------------------------

def table_download(sessions: list[dict]) -> tuple[list[str], dict, list[str]]:
    rows: list[str] = []
    warnings: list[str] = []
    # (label, variant, C) → 처리량 중앙값. §8.3 의 loopback 대비 비율 계산에 쓴다.
    median_tp: dict[tuple[str, str, int], float] = {}

    # 하네스를 키에 넣는다. 라벨만으로 묶으면 브라우저(보조) 샘플이 CLI(권위) 행에
    # 합쳐져 한 숫자가 되고, §9 "브라우저 측정값을 권위 데이터로 쓰지 말 것" 이 깨진다.
    groups: dict[tuple[str, str, str, int], list[dict]] = {}
    excluded: dict[tuple[str, str, str, int], int] = {}
    for sess in sessions:
        label = sess["meta"]["label"]
        harness = sess["meta"].get("harness", "cli")
        for s in sess["samples"]:
            if s["direction"] != "download":
                continue
            key = (label, harness, s["variant"], s["concurrency"])
            if s.get("throttled") or (s.get("http_code") and int(s["http_code"]) >= 400):
                excluded[key] = excluded.get(key, 0) + 1
                continue
            groups.setdefault(key, []).append(s)

    # CLI 를 먼저 놓고 브라우저를 아래에 붙인다.
    for key in sorted(groups, key=lambda k: (k[0], k[1] != "cli", k[2], k[3])):
        label, harness, variant, c = key
        rs = groups[key]
        el = stats_for([s["elapsed_ms"] for s in rs])
        tp = stats_for([s["throughput_mbps"] for s in rs])
        # loopback 대비 비율은 권위 데이터(CLI)로만 계산한다.
        if harness == "cli":
            median_tp[(label, variant, c)] = tp["p50"]
        size_mb = rs[0]["file_size_bytes"] / 1e6
        cv_flag = " ⚠️" if tp["cv"] and tp["cv"] > 0.5 else ""
        mark = "" if harness == "cli" else " *(보조)*"
        rows.append(
            f"| {label} | {harness}{mark} | {variant} ({size_mb:.1f}MB) | {c} | {el['n']} | "
            f"{fmt(el['p50'])} | {fmt(el['p95'])} | {fmt(tp['p50'], 2)} | "
            f"{fmt(tp['cv'], 3)}{cv_flag} | {excluded.get(key, 0)} |"
        )
        if tp["cv"] and tp["cv"] > 0.5:
            warnings.append(
                f"{label}/{harness}/{variant}/C={c}: 처리량 CV {tp['cv']:.2f} > 0.5 — "
                f"측정 환경 불안정 (§11)"
            )
        # 보조 데이터의 표본 부족은 보고 대상이 아니다 — 애초에 권위 데이터가 아니다.
        if el["n"] < 30 and harness == "cli":
            warnings.append(f"{label}/{variant}/C={c}: n={el['n']} — p95 미산출 (§8.1)")

    lines = [
        "### 표 1 — 다운로드",
        "",
        "| 경로 | 하네스 | 변형 | C | n | p50(ms) | p95(ms) | 처리량 중앙값(Mbps) | CV | 제외(스로틀) |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
        *rows,
        "",
        "`CV = stddev / mean` (처리량). **지터가 아니다** — 지터는 RTT 연속 샘플 간 "
        "변화량이며 동기화 측정에서만 쓰는 별개 지표다. 여기서는 처리량 변동성이다.",
        "",
        "**발표·집계에 쓰는 수치는 `cli` 행이다** (§9). `browser` 행은 정합성 확인용 "
        "보조 데이터이며, 커넥션 재사용·호스트당 동시 요청 제한 때문에 같은 회선에서도 "
        "다른 값이 나온다.",
        "",
    ]
    return lines, median_tp, warnings


# --------------------------------------------------------------------------
# 표 2 — 업로드
# --------------------------------------------------------------------------

def table_upload(sessions: list[dict]) -> tuple[list[str], list[str]]:
    rows: list[str] = []
    warnings: list[str] = []
    groups: dict[tuple[str, str], list[dict]] = {}
    excluded: dict[tuple[str, str], int] = {}

    for sess in sessions:
        label = sess["meta"]["label"]
        harness = sess["meta"].get("harness", "cli")
        for s in sess["samples"]:
            if s["direction"] != "upload":
                continue
            key = (f"{label}/{harness}" if harness != "cli" else label, s["asset"])
            if s.get("throttled") or (s.get("http_code") and int(s["http_code"]) >= 400):
                excluded[key] = excluded.get(key, 0) + 1
                continue
            groups.setdefault(key, []).append(s)

    if not groups:
        return ["### 표 2 — 업로드", "", "측정 데이터 없음.", ""], warnings

    for key in sorted(groups):
        label, asset = key
        rs = groups[key]
        el = stats_for([s["elapsed_ms"] for s in rs])
        tp = stats_for([s["throughput_mbps"] for s in rs])
        size_mb = rs[0]["file_size_bytes"] / 1e6

        # §6.2 — 서버가 실제로 일한 시간은 store + db 다.
        # recv 는 서버가 본문을 수신한 시간(=네트워크 시간)이므로 여기서 빼면 이중 차감이 된다.
        work = [(s["srv_store_ms"] or 0) + (s["srv_db_ms"] or 0)
                for s in rs if s["srv_store_ms"] is not None or s["srv_db_ms"] is not None]
        work_p50 = percentile(work, 50) if work else None
        share = (work_p50 / el["p50"] * 100) if (work_p50 and el["p50"]) else None

        rows.append(
            f"| {asset} ({label}) | {size_mb:.2f} MB | {el['n']} | {fmt(el['p50'])} | "
            f"{fmt(el['p95'])} | {fmt(tp['p50'], 2)} | {fmt(work_p50)} | {fmt(share, 1)} |"
        )
        if not work:
            warnings.append(
                f"{label}/{asset}: 서버 구간 타이밍이 없다 — 변환 시간이 응답에 섞였는지 "
                f"확인 불가 (§6.1, §11)"
            )
        elif share is not None and share > 50:
            warnings.append(
                f"{label}/{asset}: 서버 작업이 응답 시간의 {share:.0f}% — "
                f"동기 변환이 섞였을 가능성 (§11)"
            )

    lines = [
        "### 표 2 — 업로드",
        "",
        "| 파일 | 크기 | n | p50(ms) | p95(ms) | 처리량 중앙값(Mbps) | 서버 작업(ms) | 서버 비중(%) |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
        *rows,
        "",
        "`서버 작업 = store + db`. `recv` 는 서버가 본문을 수신한 시간, 즉 네트워크 시간이므로 "
        "빼지 않는다 — 빼면 네트워크를 이중 차감해 9월 KOREN 개선폭을 과소평가한다.",
        "`network_ms = elapsed_ms - 서버 작업`.",
        "",
    ]
    return lines, warnings


# --------------------------------------------------------------------------
# 표 3 — 압축 효과
# --------------------------------------------------------------------------

def table_compression(sessions: list[dict], label: str | None) -> tuple[list[str], list[str]]:
    """크기 절감률과 시간 절감률의 차이가 전송 외 고정 비용(RTT·핸드셰이크)이다."""
    warnings: list[str] = []
    # 경로를 섞으면 비교가 무의미하다. label 이 지정되지 않으면 commercial 을 우선한다.
    labels = [s["meta"]["label"] for s in sessions]
    use = label or ("commercial" if "commercial" in labels else labels[0] if labels else None)
    if use is None:
        return ["### 표 3 — 압축 효과", "", "측정 데이터 없음.", ""], warnings

    by_variant: dict[str, list[dict]] = {}
    for sess in sessions:
        # 권위 데이터만 쓴다. 브라우저 샘플을 섞으면 커넥션 재사용 여부가 변형별로
        # 달라져 압축 효과가 아닌 것을 재게 된다.
        if sess["meta"]["label"] != use or sess["meta"].get("harness", "cli") != "cli":
            continue
        for s in sess["samples"]:
            # 압축 효과는 동시성 1 에서만 비교한다. C 가 다르면 회선 포화가 섞인다.
            if s["direction"] == "download" and s["concurrency"] == 1 and not s.get("throttled"):
                by_variant.setdefault(s["variant"], []).append(s)

    if "raw" not in by_variant:
        warnings.append(f"표 3: '{use}' 경로에 raw C=1 데이터가 없어 절감률 기준점이 없다")
        return ["### 표 3 — 압축 효과", "",
                f"기준점(raw C=1)이 없어 계산하지 않았다. 경로 `{use}`.", ""], warnings

    raw_size = by_variant["raw"][0]["file_size_bytes"]
    raw_p50 = percentile([s["elapsed_ms"] for s in by_variant["raw"]], 50)

    rows = []
    for variant in ("raw", "meshopt", "draco"):
        rs = by_variant.get(variant)
        if not rs:
            continue
        size = rs[0]["file_size_bytes"]
        p50 = percentile([s["elapsed_ms"] for s in rs], 50)
        size_saving = (1 - size / raw_size) * 100
        time_saving = (1 - p50 / raw_p50) * 100 if raw_p50 else None
        rows.append(
            f"| {variant} | {size / 1e6:,.2f} MB | {size_saving:.1f}% | "
            f"{p50:,.1f} ms | {fmt(time_saving)}% |"
        )

    lines = [
        "### 표 3 — 압축 효과",
        "",
        f"경로 `{use}`, C=1 기준.",
        "",
        "| 변형 | 파일 크기 | 절감률 | p50 전송 시간 | 시간 절감률 |",
        "|---|---:|---:|---:|---:|",
        *rows,
        "",
        "크기 절감률과 시간 절감률의 차이가 전송 외 고정 비용(RTT, 핸드셰이크)이다.",
        "",
    ]
    return lines, warnings


# --------------------------------------------------------------------------
# 리포트
# --------------------------------------------------------------------------

def rtt_description(sess: dict) -> tuple[str, list[str]]:
    """서버 RTT 를 서술한다. **못 잰 경우 0 을 값으로 적지 않는다.**

    ICMP 가 막힌 서버에서는 ping 이 100% 손실로 끝나고 `server_rtt_avg_ms` 가 0 이 된다.
    그걸 "RTT 0ms" 로 적으면 없는 근거를 만드는 것이다. 이 경우 다운로드 샘플의 TTFB
    중앙값을 대용 지표로 제시한다 — TTFB 에는 왕복 한 번과 서버 응답 시작이 들어 있어
    RTT 의 상한 근사로 읽을 수 있다.
    """
    m = sess["meta"]
    d = m.get("diagnostics", {})
    raw = (m.get("diagnostics_raw") or {}).get("server_ping") or {}
    loss = raw.get("packet_loss_pct")
    avg = d.get("server_rtt_avg_ms")

    if avg and loss != 100.0:
        return (f"서버 RTT: avg {avg} ms (mdev {d.get('server_rtt_mdev_ms')}) · "
                f"손실 {loss if loss is not None else 'N/A'}%"), []

    if raw:
        # ping 을 돌렸고 실패한 경우.
        head = (f"서버 RTT: **측정 실패** — ping {raw.get('count', '?')}발 전부 손실"
                f"{f' ({loss:.0f}%)' if loss is not None else ''}. ICMP 가 차단돼 있다.")
        warn = (f"`{m['session_id']}`: 서버 ICMP 가 차단돼 §8.3 의 서버 RTT 를 ping 으로 "
                f"낼 수 없다")
    else:
        # 애초에 ping 을 돌리지 않은 경우 (브라우저 하네스). 실패로 적으면 안 된다.
        head = ("서버 RTT: **미측정** — 이 하네스는 ping 을 실행할 수 없다.")
        warn = (f"`{m['session_id']}`: ping 을 실행할 수 없는 하네스라 §8.3 의 서버 RTT 가 "
                f"없다 — 같은 시각 CLI 세션 값을 인용할 것")

    # 다운로드 TTFB 만 RTT 대용이 된다. 업로드의 TTFB 는 본문을 다 보낸 뒤 서버가 응답을
    # 시작한 시각이라 전송 시간 전체가 들어 있고, RTT 와는 자릿수가 다르다.
    ttfb = [s["ttfb_ms"] for s in sess["samples"]
            if s["direction"] == "download" and s.get("ttfb_ms") and not s.get("throttled")]
    if ttfb:
        return (f"{head} 대용: 다운로드 TTFB 중앙값 **{percentile(ttfb, 50):.1f} ms** "
                f"(왕복 1회 + 서버 응답 시작을 포함하므로 RTT 의 상한 근사)",
                [warn + " — 다운로드 TTFB 를 대용으로 기재했다"])
    return (f"{head} 이 세션에는 다운로드 샘플이 없어 대용 지표도 없다 "
            f"(업로드 TTFB 는 본문 전송이 끝난 뒤의 시각이라 RTT 대용이 될 수 없다). "
            f"같은 시각 다운로드 세션의 값을 참조할 것",
            [warn + " — 이 세션에는 대용 지표도 없다"])


def traceroute_description(sess: dict) -> str:
    """홉 수를 서술한다. 목적지에 도달하지 못한 trace 의 홉 수는 의미가 없다."""
    m = sess["meta"]
    tr = (m.get("diagnostics_raw") or {}).get("traceroute") or {}
    hops = tr.get("hops") or []
    reported = m.get("diagnostics", {}).get("traceroute_hops")
    if not hops:
        return "traceroute 없음"
    # 마지막 줄이 무응답(`*`)이면 max TTL 까지 못 닿은 것이다. 그 숫자는 홉 수가 아니다.
    last = hops[-1].strip()
    if last.endswith("*"):
        answered = [h for h in hops if not h.strip().endswith("*")]
        return (f"**목적지 미도달** — {len(answered)}홉까지만 응답하고 이후 무응답 "
                f"(max TTL 까지 `*`). ICMP 차단이므로 `{reported} hops` 는 실제 경로 길이가 아니다")
    return f"{reported} hops"


def session_context(sessions: list[dict]) -> tuple[list[str], list[str]]:
    """§8.3 이 리포트에 반드시 명시하라고 한 항목들."""
    lines = ["## 측정 조건", ""]
    warnings: list[str] = []
    for sess in sessions:
        m = sess["meta"]
        d = m.get("diagnostics", {})
        started = m.get("started_at", "")
        hour = started[11:16] if len(started) > 16 else "?"
        lines.append(
            f"- **{m['label']}** · `{m['session_id']}` · {m.get('location')} / "
            f"{m.get('network_type')} · ISP {m.get('isp') or 'N/A'} · {started[:10]} {hour} "
            f"· 타겟 `{m.get('target_url')}` · 하네스 {m.get('harness')}"
        )
        srv = m.get("server", {})
        lines.append(
            f"  - 서버: {srv.get('instance_type')} / {srv.get('region')} / "
            f"{srv.get('ebs_type')} / 서빙 {srv.get('serving')} / "
            f"버전 {srv.get('software_version') or 'N/A'}"
        )
        # 브라우저에서는 speedtest 를 돌릴 수 없어 0 이 들어온다. 0 을 회선 속도로 적으면
        # "회선이 0 Mbps" 라는 없는 사실이 표에 남는다.
        if d.get("speedtest_down_mbps") or d.get("speedtest_up_mbps"):
            lines.append(
                f"  - 회선: ↓{d.get('speedtest_down_mbps')} / ↑{d.get('speedtest_up_mbps')} Mbps"
            )
        else:
            note = m.get("diagnostics_note") or "회선 진단을 실행하지 않았다"
            lines.append(f"  - 회선: **미측정** — {note}")
        rtt_line, rtt_warn = rtt_description(sess)
        lines.append(f"  - {rtt_line}")
        warnings += rtt_warn
        lines.append(f"  - 경로: {traceroute_description(sess)}")
        if m.get("network_type") == "wifi":
            mdev = d.get("router_rtt_mdev_ms")
            if mdev:
                rp = (m.get("diagnostics_raw") or {}).get("router_ping") or {}
                spike = (f", 최대 {rp['max_ms']} ms" if rp.get("max_ms") else "")
                avg_rtt = d.get("router_rtt_avg_ms")
                # 스파이크 언급은 실제로 mdev > avg 일 때만 한다. 조건 없이 적으면
                # 안정적인 세션에도 불안정하다는 문장이 붙는다.
                spiky = (" mdev 가 avg 보다 크다 — 간헐적 스파이크가 있다는 뜻이다."
                         if avg_rtt and mdev > avg_rtt else "")
                lines.append(
                    f"  - **Wi-Fi 한계**: 공유기 RTT avg {avg_rtt} ms / "
                    f"mdev **{mdev} ms**{spike} — 이 노이즈가 아래 모든 측정값에 포함되어 있다. "
                    f"공유기까지의 변동이 곧 Wi-Fi 구간 노이즈 바닥값이다.{spiky}"
                )
            else:
                # 0 을 "노이즈 0ms" 로 적으면 없는 근거를 만들어내는 것이다.
                lines.append(
                    "  - **Wi-Fi 한계**: 공유기 RTT 를 측정하지 않아 Wi-Fi 구간 노이즈를 "
                    "수치로 밝힐 수 없다. 아래 측정값에는 정량화되지 않은 Wi-Fi 노이즈가 포함되어 있다"
                )
                warnings.append(
                    f"`{m['session_id']}`: Wi-Fi 측정인데 공유기 RTT mdev 가 없다 — "
                    f"§8.3 이 요구하는 한계 명시를 할 수 없다"
                )
        tw = m.get("throttle_watch", {})
        lines.append(
            f"  - 스로틀 감시: {'켜짐' if tw.get('enabled') else '**꺼짐**'} · "
            f"iface `{tw.get('interface') or 'N/A'}` · "
            f"카운터 못 읽은 라운드 {tw.get('rounds_counter_unavailable', 0)}회"
        )
        if not tw.get("enabled"):
            warnings.append(f"{m['label']}: 스로틀 감시가 꺼진 세션 — §5.3 위반, 집계 신뢰 불가")
        seen = m.get("server_timing_headers_seen") or []
        if seen:
            lines.append(f"  - 서버 타이밍 헤더 실측 이름: `{'`, `'.join(seen)}`")

        # 중간에 끊긴 세션을 완료된 것으로 집계하면 n 이 조용히 줄어든 표가 나온다.
        if m.get("complete") is False:
            lines.append("  - **미완료 세션**: 측정이 끝나기 전에 저장된 파일이다. "
                         "아래 표의 n 은 계획된 표본 수보다 적다")
            warnings.append(f"{m['label']}: 미완료 세션(`complete: false`)을 집계에 포함했다")

        _kept, dropped = clean(sess["samples"])
        lines.append(f"  - 제외 샘플: {dropped} / 전체 {len(sess['samples'])}")
        lines.append(f"  - 실행 명령: `{m.get('command', 'N/A')}`")
    lines.append("")
    return lines, warnings


def loopback_ratio(median_tp: dict) -> tuple[list[str], list[str]]:
    """§8.3 — loopback 상한 대비 commercial 처리량 비율. §11 의 3배 기준도 여기서 본다."""
    lines: list[str] = []
    warnings: list[str] = []
    pairs = []
    for (label, variant, c), tp in median_tp.items():
        if label != "loopback" or c != 1 or not tp:
            continue
        com = median_tp.get(("commercial", variant, 1))
        if com:
            pairs.append((variant, tp, com))
    if not pairs:
        return [], warnings

    lines += ["### loopback 상한 대비 commercial", "",
              "| 변형 | loopback C=1 (Mbps) | commercial C=1 (Mbps) | commercial/loopback |",
              "|---|---:|---:|---:|"]
    for variant, lb, com in sorted(pairs):
        lines.append(f"| {variant} | {lb:,.2f} | {com:,.2f} | {com / lb * 100:.1f}% |")
        if lb < com * 3:
            warnings.append(
                f"{variant}: loopback 처리량 {lb:,.1f} Mbps 가 commercial "
                f"{com:,.1f} Mbps 의 3배 미만 — tmpfs 가 안 걸렸거나 서버가 병목이다. "
                f"그대로 진행하면 네트워크가 아니라 서버 성능을 재게 된다 (§11)"
            )
    lines.append("")
    return lines, warnings


def build_report(sessions: list[dict], compression_label: str | None) -> tuple[str, list[str]]:
    warnings: list[str] = []

    ctx, w = session_context(sessions)
    warnings += w
    t1, median_tp, w = table_download(sessions)
    warnings += w
    t2, w = table_upload(sessions)
    warnings += w
    t3, w = table_compression(sessions, compression_label)
    warnings += w
    ratio, w = loopback_ratio(median_tp)
    warnings += w

    total = sum(len(s["samples"]) for s in sessions)
    dropped = sum(clean(s["samples"])[1] for s in sessions)

    body = [
        *ctx,
        "## 집계",
        "",
        f"전체 샘플 {total}건 중 **{dropped}건 제외** (스로틀 오염·실패). "
        f"모든 표에 `n` 을 병기했다.",
        "",
        "백분위 규칙 (§8.1): `n < 30` → p50 만 · `30 ≤ n < 100` → p50·p95 · "
        "`n ≥ 100` → p50·p95·p99. 낼 수 없는 값은 " + NA + " 로 비웠다.",
        "",
        *t1,
        *t2,
        *t3,
        *ratio,
    ]

    if warnings:
        body += ["## 보고 대상 (§11)", ""]
        body += [f"- {w}" for w in warnings]
        body += [""]
    body += ["---", ""]
    return "\n".join(body), warnings


def main() -> int:
    ap = argparse.ArgumentParser(description="측정 결과 집계 (§8)")
    ap.add_argument("files", nargs="+", type=Path, help="results/transfer_*.json")
    ap.add_argument("--compression-label", default=None,
                    help="표 3 을 계산할 경로 (기본: commercial)")
    ap.add_argument("--out", default=None,
                    help="기본: results/summary_{YYYYMMDD}.md (누적 append)")
    args = ap.parse_args()

    missing = [p for p in args.files if not p.exists()]
    if missing:
        raise SystemExit(f"파일 없음: {', '.join(str(p) for p in missing)}")

    sessions = load(args.files)
    report, warnings = build_report(sessions, args.compression_label)

    day = datetime.datetime.now().strftime("%Y%m%d")
    out = Path(args.out) if args.out else RESULTS_DIR / f"summary_{day}.md"
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    header = "" if out.exists() else f"# 에셋 전송 성능 측정 — {day}\n\n"
    with open(out, "a") as fh:
        fh.write(header + report + "\n")

    print(report)
    print(f"\n리포트 → {out}")
    if warnings:
        print(f"\n!! 보고 대상 {len(warnings)}건 (§11) — 위 리포트의 마지막 절 참조",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
