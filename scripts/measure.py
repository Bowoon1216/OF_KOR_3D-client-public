"""전송 시간 측정 하네스 — 에셋 업로드/다운로드 성능 (ASSET_TRANSFER_TEST_PLAN.md).

    python scripts/measure.py --target https://aws.example.com   --label commercial \
        --location home --network-type wifi
    python scripts/measure.py --target https://koren.example.com --label koren \
        --location campus --network-type wired

측정하는 것: **3D 에셋 파일의 전송 시간만.** 동기화 지연·지터·렌더링은 범위 밖(§0).

지키는 불변 조건 (§4) — 9월 KOREN 비교를 위해 8월과 9월에 동일해야 한다:
  1. 타겟 주소는 `--target` 파라미터. 하드코딩 없음
  2. 파일은 `assets/scenes/site_stacked_*.glb` 고정 (9월에 재생성 금지)
  3. 실제 백엔드를 상대로 측정 (측정 전용 정적 서버 아님)
  4. 조건마다 워밍업 1라운드를 폐기 — DNS·TCP·TLS 수립 비용 제거
  5. 매 요청 URL 에 `?t={timestamp_ns}` 부착
  6. 세션 메타데이터를 §7 스키마로 기록

시간 측정은 `curl` 에 맡긴다 (§5.1 "`curl -w %{time_starttransfer}` 또는 동등한 방식").
파이썬 스레드로 10개 스트림을 읽으면 GIL 경합이 전송 시간에 섞이는데, 프로세스로
분리하면 그 문제가 없고 TTFB·핸드셰이크 구간도 curl 이 직접 준다.

출력: results/transfer_{YYYYMMDD_HHMM}_{label}.json  (§7 스키마)
집계: scripts/report.py 가 이 파일들을 읽어 summary_{YYYYMMDD}.md 를 만든다
"""
from __future__ import annotations

import _pathfix  # noqa: F401

import argparse
import concurrent.futures
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from common import RESULTS_DIR, ROOT, SCENES_DIR, now_iso
from ofk_api import (
    ApiError,
    ca_args,
    delete_asset,
    drain_ifc_jobs,
    login,
    net_allowance,
    read_password,
    read_timing_headers,
    set_ca_bundle,
    upload_ifc,
)

ASSET = "site_stacked"

# §3.1 다운로드 매트릭스. (변형, 동시성 C, 라운드 R)
# raw 는 C=1 만 — C=10×R=20 이면 그것만 74GB 로 월 무료 한도를 태운다 (§3.1, §9).
DOWNLOAD_MATRIX = [
    ("raw", 1, 10),
    ("meshopt", 1, 30),
    ("meshopt", 3, 20),
    ("meshopt", 10, 20),
    ("draco", 1, 30),
    ("draco", 10, 20),
]

# loopback 은 C=1 만 (§3.1). t3.medium 은 2 vCPU 라 고동시성 loopback 은 부하 생성기가
# 서버와 CPU 를 다투는 것을 재게 된다. 목적은 경로 비교가 아니라 서버 상한 확인이다.
LOOPBACK_MATRIX = [
    ("raw", 1, 10),
    ("meshopt", 1, 30),
    ("draco", 1, 30),
]

# §3.2 업로드. 대상은 IFC 원본이고 엔드포인트는 `POST /api/assets/ifc` 다.
# 가정용 회선의 상향 대역이 낮아 동시성 스윕을 하지 않는다. 필요하면 C=3 까지만이지만,
# 사용자당 동시 변환이 2건이므로 C>2 는 429 를 재는 것이 된다.
UPLOAD_MATRIX = [
    ("hoist", 1, 20),
    ("boomlift", 1, 20),
    ("rooflight", 1, 20),
]

# §5.3 이 지정한 카운터. 라운드 전후 차이가 0 이 아니면 그 라운드는 오염된 것으로 본다.
THROTTLE_COUNTERS = (
    "bw_out_allowance_exceeded",
    "bw_in_allowance_exceeded",
    "pps_allowance_exceeded",
)

IFC_ALIASES = {
    "hoist": "S650_single_L=3.9m 1500mm raised enclosure.ifc",
    "boomlift": "Construction_Aerial-Equipment_Haulotte_H18SXL_INT.ifc",
    "rooflight": "Windows-Skylights_Kingspan-Light-Air_Ecodis-Ecoplan_ISO_plus-3D.ifc",
}


# --------------------------------------------------------------------------
# 세션 진단 (§5.4)
# --------------------------------------------------------------------------

def _run(cmd: list[str], timeout: int) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"{cmd[0]} 미설치"
    except subprocess.TimeoutExpired:
        return 124, "", f"{cmd[0]} 타임아웃 ({timeout}s)"


def probe_speedtest() -> dict:
    exe = shutil.which("speedtest-cli") or shutil.which("speedtest")
    if not exe:
        return {"available": False, "note": "speedtest-cli 미설치 (pip install speedtest-cli)"}
    rc, out, err = _run([exe, "--json"], timeout=240)
    if rc != 0:
        return {"available": False, "error": (err or out)[-400:]}
    try:
        d = json.loads(out)
    except json.JSONDecodeError:
        return {"available": False, "error": out[-400:]}
    return {
        "available": True,
        "down_mbps": round(d.get("download", 0) / 1e6, 3),
        "up_mbps": round(d.get("upload", 0) / 1e6, 3),
        "ping_ms": d.get("ping"),
        "isp": (d.get("client") or {}).get("isp"),
    }


