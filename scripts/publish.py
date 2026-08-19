"""다운로드 측정 대상을 서버에 올리고 대상 목록을 만든다 (§10 첫 항목).

    OFK_PASSWORD=... python scripts/publish.py \
        --target https://aws.example.com --label commercial --email me@example.com

`POST /api/assets` 로 `site_stacked_{raw,meshopt,draco}.glb` 를 올리고, 응답의 `url` 을
`results/download_targets_{label}.json` 에 적는다. measure.py 가 이 파일을 읽는다.

**측정이 아니다.** 여기서 나오는 업로드 시간은 기록하지 않는다 — 배치용 1회성 전송이고,
§3.2 의 업로드 측정은 IFC 를 대상으로 별도로 한다.

올린 뒤 §11 확인: 서버가 tmpfs 에서 서빙하는지, `Timing-Allow-Origin` 이 붙는지
(§5.2 브라우저 하네스가 구간 분해를 하려면 필요) HEAD 로 점검해 함께 기록한다.
"""
from __future__ import annotations

import _pathfix  # noqa: F401

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from common import RESULTS_DIR, SCENES_DIR, now_iso
from ofk_api import (ApiError, ca_args, list_assets, login, read_password,
                     set_ca_bundle, upload_asset)

ASSET = "site_stacked"
VARIANTS = ("raw", "meshopt", "draco")

# `POST /api/assets` 는 전체 합계 512MB 까지 받는다. raw 가 339MB 라 여유는 있지만,
# 가정용 상향 회선으로 다 올린 뒤 413 을 받으면 수십 분이 낭비된다. 먼저 막는다.
MAX_ASSET_UPLOAD_MB = 512


