"""transfer_*.json 이 §7 스키마를 지키는지 검사한다.

    python scripts/check_schema.py results/transfer_*.json

CLI 하네스와 브라우저 하네스가 **같은 스키마로** 출력하는 것이 §10 완료 기준이다.
"같게 만들었다" 는 주장 대신 이 검사를 통과시킨다. 브라우저에서 내려받은
`transfer_*.browser.json` 도 같은 명령으로 검사한다.

추가 필드는 허용한다 (핸드셰이크 구간, resource 분해 등). 금지하는 것은 **누락과 타입 오류**다.
"""
from __future__ import annotations

import _pathfix  # noqa: F401

import argparse
import json
import sys
from pathlib import Path

NUM = (int, float)

META_FIELDS: dict[str, tuple] = {
    "session_id": (str,),
    "started_at": (str,),
    "target_url": (str,),
    "label": (str,),
    "location": (str,),
    "network_type": (str,),
    "isp": (str,),
    "harness": (str,),
}
SERVER_FIELDS: dict[str, tuple] = {
    "instance_type": (str,),
    "region": (str,),
    "ebs_type": (str,),
    "serving": (str,),
    "software_version": (str,),
}
DIAGNOSTIC_FIELDS = (
    "speedtest_down_mbps",
    "speedtest_up_mbps",
    "server_rtt_avg_ms",
    "server_rtt_mdev_ms",
    "router_rtt_avg_ms",
    "router_rtt_mdev_ms",
    "traceroute_hops",
)
SAMPLE_FIELDS: dict[str, tuple] = {
    "direction": (str,),
    "asset": (str,),
    "variant": (str,),
    "file_size_bytes": (int,),
    "concurrency": (int,),
    "round": (int,),
    "stream_index": (int,),
    "elapsed_ms": NUM,
    "ttfb_ms": NUM,
    "throughput_mbps": NUM,
    "srv_store_ms": (*NUM, type(None)),
    "srv_db_ms": (*NUM, type(None)),
    "srv_recv_ms": (*NUM, type(None)),
    "throttled": (bool,),
}
HARNESSES = ("cli", "browser")


def check_file(path: Path) -> list[str]:
    errors: list[str] = []
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        return [f"JSON 파싱 실패: {exc}"]

    for key in ("meta", "samples"):
        if key not in data:
            errors.append(f"최상위 '{key}' 없음")
    if errors:
        return errors

    meta = data["meta"]
    for field, types in META_FIELDS.items():
        if field not in meta:
            errors.append(f"meta.{field} 없음")
        elif not isinstance(meta[field], types):
            errors.append(f"meta.{field} 타입 오류: {type(meta[field]).__name__}")
    if meta.get("harness") not in HARNESSES:
        errors.append(f"meta.harness 는 {HARNESSES} 중 하나여야 한다: {meta.get('harness')!r}")

    server = meta.get("server")
    if not isinstance(server, dict):
        errors.append("meta.server 없음 또는 객체 아님")
    else:
        for field, types in SERVER_FIELDS.items():
            if field not in server:
                errors.append(f"meta.server.{field} 없음")
            elif not isinstance(server[field], types):
                errors.append(f"meta.server.{field} 타입 오류: {type(server[field]).__name__}")

    diag = meta.get("diagnostics")
    if not isinstance(diag, dict):
        errors.append("meta.diagnostics 없음 또는 객체 아님")
    else:
        for field in DIAGNOSTIC_FIELDS:
            if field not in diag:
                errors.append(f"meta.diagnostics.{field} 없음")
            elif not isinstance(diag[field], NUM):
                errors.append(f"meta.diagnostics.{field} 가 수치가 아니다")

    samples = data["samples"]
    if not isinstance(samples, list):
        return errors + ["samples 가 배열이 아니다"]
    if not samples:
        errors.append("samples 가 비어 있다")

    for i, s in enumerate(samples):
        if not isinstance(s, dict):
            errors.append(f"samples[{i}] 가 객체가 아니다")
            continue
        for field, types in SAMPLE_FIELDS.items():
            if field not in s:
                errors.append(f"samples[{i}].{field} 없음")
            elif not isinstance(s[field], types) or (
                types is not (bool,) and isinstance(s[field], bool) and field != "throttled"
            ):
                errors.append(f"samples[{i}].{field} 타입 오류: {type(s[field]).__name__}")
        if s.get("direction") not in ("download", "upload"):
            errors.append(f"samples[{i}].direction 값 오류: {s.get('direction')!r}")
        # §7 — srv_* 는 업로드에서만 채운다. 다운로드에서 채워져 있으면 해석이 틀린다.
        if s.get("direction") == "download":
            for field in ("srv_store_ms", "srv_db_ms", "srv_recv_ms"):
                if s.get(field) is not None:
                    errors.append(f"samples[{i}].{field} 는 다운로드에서 null 이어야 한다")
        if isinstance(s.get("round"), int) and s["round"] < 0:
            errors.append(f"samples[{i}].round 가 음수 — 워밍업은 기록하지 않는다 (§4-4)")

        # 스키마 위반은 아니지만 데이터가 쓸모없어지는 조합이라 함께 잡는다.
        if s.get("elapsed_ms") == 0 and not s.get("error"):
            errors.append(f"samples[{i}]: elapsed_ms 가 0 인데 error 가 없다")

    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description="§7 스키마 검사")
    ap.add_argument("files", nargs="+", type=Path)
    args = ap.parse_args()

    failed = 0
    for path in args.files:
        if not path.exists():
            print(f"✗ {path} — 파일 없음")
            failed += 1
            continue
        errors = check_file(path)
        data = json.loads(path.read_text()) if not errors else None
        if errors:
            failed += 1
            print(f"✗ {path.name} — {len(errors)}건")
            for e in errors[:15]:
                print(f"    {e}")
            if len(errors) > 15:
                print(f"    … 외 {len(errors) - 15}건")
        else:
            print(f"✓ {path.name} — harness={data['meta']['harness']} "
                  f"label={data['meta']['label']} samples={len(data['samples'])}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