def probe_ping(host: str, count: int) -> dict:
    """avg 와 mdev(=stddev) 를 뽑는다. 공유기 대상 mdev 가 곧 Wi-Fi 노이즈 바닥값(§5.4)."""
    rc, out, err = _run(["ping", "-c", str(count), host], timeout=count * 2 + 60)
    if not out:
        return {"available": False, "error": (err or "출력 없음")[-300:]}
    stats: dict = {"available": True, "count": count}
    for line in out.splitlines():
        # macOS: round-trip min/avg/max/stddev = a/b/c/d ms
        # Linux: rtt min/avg/max/mdev = a/b/c/d ms
        if "min/avg/max" in line and "=" in line:
            try:
                nums = [float(v) for v in line.split("=")[1].strip().split(" ")[0].split("/")]
                stats.update(min_ms=nums[0], avg_ms=nums[1], max_ms=nums[2],
                             mdev_ms=nums[3] if len(nums) > 3 else None)
            except (ValueError, IndexError):
                pass
        if "packet loss" in line:
            stats["packet_loss_line"] = line.strip()
            m = re.search(r"([\d.]+)% packet loss", line)
            if m:
                stats["packet_loss_pct"] = float(m.group(1))
    return stats


def probe_traceroute(host: str) -> dict:
    exe = shutil.which("traceroute") or shutil.which("tracepath")
    if not exe:
        return {"available": False, "note": "traceroute 미설치"}
    rc, out, _ = _run([exe, "-n", "-w", "2", "-q", "1", host], timeout=180)
    lines = [ln for ln in out.strip().splitlines() if ln.strip()]
    return {"available": bool(lines), "hop_count": max(0, len(lines) - 1), "hops": lines}


def default_gateway() -> str | None:
    """공유기 IP 자동 탐지. §5.4 의 `ping -c 100 {공유기 IP}` 대상."""
    rc, out, _ = _run(["route", "-n", "get", "default"], timeout=10)
    if rc == 0:
        for line in out.splitlines():
            if "gateway:" in line:
                return line.split(":")[1].strip()
    rc, out, _ = _run(["ip", "route", "show", "default"], timeout=10)
    if rc == 0:
        parts = out.split()
        if "via" in parts:
            return parts[parts.index("via") + 1]
    return None


def run_diagnostics(host: str, router_ip: str | None, ping_count: int,
                    router_ping_count: int, skip: bool) -> dict:
    if skip:
        return {"skipped": True,
                "note": "--skip-probes — 하네스 검증용. 실제 세션에서는 쓰지 말 것"}
    print("\n-- 세션 진단 (§5.4)")
    diag: dict = {}

    diag["speedtest"] = probe_speedtest()
    s = diag["speedtest"]
    print(f"   speedtest : {s['down_mbps']}↓ / {s['up_mbps']}↑ Mbps" if s.get("available")
          else f"   speedtest : 불가 — {s.get('note') or s.get('error')}")

    diag["server_ping"] = probe_ping(host, ping_count)
    p = diag["server_ping"]
    print(f"   서버 ping : avg {p.get('avg_ms')} ms / mdev {p.get('mdev_ms')} ms"
          if p.get("available") else f"   서버 ping : 불가 — {p.get('error')}")

    diag["traceroute"] = probe_traceroute(host)
    print(f"   traceroute: {diag['traceroute'].get('hop_count')} hops")

    if router_ip:
        diag["router_ping"] = probe_ping(router_ip, router_ping_count)
        r = diag["router_ping"]
        diag["router_ip"] = router_ip
        # 이 mdev 가 Wi-Fi 구간 노이즈의 바닥값이다. 리포트에서 한계를 밝히는 근거(§8.3).
        print(f"   공유기 ping: avg {r.get('avg_ms')} ms / mdev {r.get('mdev_ms')} ms "
              f"← Wi-Fi 노이즈 바닥값" if r.get("available")
              else f"   공유기 ping: 불가 — {r.get('error')}")
    else:
        diag["router_ping"] = {"available": False, "note": "공유기 IP 미탐지 (--router-ip 로 지정)"}
    return diag


def diagnostics_summary(diag: dict) -> dict:
    """§7 meta.diagnostics 의 평면 필드."""
    st = diag.get("speedtest", {})
    sp = diag.get("server_ping", {})
    rp = diag.get("router_ping", {})
    return {
        "speedtest_down_mbps": st.get("down_mbps") or 0,
        "speedtest_up_mbps": st.get("up_mbps") or 0,
        "server_rtt_avg_ms": sp.get("avg_ms") or 0,
        "server_rtt_mdev_ms": sp.get("mdev_ms") or 0,
        "router_rtt_avg_ms": rp.get("avg_ms") or 0,
        "router_rtt_mdev_ms": rp.get("mdev_ms") or 0,
        "traceroute_hops": diag.get("traceroute", {}).get("hop_count") or 0,
    }


# --------------------------------------------------------------------------
# 스로틀 감시 (§5.3)
# --------------------------------------------------------------------------

