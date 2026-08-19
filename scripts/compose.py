"""합성 씬 생성 (명세 §7).

개별 에셋은 단독으로 네트워크 차이를 드러내기에 용량이 부족하다. 합쳐서 키운다.

배치 방식: `gltf-transform merge` 는 좌표 오프셋 기능이 없으므로,
병합 *전에* 각 GLB 의 루트 노드에 translation 을 적용한 임시본을 만든 뒤 병합한다
(glb_edit.translate_glb). 배치는 정확할 필요 없고 겹치지만 않으면 된다.

    python scripts/compose.py site_minimal
    python scripts/compose.py site_minimal --fill-to-mb 50
"""
from __future__ import annotations

import _pathfix  # noqa: F401

import argparse
import json
import math
import shutil
import sys
import tempfile
import time
from pathlib import Path

from common import CONVERTED_DIR, GLTF_TRANSFORM, RESULTS_DIR, SCENES_DIR, fmt_mb, now_iso, run
from glb_edit import bake_transform_glb, read_glb, scene_bounds_hint, translate_glb
from glb_stats import inspect_glb, validate_glb

# 씬 정의. position 단위는 원본 IFC 좌표계(대개 mm 또는 m) — 아래에서 자동 추정한다.
#
# 명세 §7 의 site_minimal 은 `spa` (본체) + `boomlift` (15m 이격) 이지만,
# spa (Spa Building / ArchiCAD) 원본 IFC 가 확보되지 않아 제외했다.
# 씬의 뼈대가 빠진 만큼 용량은 filler 반복으로 채운다 (명세 §7 "미달하면 인스턴싱 개수를 늘려 채운다").
SCENES: dict[str, dict] = {
    "site_minimal": {
        "description": "측정 대상 씬. spa 미확보로 boomlift 중심 + hoist/rooflight 로 용량 확보.",
        "placements": [
            {"alias": "boomlift", "offset_m": (0, 0, 0)},
            {"alias": "hoist", "offset_m": (15, 0, 0)},
        ],
        "filler": {"alias": "rooflight", "offset_m": (0, 0, 15), "spacing_m": 8},
        "omitted": ["spa (원본 IFC 미확보)"],
    },
    # 전송 측정 계획 §2.1 의 다운로드 대상. hoist 를 수직으로 20단 쌓아 대용량 단일
    # 파일을 만든다. filler 격자와 달리 한 에셋만 반복하므로, 압축 변형본의 크기 차이가
    # 지오메트리 종류가 아니라 압축 방식에서만 나온다.
    "site_stacked": {
        "description": "hoist 20단 적층. 전송 측정용 대용량 단일 파일 (측정 계획 §2.1).",
        "placements": [],
        # scale_step: 단마다 지오메트리를 미세하게 다르게 만들어 dedup 을 막는다.
        # 0 으로 두면 20단이 압축 후 1단 크기로 접힌다 (bake_transform_glb docstring 참조).
        "stack": {"alias": "hoist", "count": 20, "axis": "z", "scale_step": 0.003},
        "omitted": [],
    },
    "site_full": {
        "description": "나중 단계용 스켈레톤. 지금은 정의만 두고 빌드하지 않는다.",
        "placements": [
            {"alias": "boomlift", "offset_m": (0, 0, 0)},
            {"alias": "hoist", "offset_m": (15, 0, 0)},
            {"alias": "rooflight", "offset_m": (0, 0, 15)},
            {"alias": "elevator", "offset_m": (30, 0, 0)},
        ],
        "filler": {"alias": "shingle_a", "offset_m": (0, 0, 30), "spacing_m": 2},
        "omitted": ["spa (원본 IFC 미확보)"],
        "skeleton_only": True,
    },
}


def _unit_scale(glb: Path) -> float:
    """GLB 좌표계가 미터인지 밀리미터인지 추정해 '1m 에 해당하는 좌표값'을 돌려준다.

    IFC 는 mm 단위가 흔하고 IfcConvert 는 그 단위를 그대로 내보낸다. 정확한 배치가
    목적이 아니므로, AABB 최대 변 길이가 1000 을 넘으면 mm 로 간주하는 휴리스틱이면 충분하다.
    """
    doc, _ = read_glb(glb)
    bounds = scene_bounds_hint(doc)
    if not bounds:
        return 1.0
    lo, hi = bounds
    extent = max(hi[i] - lo[i] for i in range(3))
    return 1000.0 if extent > 1000 else 1.0


