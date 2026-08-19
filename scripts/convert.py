"""IFC → GLB 변환.

변환 경로를 우선순위대로 시도하고 성공한 경로를 manifest 에 기록한다.
  1. direct : IfcConvert in.ifc out.glb
  2. dae    : IfcConvert in.ifc out.dae  → gltf-transform copy out.dae out.glb
  3. obj    : IfcConvert in.ifc out.obj  → assimp export out.obj out.glb

assets/raw/ 의 원본은 읽기만 한다. 절대 쓰지 않는다.
"""
from __future__ import annotations

import _pathfix  # noqa: F401

import argparse
import shutil
import sys
import tempfile
import time
from pathlib import Path

from common import (
    CONVERTED_DIR,
    GLTF_TRANSFORM,
    IFCCONVERT,
    RAW_DIR,
    fmt_mb,
    merge_entry,
    now_iso,
    peak_rss_mb,
    resolve_aliases,
    run,
)
from glb_stats import inspect_glb, validate_glb

TIMEOUT = 3600  # 초. 초과 시 실패로 기록하고 다음 경로 시도.


def _timed(cmd: list, timeout: int) -> tuple[bool, float, float | None, str]:
    """`/usr/bin/time -l` 로 감싸 실행 시간과 피크 메모리를 함께 측정."""
    t0 = time.perf_counter()
    try:
        proc = run(["/usr/bin/time", "-l", *cmd], timeout=timeout)
    except Exception as exc:  # TimeoutExpired 포함
        return False, time.perf_counter() - t0, None, f"{type(exc).__name__}: {exc}"
    dt = time.perf_counter() - t0
    log = ((proc.stdout or "") + (proc.stderr or "")).strip()
    return proc.returncode == 0, dt, peak_rss_mb(proc), log[-4000:]


def convert_one(ifc: Path, alias: str, force: bool = False,
                ifc_args: list[str] | None = None, suffix: str = "") -> dict:
    """suffix 를 주면 {alias}{suffix}.glb 로 별도 출력하고 manifest 키도 분리한다.

    IfcConvert 옵션이 결과 구조에 미치는 영향을 비교할 때 쓴다
    (예: --permissive-shape-reuse 가 공유 메시 참조를 살리는지).
    """
    ifc_args = ifc_args or []
    key = f"{alias}{suffix}"
    CONVERTED_DIR.mkdir(parents=True, exist_ok=True)
    out_glb = CONVERTED_DIR / f"{key}.glb"
    base: dict = {}

    if out_glb.exists() and not force:
        print(f"[skip] {alias}: {out_glb} 이미 존재 (--force 로 재변환)")
    else:
        attempts: list[dict] = []
        tmpdir = Path(tempfile.mkdtemp(prefix=f"conv_{alias}_"))
        try:
            paths = [
                ("direct", [[IFCCONVERT, "-y", "--no-progress", *ifc_args, str(ifc), str(out_glb)]]),
                (
                    "dae",
                    [
                        [IFCCONVERT, "-y", "--no-progress", *ifc_args, str(ifc), str(tmpdir / f"{key}.dae")],
                        [GLTF_TRANSFORM, "copy", str(tmpdir / f"{key}.dae"), str(out_glb)],
                    ],
                ),
                (
                    "obj",
                    [
                        [IFCCONVERT, "-y", "--no-progress", *ifc_args, str(ifc), str(tmpdir / f"{key}.obj")],
                        ["assimp", "export", str(tmpdir / f"{key}.obj"), str(out_glb)],
                    ],
                ),
            ]

            succeeded = None
            for name, steps in paths:
                print(f"[{alias}] 경로 '{name}' 시도")
                total = 0.0
                peak = None
                ok = True
                logs = []
                for step in steps:
                    ok, dt, rss, log = _timed(step, TIMEOUT)
                    total += dt
                    peak = max(peak or 0, rss or 0) or None
                    logs.append(log)
                    if not ok:
                        break
                ok = ok and out_glb.exists() and out_glb.stat().st_size > 0
                attempts.append(
                    {
                        "path": name,
                        "ok": ok,
                        "seconds": round(total, 3),
                        "peak_rss_mb": round(peak, 1) if peak else None,
                        "log_tail": logs[-1].splitlines()[-8:] if logs else [],
                    }
                )
                if ok:
                    succeeded = (name, total, peak)
                    print(f"[{alias}] 경로 '{name}' 성공 ({total:.1f}s)")
                    break
                out_glb.unlink(missing_ok=True)
                print(f"[{alias}] 경로 '{name}' 실패")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

        if succeeded is None:
            entry = {
                "alias": alias,
                "source_ifc": str(ifc).replace(str(ifc.parents[2]) + "/", ""),
                "ifc_size_bytes": ifc.stat().st_size,
                "ifcconvert_args": ifc_args,
                "conversion_status": "failed",
                "conversion_attempts": attempts,
                "converted_at": now_iso(),
            }
            merge_entry(key, entry)
            return entry

        name, total, peak = succeeded
        base = {
            "conversion_path": name,
            "conversion_seconds": round(total, 3),
            "conversion_peak_rss_mb": round(peak, 1) if peak else None,
            "conversion_attempts": attempts,
        }

    stats = inspect_glb(out_glb)
    entry = {
        "alias": alias,
        "source_ifc": str(ifc).replace(str(ifc.parents[2]) + "/", ""),
        "ifc_size_bytes": ifc.stat().st_size,
        "glb_path": f"assets/converted/{key}.glb",
        "ifcconvert_args": ifc_args,
        "conversion_status": "ok",
        **base,
        **stats,
        "converted_at": now_iso(),
    }
    merge_entry(key, entry)
    return entry