class ThrottleWatch:
    """라운드 전후로 ENA 카운터를 읽어 증가한 라운드를 표시한다.

    SSH `ethtool -S ens5` 대신 `GET /api/metrics/net-allowance` 를 쓴다. 서버가 같은
    카운터를 그대로 노출하므로 결과는 같고, 측정 담당자에게 SSH 가 필요 없다.
    """

    def __init__(self, target: str, enabled: bool) -> None:
        self.target = target
        self.enabled = enabled
        self.interface: str | None = None
        self.unavailable_rounds = 0
        self._before: dict | None = None

    def before_round(self) -> None:
        if not self.enabled:
            return
        snap = net_allowance(self.target)
        self._before = (snap or {}).get("counters")
        if snap:
            self.interface = snap.get("interface")

    def after_round(self) -> tuple[bool, dict[str, int]]:
        """(오염 여부, 증가분). 카운터를 못 읽으면 (False, {}) 이고 그 횟수를 센다."""
        if not self.enabled:
            return False, {}
        snap = net_allowance(self.target)
        after = (snap or {}).get("counters")
        if not self._before or not after:
            self.unavailable_rounds += 1
            return False, {}
        delta = {k: int(after.get(k, 0)) - int(self._before.get(k, 0))
                 for k in THROTTLE_COUNTERS}
        return any(v > 0 for v in delta.values()), {k: v for k, v in delta.items() if v}


# --------------------------------------------------------------------------
# 전송 (curl 프로세스 1개 = 스트림 1개)
# --------------------------------------------------------------------------

def _curl_stats(argv: list[str], timeout: int) -> dict:
    """curl 을 돌려 전송 통계를 돌려준다. **어떤 경우에도 예외를 올리지 않는다.**

    한 스트림의 실패가 예외로 올라오면 `fire_concurrent` 의 `future.result()` 에서
    다시 던져져 세션 전체가 죽는다. 세 시간짜리 세션에서 마지막 라운드의 타임아웃 하나로
    그때까지 모은 샘플을 다 잃는 것은 받아들일 수 없다. 실패는 실패 샘플로 남긴다.
    """
    try:
        proc = subprocess.run(["curl", "-sS", *ca_args(), *argv, "-w", "%{json}"],
                              capture_output=True, text=True, timeout=timeout + 120)
    except subprocess.TimeoutExpired:
        return {"_error": f"curl 프로세스 타임아웃 ({timeout + 120}s)", "http_code": 0}
    except (OSError, ValueError) as exc:
        return {"_error": f"curl 실행 실패: {type(exc).__name__}: {exc}", "http_code": 0}
    tail = proc.stdout.rfind("{")
    if tail < 0:
        return {"_error": f"curl rc={proc.returncode}: {proc.stderr[-200:]}", "http_code": 0}
    try:
        stats = json.loads(proc.stdout[tail:])
    except json.JSONDecodeError as exc:
        return {"_error": f"통계 JSON 파싱 실패: {exc}", "http_code": 0}
    if proc.stderr.strip():
        stats["_stderr"] = proc.stderr.strip()[-200:]
    return stats


def download_stream(url: str, timeout: int) -> dict:
    """본문을 끝까지 받는다. 본문은 버린다 — 디스크 쓰기가 전송 시간에 섞이면 안 된다."""
    return _curl_stats([
        "-o", os.devnull,
        "-H", "Cache-Control: no-cache, no-store",
        "-H", "Pragma: no-cache",
        # 압축을 끄면 전송 바이트가 파일 크기와 일치한다. GLB 는 이미 압축돼 있어
        # gzip 을 켜도 이득이 없고, 켜면 처리량 계산의 분자가 흐려진다.
        "-H", "Accept-Encoding: identity",
        "--max-time", str(timeout),
        url,
    ], timeout=timeout)


def fire_concurrent(count: int, fn) -> list:
    """C 개를 **동시에** 발사하고 전부 끝날 때까지 기다린다 (§5.1).

    Barrier 로 실제 발사 시점을 맞춘다. 이게 없으면 프로세스 생성 지연만큼
    스트림이 계단식으로 시작해 동시성 C 를 재는 게 아니게 된다.
    """
    barrier = threading.Barrier(count)

    def worker(i: int):
        barrier.wait()
        return fn(i)

    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        return [f.result() for f in [pool.submit(worker, i) for i in range(count)]]


def throughput_mbps(nbytes: float, elapsed_ms: float) -> float:
    if elapsed_ms <= 0 or nbytes <= 0:
        return 0.0
    return round((nbytes * 8) / (elapsed_ms / 1000) / 1e6, 4)


# --------------------------------------------------------------------------
# 다운로드 조건 실행
# --------------------------------------------------------------------------

def resolve_download_targets(args) -> dict[str, dict]:
    """변형 → {url, size_bytes}. 주소는 파라미터에서만 온다 (§4-1).

    두 방식을 지원한다.
      --url-template '/static/assets/{id}/site_stacked_{variant}.glb'
      --targets results/download_targets_{label}.json   (scripts/publish.py 산출물)
    """
    if args.url_template:
        local = {v: SCENES_DIR / f"{ASSET}_{v}.glb" for v in ("raw", "meshopt", "draco")}
        return {
            v: {
                "url": args.target.rstrip("/") + args.url_template.format(variant=v, asset=ASSET),
                "size_bytes": p.stat().st_size if p.exists() else 0,
            }
            for v, p in local.items()
        }

    path = Path(args.targets) if args.targets else RESULTS_DIR / f"download_targets_{args.label}.json"
    if not path.exists():
        raise SystemExit(
            f"다운로드 대상 목록이 없다: {path}\n"
            f"  scripts/publish.py 로 GLB 를 서버에 올려 목록을 만들거나,\n"
            f"  --url-template 로 경로 규칙을 직접 지정할 것."
        )
    manifest = json.loads(path.read_text())
    out = {}
    for variant, entry in manifest.get("variants", {}).items():
        url = entry["url"]
        out[variant] = {
            "url": url if url.startswith("http") else args.target.rstrip("/") + url,
            "size_bytes": entry.get("size_bytes", 0),
        }
    return out


