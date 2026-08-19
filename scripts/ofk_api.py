"""OF_KOR_3D 백엔드 최소 클라이언트 (전송 측정용).

측정 하네스와 publish 스크립트가 공유한다. 프론트엔드의 `src/api/*` 와 같은
엔드포인트를 쓰지만, 측정 쪽은 다음이 달라서 별도로 둔다.

  - 수백 MB 본문을 메모리에 담지 않는다 (업로드는 `curl` 로 스트리밍)
  - 타겟 주소를 하드코딩하지 않는다 (측정 계획 §4-1: 9월 이중 타겟)
  - 응답 헤더의 구간 타이밍을 그대로 돌려준다 (§6.2)
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

# 계획 §6.2 는 `X-Server-Recv-Ms` / `X-Server-Store-Ms` / `X-Server-Db-Ms` 를 기대하지만,
# 실제 백엔드는 `Server-Timing` 의 recv/store/db 메트릭으로 내려준다 (OpenAPI 설명 확인).
# 계획 §11 "서버 타이밍 헤더가 이름이 문서와 다름" 에 해당 — 두 형식을 모두 읽는다.
LEGACY_TIMING_HEADERS = {
    "x-server-recv-ms": "recv",
    "x-server-store-ms": "store",
    "x-server-db-ms": "db",
}


# --------------------------------------------------------------------------
# 사설 CA (폐쇄망 TLS)
# --------------------------------------------------------------------------

_CA_BUNDLE: str | None = None


def set_ca_bundle(path: str | None) -> None:
    """사설 CA 인증서 경로를 등록한다. curl 과 urllib 이 함께 쓴다.

    시스템 신뢰 저장소를 고치지 않는 이유: 측정 재현성이 실행 기계의 상태에
    의존하면 안 된다. 9월에 다른 노트북에서 같은 명령으로 돌아가야 한다.
    """
    global _CA_BUNDLE
    _CA_BUNDLE = path


def ca_args() -> list[str]:
    """curl 인자. CA 가 없으면 빈 목록."""
    return ["--cacert", _CA_BUNDLE] if _CA_BUNDLE else []


def ssl_context():
    """urllib 용 SSLContext. CA 가 없으면 None (기본 검증)."""
    if not _CA_BUNDLE:
        return None
    import ssl
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(cafile=_CA_BUNDLE)
    return ctx


class ApiError(RuntimeError):
    pass


def _curl_json(argv: list[str], timeout: int) -> dict:
    """`curl -w %{json}` 의 전송 통계를 dict 로 돌려준다. 본문·헤더는 호출자가 파일로 받는다."""
    proc = subprocess.run(
        ["curl", "-sS", *ca_args(), *argv, "-w", "%{json}"],
        capture_output=True, text=True, timeout=timeout,
    )
    tail = proc.stdout.rfind("{")
    if tail < 0:
        raise ApiError(f"curl 출력에 통계 JSON 이 없다: rc={proc.returncode} {proc.stderr[-300:]}")
    try:
        stats = json.loads(proc.stdout[tail:])
    except json.JSONDecodeError as exc:
        raise ApiError(f"curl 통계 JSON 파싱 실패: {exc}") from exc
    stats["_stderr"] = proc.stderr[-300:]
    return stats


def parse_server_timing(values: list[str]) -> dict[str, float]:
    """`Server-Timing: recv;dur=123.4, store;dur=5.6` → `{"recv": 123.4, "store": 5.6}`."""
    out: dict[str, float] = {}
    for raw in values:
        for part in raw.split(","):
            seg = [s.strip() for s in part.split(";")]
            if not seg or not seg[0]:
                continue
            for kv in seg[1:]:
                key, _, val = kv.partition("=")
                if key.strip().lower() == "dur":
                    try:
                        out[seg[0]] = float(val.strip())
                    except ValueError:
                        pass
    return out


def read_timing_headers(header_dump: Path) -> tuple[dict[str, float], list[str]]:
    """curl `-D` 로 받은 헤더 덤프에서 구간 타이밍을 뽑는다.

    돌려주는 두 번째 값은 실제로 읽어낸 헤더 이름 목록이다. 리포트에 "문서와 이름이
    다르다" 를 근거로 적기 위해 남긴다 (§11).
    """
    timing_values: list[str] = []
    legacy: dict[str, float] = {}
    seen: list[str] = []
    if not header_dump.exists():
        return {}, []
    for line in header_dump.read_text(errors="replace").splitlines():
        name, sep, value = line.partition(":")
        if not sep:
            continue
        key = name.strip().lower()
        if key == "server-timing":
            timing_values.append(value.strip())
            seen.append(name.strip())
        elif key in LEGACY_TIMING_HEADERS:
            try:
                legacy[LEGACY_TIMING_HEADERS[key]] = float(value.strip())
                seen.append(name.strip())
            except ValueError:
                pass
    merged = parse_server_timing(timing_values)
    merged.update(legacy)  # 문서 형식이 실제로 오면 그쪽을 신뢰한다
    return merged, seen


def read_password(password_file: str | None) -> str:
    """비밀번호를 파일 또는 환경변수에서 읽는다.

    명령줄 인자로 받지 않는다. `ps` 에 보이고 셸 기록에 남으며, 무엇보다 세션
    메타데이터의 `command` 필드에 그대로 적혀 results/ 에 커밋될 수 있다.
    """
    import os

    if password_file:
        path = Path(password_file)
        if not path.exists():
            raise ApiError(f"비밀번호 파일이 없다: {path}")
        return path.read_text().strip()
    return os.environ.get("OFK_PASSWORD", "")


def login(target: str, email: str, password: str, timeout: int = 60) -> str:
    """`POST /api/auth/login` → accessToken."""
    import urllib.error
    import urllib.request

    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(
        f"{target.rstrip('/')}/api/auth/login", data=body, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as resp:
            payload = json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        raise ApiError(f"로그인 실패 ({exc.code}): {exc.read()[:300].decode(errors='replace')}") from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise ApiError(f"로그인 요청 실패: {exc}") from exc

    token = payload.get("accessToken") or payload.get("access_token") or payload.get("token")
    if not token:
        raise ApiError(f"로그인 응답에 토큰이 없다: {list(payload)}")
    return token


def net_allowance(target: str, timeout: int = 20) -> dict | None:
    """`GET /api/metrics/net-allowance` — ENA 스로틀 카운터 (§5.3).

    SSH `ethtool` 대신 이걸 쓴다. 실패하면 None — 카운터를 못 읽었다는 사실 자체를
    샘플에 남겨야 하므로 예외로 세션을 죽이지 않는다.
    """
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(
            f"{target.rstrip('/')}/api/metrics/net-allowance", timeout=timeout,
            context=ssl_context()
        ) as resp:
            return json.loads(resp.read() or b"{}")
    except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError):
        return None


def upload_asset(target: str, token: str, files: list[Path], label: str | None,
                 entry: str | None, header_dump: Path, body_dump: Path,
                 timeout: int = 3600, extra_query: str = "") -> dict:
    """`POST /api/assets` 를 curl 로 보낸다 (본문을 메모리에 담지 않기 위해).

    돌려주는 dict 는 curl 의 `%{json}` 전송 통계다. 응답 본문·헤더는 인자로 받은
    경로에 쓴다 — 호출자가 asset id 와 `Server-Timing` 을 거기서 읽는다.
    """
    argv = [
        "-o", str(body_dump), "-D", str(header_dump),
        "-H", f"Authorization: Bearer {token}",
        "-H", "Accept: application/json",
        "-H", "Expect:",  # 100-continue 왕복이 붙으면 전송 시간에 RTT 하나가 섞인다
        "--max-time", str(timeout),
    ]
    for f in files:
        argv += ["-F", f"files=@{f};filename={f.name}"]
    if entry:
        argv += ["-F", f"entry={entry}"]
    if label:
        argv += ["-F", f"label={label}"]
    argv.append(f"{target.rstrip('/')}/api/assets{extra_query}")
    return _curl_json(argv, timeout=timeout + 60)


def upload_ifc(target: str, token: str, path: Path, label: str | None,
               header_dump: Path, body_dump: Path, timeout: int = 3600,
               extra_query: str = "", convert: bool = True) -> dict:
    """`POST /api/assets/ifc` — IFC 원본을 올리고 GLB 변환을 예약한다 (§2.2 업로드 측정).

    `/api/assets` 와 다른 점:
      - 필드 이름이 `files` 가 아니라 **`file`** 이고 반복 필드가 아니다
      - 성공이 201 이 아니라 **202 Accepted** 다. 응답 시점에 변환은 시작도 안 했다
      - 응답 본문은 에셋이 아니라 변환 잡(`j_` 접두사 id)이다

    변환이 응답 밖으로 빠졌으므로 이 응답 시간에는 변환 시간이 섞이지 않는다 —
    §6.1 이 경고한 최대 함정이 서버 설계로 해소된 것이다. 대신 업로드가 끝나면 서버
    CPU 에서 변환이 돌기 시작하므로, 다음 라운드를 쏘기 전에 잡을 비워야 한다
    (§9 "측정 중 서버에서 다른 작업(변환, 빌드) 실행" 금지).

    `convert=False` 는 서버의 측정 전용 경로다. 원본을 받아 저장까지 하고 `skipped`
    상태의 기록용 잡만 남긴다. 변환이 아예 시작되지 않으므로 라운드 간 대기가 필요 없고
    (33MB × 21회 = 약 69분 절약), 동시 잡 2건 제한(429)과 변환기 가용성(503) 검사도
    건너뛴다. §3.2 업로드 측정은 이 경로를 쓴다 — 재는 것은 전송 시간이고 변환은
    §0 이 정한 범위 밖이다.
    """
    if not convert:
        extra_query += ("&" if "?" in extra_query else "?") + "convert=false"
    argv = [
        "-o", str(body_dump), "-D", str(header_dump),
        "-H", f"Authorization: Bearer {token}",
        "-H", "Accept: application/json",
        "-H", "Expect:",  # 100-continue 왕복이 붙으면 전송 시간에 RTT 하나가 섞인다
        "--max-time", str(timeout),
        "-F", f"file=@{path};filename={path.name}",
    ]
    if label:
        argv += ["-F", f"label={label}"]
    argv.append(f"{target.rstrip('/')}/api/assets/ifc{extra_query}")
    return _curl_json(argv, timeout=timeout + 60)


def get_ifc_job(target: str, token: str, job_id: str, timeout: int = 60) -> dict | None:
    """`GET /api/assets/jobs/{jobId}` — 변환 잡 조회.

    업로드는 `/api/assets/ifc` 지만 조회 경로는 `/api/assets/jobs/{id}` 다.

    403(남의 잡)·404(없는 잡)는 폴링을 계속할 이유가 없으므로 실패한 잡으로 바꿔
    돌려준다. 그 외 오류는 None — 일시적 장애일 수 있어 호출자가 재시도한다.
    """
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        f"{target.rstrip('/')}/api/assets/jobs/{job_id}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 404):
            return {"id": job_id, "status": "failed", "asset": None,
                    "errorCode": f"HTTP_{exc.code}",
                    "errorMessage": f"잡 조회가 {exc.code} 로 거절됐다"}
        return None
    except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError):
        return None


def drain_ifc_jobs(target: str, token: str, job_ids: list[str], poll_seconds: float = 1.0,
                   max_wait_seconds: float = 2400.0) -> tuple[list[str], list[dict]]:
    """잡이 전부 ready/failed 가 될 때까지 기다린다.

    돌려주는 값은 (변환 결과 에셋 id 목록, 실패 잡 목록). 에셋 id 는 정리(삭제)에 쓴다 —
    잡 id 로는 `DELETE /api/assets/{id}` 를 못 부른다.

    기다리는 이유는 두 가지다.
      1. 사용자당 동시 변환이 2건으로 제한돼 있어, 안 기다리면 세 번째 요청부터
         429 CONVERSION_BUSY 가 오고 그 샘플은 전송 시간이 아니다
      2. 변환이 도는 동안 다음 라운드를 쏘면 2 vCPU 를 변환과 나눠 쓰게 된다 (§9)

    상태 전이는 queued → converting → (ready | failed) 한 방향이라 되돌아오지 않는다.
    폴링 간격은 서버 권장값 1초를 쓴다.

    주의: 변환 중 서버가 재시작되면 그 잡은 `failed` / `SERVER_RESTART` 가 된다.
    워커 프로세스가 사라져 절대 끝나지 않으므로 여기서 기다려도 소용없고, 그
    라운드는 실패로 기록된다.
    """
    import time as _time

    pending = list(job_ids)
    asset_ids: list[str] = []
    failures: list[dict] = []
    deadline = _time.monotonic() + max_wait_seconds

    while pending and _time.monotonic() < deadline:
        still: list[str] = []
        for job_id in pending:
            job = get_ifc_job(target, token, job_id)
            if job is None:
                still.append(job_id)
                continue
            status = job.get("status")
            if status == "ready":
                asset = job.get("asset") or {}
                if asset.get("id"):
                    asset_ids.append(asset["id"])
            elif status == "failed":
                failures.append({"job_id": job_id, "code": job.get("errorCode"),
                                 "message": job.get("errorMessage")})
            elif status == "skipped":
                # convert=false 로 만든 기록용 잡. 변환이 시작되지 않으므로 종료 상태다.
                # 이걸 대기 대상으로 두면 영원히 안 끝나 drain 타임아웃까지 매달린다.
                pass
            else:
                still.append(job_id)
        pending = still
        if pending:
            _time.sleep(poll_seconds)

    if pending:
        failures.append({"job_id": ",".join(pending), "code": "DRAIN_TIMEOUT",
                         "message": f"{max_wait_seconds:.0f}s 안에 변환이 끝나지 않았다"})
    return asset_ids, failures


def delete_asset(target: str, token: str, asset_id: str, timeout: int = 120) -> int:
    """`DELETE /api/assets/{id}` — 측정으로 쌓인 에셋을 치운다. HTTP 코드를 돌려준다."""
    stats = _curl_json([
        "-o", "/dev/null", "-X", "DELETE",
        "-H", f"Authorization: Bearer {token}",
        "--max-time", str(timeout),
        f"{target.rstrip('/')}/api/assets/{asset_id}",
    ], timeout=timeout + 30)
    return int(stats.get("http_code") or 0)


# 서버가 강제하는 상한. 넘기면 422 다.
LIST_LIMIT_MAX = 100


def list_assets(target: str, token: str, limit: int = LIST_LIMIT_MAX,
                timeout: int = 60) -> dict:
    """`GET /api/assets` — **내가 올린 에셋만** 돌려준다 (소유자 스코프).

    `limit` 상한이 100 이라 그 이상은 offset 으로 이어 받는다.
    """
    import urllib.error
    import urllib.request

    limit = min(limit, LIST_LIMIT_MAX)
    items: list[dict] = []
    total = 0
    offset = 0
    while True:
        req = urllib.request.Request(
            f"{target.rstrip('/')}/api/assets?limit={limit}&offset={offset}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as resp:
                page = json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            raise ApiError(
                f"에셋 목록 조회 실패 ({exc.code}): "
                f"{exc.read()[:200].decode(errors='replace')}"
            ) from exc
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise ApiError(f"에셋 목록 요청 실패: {exc}") from exc

        batch = page.get("items") or []
        items.extend(batch)
        total = page.get("total", len(items))
        offset += len(batch)
        if not batch or offset >= total:
            break
    return {"items": items, "total": total}