def sha256_of(path: Path) -> str:
    """엔트리 파일 해시. 서버가 돌려주는 sha256 과 비교해 같은 바이트임을 증명한다 (§4-2)."""
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def head_check(url: str, timeout: int = 60) -> dict:
    """대상 URL 의 응답 헤더를 본다. 캐시 정책과 TAO 유무를 기록해 둔다."""
    proc = subprocess.run(
        ["curl", "-sS", *ca_args(), "-I", "--max-time", str(timeout), url],
        capture_output=True, text=True, timeout=timeout + 30,
    )
    headers: dict[str, str] = {}
    status = 0
    for line in proc.stdout.splitlines():
        if line.upper().startswith("HTTP/"):
            parts = line.split()
            if len(parts) > 1 and parts[1].isdigit():
                status = int(parts[1])
            continue
        name, sep, value = line.partition(":")
        if sep:
            headers[name.strip().lower()] = value.strip()
    return {
        "status": status,
        "content_length": headers.get("content-length"),
        "content_type": headers.get("content-type"),
        "cache_control": headers.get("cache-control"),
        "accept_ranges": headers.get("accept-ranges"),
        # 없으면 브라우저가 requestStart·responseStart 를 0 으로 가려서 §5.2 의
        # 구간 분해가 불가능해진다 (그 경우 resource: null 로 기록).
        "timing_allow_origin": headers.get("timing-allow-origin"),
        "server": headers.get("server"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="다운로드 측정 대상 업로드 및 목록 생성")
    ap.add_argument("--target", required=True)
    ap.add_argument("--label", required=True, help="loopback | commercial | koren")
    ap.add_argument("--email", default=None)
    ap.add_argument("--password-file", default=None,
                    help="비밀번호가 담긴 파일 경로. 미지정 시 환경변수 OFK_PASSWORD")
    ap.add_argument("--token", default=None, help="또는 환경변수 OFK_TOKEN")
    ap.add_argument("--variants", nargs="+", default=list(VARIANTS), choices=list(VARIANTS))
    ap.add_argument("--reuse", action="store_true",
                    help="이미 올라간 같은 이름의 에셋을 재사용한다 (재업로드 안 함)")
    ap.add_argument("--cacert", default=None, help="사설 CA 인증서 경로")
    ap.add_argument("--timeout", type=int, default=7200)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    set_ca_bundle(args.cacert)

    token = args.token or os.environ.get("OFK_TOKEN", "")
    if not token:
        password = read_password(args.password_file)
        if not (args.email and password):
            raise SystemExit(
                "토큰이 필요하다.\n"
                "  --token <토큰>  또는  OFK_TOKEN=<토큰>  또는\n"
                "  --email <이메일> 과 --password-file <경로> (또는 OFK_PASSWORD)"
            )
        token = login(args.target, args.email, password)
        print("로그인 완료")

    existing: dict[str, dict] = {}
    if args.reuse:
        for item in list_assets(args.target, token).get("items", []):
            existing[item.get("entryFilename", "")] = item
        print(f"기존 에셋 {len(existing)}개 확인")

    variants: dict[str, dict] = {}
    tmpdir = Path(tempfile.mkdtemp(prefix="ofk_publish_"))
    try:
        for variant in args.variants:
            path = SCENES_DIR / f"{ASSET}_{variant}.glb"
            if not path.exists():
                raise SystemExit(
                    f"{path} 없음 — 먼저 씬을 만들 것:\n"
                    f"  python scripts/compose.py site_stacked\n"
                    f"  python scripts/optimize.py site_stacked --scenes"
                )
            size = path.stat().st_size
            if size > MAX_ASSET_UPLOAD_MB * 1024 * 1024:
                raise SystemExit(
                    f"{path.name} 이 {size / 1e6:.1f} MB — 서버 한도 {MAX_ASSET_UPLOAD_MB}MB 초과. "
                    f"올려도 413 ASSET_TOO_LARGE 다."
                )
            local_hash = sha256_of(path)

            item = existing.get(path.name)
            if item:
                print(f"  [reuse] {path.name} → {item['url']}")
            else:
                print(f"  업로드 {path.name} ({size / 1e6:.2f} MB) …", flush=True)
                hdr = tmpdir / f"{variant}_h.txt"
                body = tmpdir / f"{variant}_b.json"
                stats = upload_asset(
                    args.target, token, [path], label=f"transfer-measure {ASSET} {variant}",
                    entry=path.name, header_dump=hdr, body_dump=body, timeout=args.timeout,
                )
                code = int(stats.get("http_code") or 0)
                if code not in (200, 201):
                    raise SystemExit(
                        f"업로드 실패 ({code}): {body.read_text()[:400] if body.exists() else ''}\n"
                        f"  .glb 만 받는 엔드포인트다. 응답을 확인할 것."
                    )
                item = json.loads(body.read_text())
                print(f"    → {item['url']}  ({stats.get('time_total', 0):.1f}s)")

            url = item["url"]
            abs_url = url if url.startswith("http") else args.target.rstrip("/") + url
            probe = head_check(abs_url)
            if probe["status"] != 200:
                print(f"    !! HEAD {probe['status']} — 다운로드 경로를 확인할 것",
                      file=sys.stderr)
            if probe["content_length"] and int(probe["content_length"]) != size:
                print(f"    !! Content-Length {probe['content_length']} != 로컬 {size} "
                      f"— 서버가 다른 파일을 서빙한다", file=sys.stderr)
            if not probe["timing_allow_origin"]:
                print("    !! Timing-Allow-Origin 없음 — 브라우저 하네스는 구간 분해 없이 "
                      "수동 측정값만 기록한다 (§5.2)", file=sys.stderr)

            # 서버가 돌려준 엔트리 해시가 로컬과 같아야 "같은 바이트를 쟀다" 고 말할 수 있다.
            server_hash = item.get("sha256")
            hash_ok = bool(server_hash) and server_hash == local_hash
            if server_hash and not hash_ok:
                print(f"    !! sha256 불일치 — 서버 {server_hash[:16]}… vs "
                      f"로컬 {local_hash[:16]}… 서버가 다른 바이트를 갖고 있다",
                      file=sys.stderr)

            variants[variant] = {
                "asset_id": item.get("id"),
                "entry_filename": item.get("entryFilename"),
                "url": url,
                "size_bytes": size,
                "server_size_bytes": item.get("sizeBytes"),
                "sha256": server_hash,
                "local_sha256": local_hash,
                "sha256_match": hash_ok,
                "probe": probe,
            }
    finally:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)

    manifest = {
        "asset": ASSET,
        "label": args.label,
        "target_url": args.target,
        "published_at": now_iso(),
        # §4-2: 9월에 씬을 다시 만들지 않는다. 이 sha256 으로 동일 파일임을 증명한다.
        "note": "9월 KOREN 측정에서도 이 파일을 그대로 쓴다 (§4-2). 재생성 금지.",
        "variants": variants,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out = Path(args.out) if args.out else RESULTS_DIR / f"download_targets_{args.label}.json"
    out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"\n대상 목록 → {out}")
    print(f"이제: python scripts/measure.py --target {args.target} --label {args.label}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ApiError as exc:
        print(f"API 오류: {exc}", file=sys.stderr)
        sys.exit(2)