def run_download_condition(variant: str, c: int, r: int, target_info: dict,
                           watch: ThrottleWatch, args, samples: list) -> dict:
    url_base = target_info["url"]
    size = target_info["size_bytes"]
    sep = "&" if "?" in url_base else "?"
    print(f"\n-- 다운로드 {ASSET}/{variant} ({size / 1e6:.2f} MB) C={c} R={r} "
          f"(+워밍업 1라운드, 총 {c * r} 샘플)")

    throttled_rounds = 0
    failures = 0
    for round_index in range(-1, r):  # -1 = 워밍업. 파일에 남기지 않는다 (§4-4)
        watch.before_round()
        results = fire_concurrent(
            c, lambda i: download_stream(f"{url_base}{sep}t={time.time_ns()}", args.timeout)
        )
        throttled, delta = watch.after_round()
        if round_index < 0:
            print(f"   [워밍업] {results[0].get('time_total', 0) * 1000:9.1f} ms — 폐기")
            continue
        if throttled:
            throttled_rounds += 1

        elapsed = []
        for stream_index, st in enumerate(results):
            ok = int(st.get("http_code") or 0) == 200 and not st.get("_error")
            if not ok:
                failures += 1
            got = float(st.get("size_download") or 0)
            ms = float(st.get("time_total") or 0) * 1000
            elapsed.append(ms)
            samples.append({
                "direction": "download",
                "asset": ASSET,
                "variant": variant,
                "file_size_bytes": size,
                "concurrency": c,
                "round": round_index,
                "stream_index": stream_index,
                "elapsed_ms": round(ms, 3),
                "ttfb_ms": round(float(st.get("time_starttransfer") or 0) * 1000, 3),
                "throughput_mbps": throughput_mbps(got or size, ms),
                "srv_store_ms": None,
                "srv_db_ms": None,
                "srv_recv_ms": None,
                "throttled": throttled,
                # 아래는 §7 스키마에 없는 추가 필드. 핸드셰이크 고정 비용을 §8.2 표 3 에서
                # 떼어내려면 필요하다. 집계는 위 필드만 쓴다.
                "connect_ms": round(float(st.get("time_pretransfer") or 0) * 1000, 3),
                "bytes_received": int(got),
                "http_code": int(st.get("http_code") or 0),
                "error": st.get("_error") or st.get("_stderr") or None,
            })

        mark = "  ⚠ throttled " + json.dumps(delta) if throttled else ""
        print(f"   [{round_index + 1:3d}/{r}] p50 {sorted(elapsed)[len(elapsed) // 2]:9.1f} ms "
              f"| min {min(elapsed):8.1f} max {max(elapsed):8.1f}{mark}")
        if args.sleep:
            time.sleep(args.sleep)

    return {"variant": variant, "concurrency": c, "rounds": r,
            "throttled_rounds": throttled_rounds, "failed_streams": failures}


# --------------------------------------------------------------------------
# 업로드 조건 실행 (§6)
# --------------------------------------------------------------------------

