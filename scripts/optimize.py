"""압축 변형본 생성 (명세 §5).

각 에셋에 대해 4가지 변형본을 만든다.

  raw      변환 결과 그대로 복사
  draco    gltf-transform draco
  meshopt  gltf-transform meshopt
  full     meshopt → uastc (KTX2). texture_count == 0 이면 uastc 를 건너뛴다.

크기·처리 시간·통계를 manifest 의 `variants` 에 누적한다.
압축 후 크기가 오히려 커지면 경고를 남긴다 (명세 §11 보고 대상).
"""
from __future__ import annotations

import _pathfix  # noqa: F401

import argparse
import shutil
import sys
import time
from pathlib import Path

from common import (
    CONVERTED_DIR,
    GLTF_TRANSFORM,
    ROOT,
    SCENES_DIR,
    fmt_mb,
    load_manifest,
    merge_entry,
    now_iso,
    run,
)
from glb_stats import inspect_glb

VARIANTS = ("raw", "draco", "meshopt", "full")


def _step(cmd: list, label: str) -> tuple[bool, float, str]:
    t0 = time.perf_counter()
    proc = run([GLTF_TRANSFORM, *cmd], timeout=3600)
    dt = time.perf_counter() - t0
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if proc.returncode != 0:
        print(f"    [{label}] 실패 rc={proc.returncode}\n{out[-1500:]}")
    return proc.returncode == 0, dt, out[-2000:]


def build_variants(alias: str, src: Path, force: bool = False) -> dict:
    out_dir = src.parent
    base_stats = inspect_glb(src)
    has_texture = base_stats["texture_count"] > 0
    raw_size = src.stat().st_size

    results: dict[str, dict] = {}
    warnings: list[str] = []

    for variant in VARIANTS:
        dst = out_dir / f"{alias}_{variant}.glb"
        elapsed: float | None = None
        skipped: list[str] = []
        if dst.exists() and not force:
            print(f"  [skip] {dst.name} 존재")
        else:
            dst.unlink(missing_ok=True)
            if variant == "raw":
                t0 = time.perf_counter()
                shutil.copy2(src, dst)
                elapsed, ok = time.perf_counter() - t0, True
            elif variant == "draco":
                ok, elapsed, _ = _step(["draco", str(src), str(dst)], f"{alias}:draco")
            elif variant == "meshopt":
                ok, elapsed, _ = _step(["meshopt", str(src), str(dst)], f"{alias}:meshopt")
            else:  # full = meshopt + uastc(KTX2)
                tmp = out_dir / f".{alias}_full.tmp.glb"
                ok, elapsed, _ = _step(["meshopt", str(src), str(tmp)], f"{alias}:full/meshopt")
                if ok and has_texture:
                    ok2, dt2, _ = _step(["uastc", str(tmp), str(dst)], f"{alias}:full/uastc")
                    elapsed += dt2
                    if not ok2:
                        ok = False
                    tmp.unlink(missing_ok=True)
                elif ok:
                    # 텍스처 0개 → KTX2 무의미. meshopt 결과를 그대로 full 로 쓴다.
                    tmp.replace(dst)
                    skipped = ["uastc (texture_count == 0)"]
                else:
                    tmp.unlink(missing_ok=True)

            if not ok or not dst.exists():
                results[variant] = {"status": "failed", "seconds": round(elapsed, 3)}
                warnings.append(f"{alias}/{variant} 생성 실패")
                continue

        stats = inspect_glb(dst)
        size = dst.stat().st_size
        entry = {
            "status": "ok",
            "path": str(dst.relative_to(ROOT)),
            "size_bytes": size,
            "ratio_vs_raw": round(size / raw_size, 4),
            "saving_pct": round((1 - size / raw_size) * 100, 2),
            "triangle_count": stats["triangle_count"],
            "node_count": stats["node_count"],
            "texture_count": stats["texture_count"],
            "has_uv": stats["has_uv"],
            "extensions_used": stats["extensions_used"],
        }
        if elapsed is not None:
            entry["seconds"] = round(elapsed, 3)
        if skipped:
            entry["skipped_steps"] = skipped
        results[variant] = entry

        flag = ""
        if variant != "raw" and size >= raw_size:
            flag = "  !! 압축 후 크기 증가"
            warnings.append(f"{alias}/{variant}: {fmt_mb(raw_size)} → {fmt_mb(size)} (증가)")
        print(f"  {variant:8s} {fmt_mb(size):>10s}  (raw 대비 절감 {entry['saving_pct']:.1f}%){flag}")

    merge_entry(alias, {"variants": results, "variants_built_at": now_iso()})
    return {"variants": results, "warnings": warnings}