def main() -> int:
    ap = argparse.ArgumentParser(description="IFC → GLB 변환")
    ap.add_argument("target", nargs="?", default=str(RAW_DIR),
                    help="IFC 파일 또는 디렉터리 (기본: assets/raw)")
    ap.add_argument("--force", action="store_true", help="기존 GLB 재변환")
    ap.add_argument("--validate", action="store_true", help="변환 후 gltf-transform validate")
    ap.add_argument("--only", nargs="*", default=None, help="이 별칭만 변환")
    ap.add_argument("--ifc-arg", action="append", default=None, dest="ifc_args",
                    help="IfcConvert 에 그대로 넘길 옵션 (반복 가능). 예: --ifc-arg --permissive-shape-reuse")
    ap.add_argument("--suffix", default="",
                    help="출력 파일명/manifest 키 접미사. --ifc-arg 비교본을 따로 남길 때 사용")
    args = ap.parse_args()

    target = Path(args.target)
    ifcs = sorted(target.glob("*.ifc")) if target.is_dir() else [target]
    if not ifcs:
        print(f"IFC 파일 없음: {target}", file=sys.stderr)
        return 1

    aliases = resolve_aliases(ifcs)
    if args.only:
        aliases = {a: p for a, p in aliases.items() if a in args.only}
    print(f"대상 {len(aliases)}개: {', '.join(aliases)}")
    if args.ifc_args:
        print(f"IfcConvert 추가 옵션: {' '.join(args.ifc_args)} → 접미사 '{args.suffix}'")
    print()

    failures = []
    for alias, ifc in aliases.items():
        key = f"{alias}{args.suffix}"
        entry = convert_one(ifc, alias, force=args.force,
                            ifc_args=args.ifc_args, suffix=args.suffix)
        if entry.get("conversion_status") != "ok":
            failures.append(key)
            continue
        if args.validate:
            v = validate_glb(CONVERTED_DIR / f"{key}.glb")
            merge_entry(key, {"validation": v})
            entry["validation"] = v
        print(
            f"  {key}: {fmt_mb(entry['ifc_size_bytes'])} IFC → {fmt_mb(entry['glb_size_bytes'])} GLB "
            f"| tri={entry['triangle_count']:,} mesh={entry['mesh_count']:,} "
            f"prim={entry['primitive_count']:,} node={entry['node_count']:,} "
            f"mat={entry['material_count']} tex={entry['texture_count']} uv={entry['has_uv']}"
        )
        if entry["triangle_count"] < 1000:
            print(f"  !! 경고: {key} 삼각형 수 {entry['triangle_count']} < 1000 — 지오메트리 유실 의심")

    if failures:
        print(f"\n변환 실패: {', '.join(failures)}", file=sys.stderr)
        return 2
    print(f"\nmanifest → results/asset_manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