def run_upload_condition(alias: str, path: Path, c: int, r: int, token: str,
                         watch: ThrottleWatch, args, samples: list,
                         uploaded_ids: list[str], header_names: set) -> dict:
    """§3.2 업로드. 대상은 IFC 이고 엔드포인트는 `POST /api/assets/ifc` 다.

    변환은 서버가 비동기로 돌린다 (202 Accepted). 그래서 응답 시간에 변환 시간이
    섞이지 않는다 — §6.1 의 최대 함정이 서버 설계로 해소된 것이다. 대신 업로드 직후
    서버 CPU 에서 변환이 시작되므로, 기본 동작으로 라운드마다 잡을 비운다.
    안 비우면 두 가지가 동시에 망가진다.
      - 동시 변환 2건 제한 때문에 세 번째 요청부터 429 (전송 시간이 아닌 값)
      - 변환과 다음 라운드가 2 vCPU 를 나눠 쓴다 (§9 금지)
    """
    size = path.stat().st_size
    convert = args.upload_convert
    print(f"\n-- 업로드 {alias} ({size / 1e6:.2f} MB) C={c} R={r} (+워밍업 1라운드)")
    if not convert:
        # 서버의 측정 전용 경로. 변환을 예약하지 않으므로 라운드 간 대기가 없고,
        # 측정 중 서버 CPU 에서 변환이 돌지 않는다 (§9).
        print("   convert=false — 저장까지만. 변환 대기 없음, 측정 중 서버 변환 없음 (§9)")
    elif args.drain_jobs:
        print(f"   변환 예약함. 라운드마다 완료를 기다린다 (§9). "
              f"{alias} 변환이 수 분이면 이 조건만 수십 분 걸린다.")
    else:
        print("   !! 변환을 예약하면서 완료를 기다리지 않는다. §9 위반이며 측정값에 "
              "CPU 경합이 섞이고 429 가 끼어든다.", file=sys.stderr)

    tmpdir = Path(tempfile.mkdtemp(prefix="ofk_upload_"))
    throttled_rounds = 0
    failures = 0
    missing_timing = 0
    busy_rejections = 0
    conversion_failures: list[dict] = []

    try:
        for round_index in range(-1, r):
            watch.before_round()

            def one(i: int):
                hdr = tmpdir / f"h_{round_index}_{i}.txt"
                body = tmpdir / f"b_{round_index}_{i}.json"
                try:
                    stats = upload_ifc(
                        args.target, token, path, label=f"transfer-measure {alias}",
                        header_dump=hdr, body_dump=body, timeout=args.timeout,
                        extra_query=f"?t={time.time_ns()}", convert=convert,
                    )
                except (ApiError, subprocess.SubprocessError, OSError) as exc:
                    # 실패한 라운드 하나로 세션 전체를 잃지 않는다. 실패 샘플로 남긴다.
                    stats = {"_error": f"{type(exc).__name__}: {exc}", "http_code": 0}
                timing, names = read_timing_headers(hdr)
                payload = {}
                try:
                    payload = json.loads(body.read_text() or "{}") or {}
                except (json.JSONDecodeError, OSError):
                    pass
                return stats, timing, names, payload

            results = fire_concurrent(c, one)
            throttled, delta = watch.after_round()

            # 202 응답의 id 는 변환 잡이다. 에셋 id 는 변환이 끝나야 나온다.
            job_ids = [p.get("id") for _s, _t, _n, p in results
                       if isinstance(p.get("id"), str) and p["id"].startswith("j_")]
            for _s, _t, names, _p in results:
                header_names.update(names)

            if convert and args.drain_jobs and job_ids:
                asset_ids, conv_failed = drain_ifc_jobs(
                    args.target, token, job_ids,
                    max_wait_seconds=args.drain_timeout,
                )
                uploaded_ids.extend(asset_ids)
                conversion_failures.extend(conv_failed)
                if conv_failed:
                    print(f"   !! 변환 실패 {len(conv_failed)}건: "
                          f"{conv_failed[0].get('code')}", file=sys.stderr)

            if round_index < 0:
                print(f"   [워밍업] {results[0][0].get('time_total', 0) * 1000:9.1f} ms — 폐기")
                continue
            if throttled:
                throttled_rounds += 1

            elapsed = []
            for stream_index, (stats, timing, _names, payload) in enumerate(results):
                code = int(stats.get("http_code") or 0)
                # IFC 업로드의 성공은 202 다. 201/200 도 받아둔다 (엔드포인트 교체 대비).
                if code not in (200, 201, 202):
                    failures += 1
                if code == 429 or (payload.get("error") or {}).get("code") == "CONVERSION_BUSY":
                    busy_rejections += 1
                if not timing:
                    missing_timing += 1
                ms = float(stats.get("time_total") or 0) * 1000
                elapsed.append(ms)
                samples.append({
                    "direction": "upload",
                    "asset": alias,
                    "variant": "ifc" if path.suffix.lower() == ".ifc" else "glb",
                    "file_size_bytes": size,
                    "concurrency": c,
                    "round": round_index,
                    "stream_index": stream_index,
                    "elapsed_ms": round(ms, 3),
                    # 업로드에서 TTFB = 본문을 다 보낸 뒤 서버 첫 응답 바이트.
                    # recv + store + db 가 끝난 시점이라 다운로드의 TTFB 와 의미가 다르다.
                    "ttfb_ms": round(float(stats.get("time_starttransfer") or 0) * 1000, 3),
                    "throughput_mbps": throughput_mbps(size, ms),
                    "srv_store_ms": timing.get("store"),
                    "srv_db_ms": timing.get("db"),
                    "srv_recv_ms": timing.get("recv"),
                    "throttled": throttled,
                    "connect_ms": round(float(stats.get("time_pretransfer") or 0) * 1000, 3),
                    "bytes_sent": int(float(stats.get("size_upload") or 0)),
                    "http_code": code,
                    "error": (
                        (payload.get("error") or {}).get("code")
                        or stats.get("_error")
                        or stats.get("_stderr")
                        or None
                    ),
                })

            mark = "  ⚠ throttled" if throttled else ""
            print(f"   [{round_index + 1:3d}/{r}] {elapsed[0]:9.1f} ms "
                  f"| 서버작업 store+db "
                  f"{(results[0][1].get('store', 0) or 0) + (results[0][1].get('db', 0) or 0):7.1f} ms"
                  f"{mark}")
            if args.sleep:
                time.sleep(args.sleep)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    return {"asset": alias, "concurrency": c, "rounds": r,
            "endpoint": f"/api/assets/ifc{'' if convert else '?convert=false'}",
            "conversion_requested": convert,
            "throttled_rounds": throttled_rounds, "failed_streams": failures,
            "rounds_without_server_timing": missing_timing,
            "conversion_busy_rejections": busy_rejections,
            "conversion_failures": conversion_failures,
            "drained_between_rounds": bool(convert and args.drain_jobs)}


# --------------------------------------------------------------------------
# 세션
# --------------------------------------------------------------------------

def parse_spec(spec: str, kind: str) -> tuple[str, int, int]:
    parts = spec.split(":")
    if len(parts) != 3:
        raise SystemExit(f"{kind} 스펙 형식 오류: '{spec}' — 'name:C:R' 이어야 한다")
    try:
        return parts[0], int(parts[1]), int(parts[2])
    except ValueError:
        raise SystemExit(f"{kind} 스펙의 C·R 이 정수가 아니다: '{spec}'") from None