AXIS_INDEX = {"x": 0, "y": 1, "z": 2}


def _extent_m(glb: Path, axis: str, scale: float) -> float:
    """지정 축의 AABB 길이를 미터로 돌려준다. 적층 간격의 기본값으로 쓴다.

    IfcConvert 는 Z-up 으로 내보내는 경우가 많아 "수직" 축이 y 라고 단정할 수 없다.
    축은 씬 정의에서 지정하고, 간격은 여기서 실측한다.
    """
    doc, _ = read_glb(glb)
    bounds = scene_bounds_hint(doc)
    if not bounds:
        return 0.0
    lo, hi = bounds
    i = AXIS_INDEX[axis]
    return (hi[i] - lo[i]) / scale


def _source_for(alias: str) -> Path:
    src = CONVERTED_DIR / f"{alias}.glb"
    if not src.exists():
        raise FileNotFoundError(f"{src} 없음 — scripts/convert.py 를 먼저 실행할 것")
    return src


def build_scene(name: str, fill_to_mb: float | None = None, force: bool = False) -> dict:
    spec = SCENES[name]
    SCENES_DIR.mkdir(parents=True, exist_ok=True)
    out = SCENES_DIR / f"{name}.glb"
    if out.exists() and not force:
        print(f"[skip] {out} 존재 (--force 로 재생성)")
        return {"status": "skipped", "path": str(out)}

    tmpdir = Path(tempfile.mkdtemp(prefix=f"scene_{name}_"))
    parts: list[Path] = []
    placed: list[dict] = []
    t0 = time.perf_counter()

    try:
        for i, p in enumerate(spec["placements"]):
            src = _source_for(p["alias"])
            scale = _unit_scale(src)
            offset = tuple(v * scale for v in p["offset_m"])
            dst = tmpdir / f"{i:03d}_{p['alias']}.glb"
            translate_glb(src, dst, offset, name=f"{p['alias']}")
            parts.append(dst)
            placed.append({"alias": p["alias"], "offset_m": list(p["offset_m"]),
                           "unit_scale": scale, "size_bytes": dst.stat().st_size})
            print(f"  배치 {p['alias']:10s} @ {p['offset_m']} m  ({fmt_mb(dst.stat().st_size)})")

        # 한 에셋을 한 축으로 N단 쌓는다 (적층 씬).
        stack = spec.get("stack")
        stacked: dict | None = None
        if stack:
            ssrc = _source_for(stack["alias"])
            sscale = _unit_scale(ssrc)
            axis = stack["axis"]
            step = stack.get("spacing_m") or _extent_m(ssrc, axis, sscale)
            if step <= 0:
                raise ValueError(
                    f"{stack['alias']}: {axis} 축 AABB 를 못 구했다 — spacing_m 을 명시할 것"
                )
            ai = AXIS_INDEX[axis]
            scale_step = stack.get("scale_step", 0.0)
            print(f"  적층 {stack['alias']} × {stack['count']}단 "
                  f"({axis} 축, 간격 {step:.2f} m, 단별 배율 +{scale_step * 100:.1f}%/단)")
            cursor = 0.0  # 다음 단의 바닥 높이 (배율이 단마다 달라 누적으로 계산한다)
            for k in range(stack["count"]):
                s = 1.0 + k * scale_step
                off = [0.0, 0.0, 0.0]
                off[ai] = cursor * sscale
                dst = tmpdir / f"s{k:03d}_{stack['alias']}.glb"
                # 노드 transform 이 아니라 좌표 데이터에 직접 굽는다 — dedup 방지 (§2.1 크기 목표)
                bake_transform_glb(ssrc, dst, tuple(off), scale=s,
                                   name=f"{stack['alias']}_L{k:02d}")
                parts.append(dst)
                cursor += step * s
            stacked = {"alias": stack["alias"], "count": stack["count"], "axis": axis,
                       "spacing_m": round(step, 3), "scale_step": scale_step,
                       "total_height_m": round(cursor, 3), "unit_scale": sscale,
                       "unit_size_bytes": ssrc.stat().st_size,
                       "baked": "positions (dedup 방지)"}

        # 목표 용량 미달 시 filler 를 격자로 반복 배치해 채운다.
        current = sum(p.stat().st_size for p in parts)
        filler = spec.get("filler")
        n_fill = 0
        if fill_to_mb and filler:
            target = fill_to_mb * 1_000_000
            fsrc = _source_for(filler["alias"])
            fscale = _unit_scale(fsrc)
            unit = fsrc.stat().st_size
            if current < target:
                n_fill = math.ceil((target - current) / unit)
                side = math.ceil(math.sqrt(n_fill))
                print(f"  filler {filler['alias']} × {n_fill} ({side}×{side} 격자, "
                      f"간격 {filler['spacing_m']} m)")
                for k in range(n_fill):
                    gx, gz = k % side, k // side
                    off = (
                        (filler["offset_m"][0] + gx * filler["spacing_m"]) * fscale,
                        filler["offset_m"][1] * fscale,
                        (filler["offset_m"][2] + gz * filler["spacing_m"]) * fscale,
                    )
                    dst = tmpdir / f"f{k:04d}_{filler['alias']}.glb"
                    translate_glb(fsrc, dst, off, name=f"{filler['alias']}_{k:04d}")
                    parts.append(dst)

        print(f"  merge {len(parts)}개 → {out.name}")
        proc = run([GLTF_TRANSFORM, "merge", *[str(p) for p in parts], str(out),
                    "--merge-scenes"], timeout=7200)
        if proc.returncode != 0:
            print(((proc.stdout or "") + (proc.stderr or ""))[-2000:], file=sys.stderr)
            return {"status": "failed", "stderr": (proc.stderr or "")[-2000:]}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    elapsed = time.perf_counter() - t0
    stats = inspect_glb(out)
    result = {
        "scene": name,
        "status": "ok",
        "path": f"assets/scenes/{name}.glb",
        "description": spec["description"],
        "placements": placed,
        "stack": stacked,
        "filler_count": n_fill,
        "filler_alias": (filler or {}).get("alias") if n_fill else None,
        "omitted": spec.get("omitted", []),
        "compose_seconds": round(elapsed, 3),
        "validation": validate_glb(out),
        "built_at": now_iso(),
        **stats,
    }

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    idx_path = RESULTS_DIR / "scene_manifest.json"
    index = json.loads(idx_path.read_text()) if idx_path.exists() else {}
    index[name] = result
    idx_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")

    size_mb = stats["glb_size_bytes"] / 1_000_000
    print(f"\n  {out}: {fmt_mb(stats['glb_size_bytes'])} | "
          f"tri={stats['triangle_count']:,} node={stats['node_count']:,} "
          f"mesh={stats['mesh_count']:,} mat={stats['material_count']}")
    if fill_to_mb and size_mb < fill_to_mb * 0.9:
        print(f"  !! 목표 {fill_to_mb} MB 에 미달 ({size_mb:.1f} MB) — 보고 대상")
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="합성 씬 생성")
    ap.add_argument("scene", nargs="?", default="site_minimal", choices=list(SCENES))
    ap.add_argument("--fill-to-mb", type=float, default=None,
                    help="목표 용량(MB). 미달 시 filler 에셋을 격자로 반복 배치")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    spec = SCENES[args.scene]
    if spec.get("skeleton_only") and not args.force:
        print(f"'{args.scene}' 은 스켈레톤 정의만 있는 씬이다. 빌드하려면 --force.")
        return 0

    print(f"== {args.scene}: {spec['description']}")
    if spec.get("omitted"):
        print(f"   제외: {', '.join(spec['omitted'])}")
    result = build_scene(args.scene, fill_to_mb=args.fill_to_mb, force=args.force)
    return 0 if result.get("status") in ("ok", "skipped") else 2


if __name__ == "__main__":
    sys.exit(main())