def instance_check(alias: str, src: Path, force: bool = False) -> dict:
    """명세 §6 — `gltf-transform instance` 전후 크기·노드 수 비교.

    EXT_mesh_gpu_instancing 은 동일 메시를 여러 노드가 참조할 때만 효과가 있다.
    효과가 없으면 그 사실 자체를 수치로 남긴다 (시연용 최적화 효과 그래프 근거).
    """
    dst = src.parent / f"{alias}_instanced.glb"
    before = inspect_glb(src)

    if dst.exists() and not force:
        print(f"  [skip] {dst.name} 존재")
        elapsed = None
    else:
        dst.unlink(missing_ok=True)
        ok, elapsed, out = _step(["instance", str(src), str(dst)], f"{alias}:instance")
        if not ok or not dst.exists():
            result = {"status": "failed", "seconds": round(elapsed, 3), "log_tail": out[-800:]}
            merge_entry(alias, {"instancing": result})
            return result

    after = inspect_glb(dst)
    result = {
        "status": "ok",
        "path": str(dst.relative_to(CONVERTED_DIR.parent.parent)),
        "seconds": round(elapsed, 3) if elapsed is not None else None,
        "before": {
            "size_bytes": before["glb_size_bytes"],
            "node_count": before["node_count"],
            "mesh_count": before["mesh_count"],
            "primitive_count": before["primitive_count"],
            "instanced_nodes": before["instanced_nodes"],
        },
        "after": {
            "size_bytes": after["glb_size_bytes"],
            "node_count": after["node_count"],
            "mesh_count": after["mesh_count"],
            "primitive_count": after["primitive_count"],
            "instanced_nodes": after["instanced_nodes"],
        },
        "size_delta_bytes": after["glb_size_bytes"] - before["glb_size_bytes"],
        "size_saving_pct": round(
            (1 - after["glb_size_bytes"] / before["glb_size_bytes"]) * 100, 2
        ),
        "node_delta": after["node_count"] - before["node_count"],
        "effective": after["instanced_nodes"] > 0,
    }
    merge_entry(alias, {"instancing": result})

    print(
        f"  instance: {fmt_mb(before['glb_size_bytes'])} → {fmt_mb(after['glb_size_bytes'])} "
        f"({result['size_saving_pct']:+.1f}% 절감) | "
        f"node {before['node_count']:,} → {after['node_count']:,} | "
        f"EXT_mesh_gpu_instancing 노드 {after['instanced_nodes']:,}"
    )
    if not result["effective"]:
        print("    (인스턴싱 적용 대상 없음 — 공유 메시 참조가 없다는 뜻)")
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="압축 변형본 생성")
    ap.add_argument("aliases", nargs="*", help="대상 별칭 (기본: manifest 전체)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--instance", action="store_true",
                    help="압축 변형본 대신 인스턴싱 전후 비교만 수행 (명세 §6)")
    ap.add_argument("--scenes", action="store_true",
                    help="assets/converted 대신 assets/scenes 를 대상으로 한다")
    args = ap.parse_args()

    src_dir = SCENES_DIR if args.scenes else CONVERTED_DIR
    if args.aliases:
        targets = args.aliases
    elif args.scenes:
        targets = [p.stem for p in sorted(src_dir.glob("*.glb"))
                   if not any(p.stem.endswith(f"_{v}") for v in (*VARIANTS, "instanced"))]
    else:
        manifest = load_manifest()
        targets = [a for a, e in manifest.items() if e.get("conversion_status") == "ok"]
    if not targets:
        print("대상 없음. 먼저 scripts/convert.py 를 실행하라.", file=sys.stderr)
        return 1

    all_warnings = []
    for alias in targets:
        src = src_dir / f"{alias}.glb"
        if not src.exists():
            print(f"[{alias}] {src} 없음 — 건너뜀", file=sys.stderr)
            continue
        print(f"\n== {alias} (raw {fmt_mb(src.stat().st_size)})")
        if args.instance:
            instance_check(alias, src, force=args.force)
        else:
            all_warnings += build_variants(alias, src, force=args.force)["warnings"]

    if all_warnings:
        print("\n!! 보고 대상:")
        for w in all_warnings:
            print("  -", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