def check_guards(label: str, matrix: list[tuple[str, int, int]]) -> None:
    """§9 '하지 말 것' 을 코드로 막는다. 실수 한 번이 egress 예산이나 데이터 해석을 망친다."""
    for variant, c, r in matrix:
        if variant == "raw" and c > 1:
            gb = 339 * c * r / 1000
            raise SystemExit(
                f"raw 를 C={c} 로 돌리려 한다 (§9 금지). C={c}, R={r} 이면 egress 약 {gb:.0f}GB — "
                f"월 무료 한도 100GB 를 태운다. raw 는 C=1 만."
            )
        if label == "loopback" and c > 1:
            raise SystemExit(
                f"loopback 을 C={c} 로 돌리려 한다 (§9 금지). t3.medium 은 2 vCPU 라 "
                f"부하 생성기가 서버와 CPU 를 다투는 것을 재게 된다. loopback 은 C=1 만."
            )


def estimate_drain_minutes(matrix: list[tuple[str, int, int]]) -> float:
    """변환 완료 대기가 세션에 더하는 시간. 예상치를 미리 밝히지 않으면 중간에 멈추게 된다.

    로컬 변환 시간(`results/asset_manifest.json`)을 서버 변환 시간의 근사로 쓴다.
    노트북과 t3.medium 의 CPU 가 다르므로 정확한 값이 아니라 자릿수 감각용이다.
    """
    try:
        manifest = json.loads((RESULTS_DIR / "asset_manifest.json").read_text())
    except (OSError, json.JSONDecodeError):
        return 0.0
    total = 0.0
    for alias, c, r in matrix:
        seconds = (manifest.get(alias) or {}).get("conversion_seconds")
        if seconds:
            # 라운드는 순차 진행이고 워밍업 1라운드가 더 붙는다. C 개는 병렬 변환.
            total += float(seconds) * (r + 1)
    return total / 60


def estimate_egress_gb(matrix: list[tuple[str, int, int]], targets: dict[str, dict]) -> float:
    total = 0.0
    for variant, c, r in matrix:
        size = targets.get(variant, {}).get("size_bytes", 0)
        total += size * c * (r + 1)  # 워밍업 라운드 포함
    return total / 1e9


def run_session(args) -> int:
    started = datetime.datetime.now()
    stamp = started.strftime("%Y%m%d_%H%M")
    session_id = args.session_id or f"{stamp}_{args.location}"
    host = args.target.split("//")[-1].split("/")[0].split(":")[0]

    directions = args.directions
    download_matrix: list[tuple[str, int, int]] = []
    if "download" in directions:
        download_matrix = ([parse_spec(s, "--download") for s in args.download] if args.download
                           else (LOOPBACK_MATRIX if args.label == "loopback" else DOWNLOAD_MATRIX))
        check_guards(args.label, download_matrix)

    upload_matrix: list[tuple[str, int, int]] = []
    if "upload" in directions:
        upload_matrix = ([parse_spec(s, "--upload") for s in args.upload] if args.upload
                         else UPLOAD_MATRIX)
        for alias, c, _r in upload_matrix:
            if c > 2:
                print(f"   !! 업로드 {alias} C={c} — 사용자당 동시 변환은 2건이다. "
                      f"3번째부터 429 CONVERSION_BUSY 가 오고 그 값은 전송 시간이 아니다.",
                      file=sys.stderr)

    print(f"== 세션 {session_id}")
    print(f"   타겟 {args.target}  라벨 {args.label}")
    print(f"   위치 {args.location} / 회선 {args.network_type}"
          + (f" / ISP {args.isp}" if args.isp else ""))

    token = ""
    if upload_matrix:
        token = args.token or os.environ.get("OFK_TOKEN", "")
        if not token:
            password = read_password(args.password_file)
            if not (args.email and password):
                raise SystemExit(
                    "업로드 측정에는 토큰이 필요하다.\n"
                    "  --token <토큰>  또는  OFK_TOKEN=<토큰>  또는\n"
                    "  --email <이메일> 과 --password-file <경로> (또는 OFK_PASSWORD)."
                )
            token = login(args.target, args.email, password)
            print("   로그인 완료 (업로드 측정용 토큰 확보)")

    targets: dict[str, dict] = {}
    if download_matrix:
        targets = resolve_download_targets(args)
        missing = [v for v, _c, _r in download_matrix if not targets.get(v, {}).get("url")]
        if missing:
            raise SystemExit(f"다운로드 대상 URL 이 없다: {sorted(set(missing))}")
        egress = estimate_egress_gb(download_matrix, targets)
        print(f"   다운로드 매트릭스 egress 예상 {egress:.1f} GB")
        if egress > 60 and not args.yes:
            raise SystemExit(
                f"egress 예상 {egress:.1f} GB — §11 의 보고 기준 60GB 를 넘는다. "
                f"의도한 것이면 --yes."
            )

    if upload_matrix and args.upload_convert and args.drain_jobs:
        drain_min = estimate_drain_minutes(upload_matrix)
        if drain_min:
            print(f"   업로드 변환 대기 예상 {drain_min:.0f}분 "
                  f"(§9 때문에 라운드마다 변환이 끝나기를 기다린다). "
                  f"전송 시간만 필요하면 --upload-convert 를 빼면 0분이다")

    diag = run_diagnostics(host, args.router_ip or default_gateway(),
                           args.ping_count, args.router_ping_count, args.skip_probes)

    watch = ThrottleWatch(args.target, enabled=not args.no_throttle_watch)
    samples: list[dict] = []
    conditions: list[dict] = []
    uploaded_ids: list[str] = []
    header_names: set[str] = set()

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else RESULTS_DIR / f"transfer_{stamp}_{args.label}.json"

    def build_meta(done: bool) -> dict:
        return {
            "session_id": session_id,
            "started_at": started.astimezone().isoformat(),
            "target_url": args.target,
            "label": args.label,
            "location": args.location,
            "network_type": args.network_type,
            "isp": args.isp or diag.get("speedtest", {}).get("isp", "") or "",
            "harness": "cli",
            "server": {
                "instance_type": args.instance_type,
                "region": args.region,
                "ebs_type": args.ebs_type,
                "serving": args.serving,
                "software_version": args.server_version,
            },
            "diagnostics": diagnostics_summary(diag),
            # 스키마에 없는 추가 필드 — 재현과 감사를 위해 남긴다 (§10 "재현용 실행 명령어 로그").
            "diagnostics_raw": diag,
            "warmup_rounds_discarded_per_condition": 1,
            "conditions": conditions,
            "throttle_watch": {
                "enabled": watch.enabled,
                "source": "GET /api/metrics/net-allowance (SSH ethtool 대체)",
                "interface": watch.interface,
                "counters": list(THROTTLE_COUNTERS),
                "rounds_counter_unavailable": watch.unavailable_rounds,
            },
            "server_timing_headers_seen": sorted(header_names),
            "command": " ".join(["python", "scripts/measure.py", *sys.argv[1:]]),
            # 미완료 파일을 완료된 것으로 착각해 집계하면 안 된다.
            "complete": done,
            "finished_at": now_iso() if done else None,
        }

    def flush(done: bool = False) -> None:
        """조건이 끝날 때마다 파일에 쓴다.

        세 시간짜리 세션이 중간에 끊겼을 때 그때까지의 샘플을 살리기 위한 것이다.
        `complete: false` 로 남으므로 집계 전에 미완료임을 알 수 있다.
        """
        out_path.write_text(
            json.dumps({"meta": build_meta(done), "samples": samples},
                       indent=2, ensure_ascii=False) + "\n"
        )

    for variant, c, r in download_matrix:
        conditions.append(run_download_condition(variant, c, r, targets[variant],
                                                 watch, args, samples))
        flush()

    for alias, c, r in upload_matrix:
        path = _upload_path(alias, args)
        if path is None:
            print(f"   !! 업로드 대상 '{alias}' 파일 없음 — 건너뜀", file=sys.stderr)
            continue
        conditions.append(run_upload_condition(alias, path, c, r, token, watch, args,
                                               samples, uploaded_ids, header_names))
        flush()

    flush(done=True)
    meta = build_meta(True)

    if uploaded_ids and not args.keep_uploads:
        print(f"\n-- 업로드로 쌓인 에셋 {len(uploaded_ids)}개 정리")
        failed = [i for i in uploaded_ids if delete_asset(args.target, token, i) >= 400]
        print(f"   삭제 완료 {len(uploaded_ids) - len(failed)} / 실패 {len(failed)}")
        if failed:
            (RESULTS_DIR / f"orphan_assets_{stamp}.json").write_text(
                json.dumps(failed, indent=2) + "\n")
            print(f"   !! 삭제 실패 id 를 orphan_assets_{stamp}.json 에 남겼다")

    print(f"\n원시 데이터 → {out_path}")
    print(f"집계        → python scripts/report.py {out_path}")
    for w in collect_warnings(meta, samples):
        print("  !!", w)
    return 0


def _upload_path(alias: str, args) -> Path | None:
    if args.upload_dir:
        cand = Path(args.upload_dir) / alias
        if cand.exists():
            return cand
    name = IFC_ALIASES.get(alias)
    if name:
        cand = ROOT / "assets" / "raw" / name
        if cand.exists():
            return cand
    for base in (SCENES_DIR, ROOT / "assets" / "converted", ROOT / "assets" / "raw"):
        for suffix in (".ifc", ".glb"):
            cand = base / f"{alias}{suffix}"
            if cand.exists():
                return cand
    return None


def collect_warnings(meta: dict, samples: list[dict]) -> list[str]:
    """§11 '멈추고 보고할 것' 중 이 세션 데이터만으로 판정 가능한 항목."""
    out = []
    throttled = sum(1 for s in samples if s["throttled"])
    if samples and throttled / len(samples) > 0.5:
        out.append(f"스로틀 오염 샘플이 {throttled}/{len(samples)} — 인스턴스 타입 재검토 (§11)")
    failed = sum(1 for s in samples if s.get("http_code", 200) >= 400 or s.get("error"))
    if failed:
        out.append(f"실패한 요청 {failed}건")
    uploads = [s for s in samples if s["direction"] == "upload"]
    if uploads and all(s["srv_store_ms"] is None for s in uploads):
        out.append("업로드 응답에 구간 타이밍 헤더가 없다 — 서버 작업 시간을 분리할 수 없다 (§11)")
    for cond in meta.get("conditions", []):
        if cond.get("conversion_busy_rejections"):
            out.append(f"{cond.get('asset')}: 429 CONVERSION_BUSY {cond['conversion_busy_rejections']}건 "
                       f"— 동시 변환 2건 제한에 걸린 샘플이며 전송 시간이 아니다")
        if cond.get("conversion_failures"):
            codes = {f.get("code") for f in cond["conversion_failures"]}
            out.append(f"{cond.get('asset')}: 변환 실패 {len(cond['conversion_failures'])}건 "
                       f"({', '.join(sorted(c for c in codes if c))})")
        # 변환을 예약하지 않았으면(convert=false) 기다릴 변환이 없다. 이 경우까지
        # §9 위반으로 적으면 일어나지 않은 위반을 기록에 남기게 된다.
        if cond.get("conversion_requested") and not cond.get("drained_between_rounds"):
            out.append(f"{cond.get('asset')}: 변환을 예약하면서 완료를 기다리지 않았다 — "
                       f"측정 중 서버에서 변환이 돌았다는 뜻 (§9 위반)")
    if meta["throttle_watch"]["enabled"] and meta["throttle_watch"]["rounds_counter_unavailable"]:
        out.append(f"스로틀 카운터를 못 읽은 라운드 "
                   f"{meta['throttle_watch']['rounds_counter_unavailable']}회")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="에셋 전송 시간 측정 하네스 (ASSET_TRANSFER_TEST_PLAN.md)")
    # §4-1: 타겟은 반드시 파라미터. 9월에 AWS·KOREN 을 같은 스크립트로 연속 실행해야 한다.
    ap.add_argument("--target", required=True, help="예: https://aws.example.com")
    ap.add_argument("--label", required=True, help="loopback | commercial | koren")
    ap.add_argument("--location", default="home", choices=["home", "campus", "other"])
    ap.add_argument("--network-type", default="wifi", choices=["wifi", "wired"])
    ap.add_argument("--isp", default="")
    ap.add_argument("--session-id", default=None)
    ap.add_argument("--directions", nargs="+", default=["download"],
                    choices=["download", "upload"])

    ap.add_argument("--download", nargs="*", default=None, metavar="VARIANT:C:R",
                    help="기본: §3.1 매트릭스 (loopback 라벨이면 C=1 만)")
    ap.add_argument("--upload", nargs="*", default=None, metavar="ALIAS:C:R",
                    help="기본: §3.2 (hoist/boomlift/rooflight, C=1, R=20)")
    ap.add_argument("--targets", default=None,
                    help="다운로드 대상 목록 JSON (기본: results/download_targets_{label}.json)")
    ap.add_argument("--url-template", default=None,
                    help="대상 목록 대신 경로 규칙으로 지정. 예 '/assets/site_stacked_{variant}.glb'")
    ap.add_argument("--upload-dir", default=None, help="업로드 대상 파일 디렉터리")

    ap.add_argument("--token", default=None, help="Bearer 토큰 (또는 환경변수 OFK_TOKEN)")
    ap.add_argument("--email", default=None, help="로그인 이메일")
    ap.add_argument("--password-file", default=None,
                    help="비밀번호가 담긴 파일 경로. 미지정 시 환경변수 OFK_PASSWORD")
    ap.add_argument("--keep-uploads", action="store_true",
                    help="측정으로 올라간 에셋을 서버에 남긴다 (기본은 삭제)")
    ap.add_argument("--upload-convert", action="store_true",
                    help="업로드 측정에서 GLB 변환을 실제로 예약한다. 기본은 convert=false "
                         "(전송 시간만 재고 변환은 §0 범위 밖). 켜면 라운드마다 변환 완료를 "
                         "기다려 세션이 수십 분~두 시간 길어진다")
    ap.add_argument("--no-drain-jobs", dest="drain_jobs", action="store_false",
                    help="변환을 예약하면서 완료를 기다리지 않는다. §9 위반 — 검증용만")
    ap.add_argument("--drain-timeout", type=float, default=2400.0,
                    help="한 라운드의 변환 완료를 기다리는 최대 초 (기본 2400)")

    ap.add_argument("--instance-type", default="t3.medium")
    ap.add_argument("--region", default="ap-northeast-2")
    ap.add_argument("--ebs-type", default="gp3")
    ap.add_argument("--serving", default="tmpfs")
    ap.add_argument("--server-version", default="")

    ap.add_argument("--cacert", default=None,
                    help="사설 CA 인증서 경로. 폐쇄망 TLS(예: KOREN Internal Root CA)용")
    ap.add_argument("--timeout", type=int, default=1200, help="요청 1건 최대 초")
    ap.add_argument("--sleep", type=float, default=0.0, help="라운드 간 대기 (초)")
    ap.add_argument("--ping-count", type=int, default=30)
    ap.add_argument("--router-ping-count", type=int, default=100)
    ap.add_argument("--router-ip", default=None, help="미지정 시 기본 게이트웨이 자동 탐지")
    ap.add_argument("--skip-probes", action="store_true",
                    help="세션 진단 생략. 하네스 검증용 — 실제 세션에서는 쓰지 말 것")
    ap.add_argument("--no-throttle-watch", action="store_true",
                    help="스로틀 감시 생략. §5.3 이 필수로 지정한 항목이므로 검증용만")
    ap.add_argument("--yes", action="store_true", help="egress 경고를 넘긴다")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    set_ca_bundle(args.cacert)

    try:
        return run_session(args)
    except ApiError as exc:
        print(f"API 오류: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
