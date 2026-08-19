"""GLB 메시 통계 추출.

`gltf-transform inspect --format json` 을 1차 소스로 쓰고, 실패하면 trimesh 로 폴백한다.
has_uv 는 두 경로 모두에서 반드시 판정한다 (없으면 향후 라이트맵 베이킹 불가).
"""
from __future__ import annotations

import _pathfix  # noqa: F401  (stdlib inspect 가 scripts/inspect.py 에 가려지지 않게)

import argparse
import json
import struct
import sys
from pathlib import Path

from common import GLTF_TRANSFORM, run


def _gltf_json(glb: Path) -> dict | None:
    """GLB 컨테이너에서 JSON 청크만 직접 파싱 (외부 도구 불필요)."""
    with open(glb, "rb") as f:
        magic, _version, _length = struct.unpack("<4sII", f.read(12))
        if magic != b"glTF":
            return None
        chunk_len, chunk_type = struct.unpack("<II", f.read(8))
        if chunk_type != 0x4E4F534A:  # 'JSON'
            return None
        return json.loads(f.read(chunk_len).decode("utf-8"))


def inspect_glb(glb: Path) -> dict:
    stats = {
        "glb_size_bytes": glb.stat().st_size,
        "triangle_count": 0,
        "vertex_count": 0,
        "mesh_count": 0,
        "primitive_count": 0,
        "node_count": 0,
        "material_count": 0,
        "texture_count": 0,
        "has_uv": False,
        "instanced_nodes": 0,
        "extensions_used": [],
        "inspect_source": "gltf-json",
    }

    doc = _gltf_json(glb)
    if doc is None:
        return _inspect_trimesh(glb, stats)

    accessors = doc.get("accessors", [])
    meshes = doc.get("meshes", [])
    stats["mesh_count"] = len(meshes)
    stats["node_count"] = len(doc.get("nodes", []))
    stats["material_count"] = len(doc.get("materials", []))
    stats["texture_count"] = len(doc.get("textures", []))
    stats["extensions_used"] = doc.get("extensionsUsed", [])

    # EXT_mesh_gpu_instancing 노드 수
    stats["instanced_nodes"] = sum(
        1 for n in doc.get("nodes", []) if "EXT_mesh_gpu_instancing" in n.get("extensions", {})
    )

    # 각 mesh 가 씬에서 몇 번 참조되는지 (드로우콜 추정용)
    mesh_refs: dict[int, int] = {}
    for n in doc.get("nodes", []):
        if "mesh" in n:
            mesh_refs[n["mesh"]] = mesh_refs.get(n["mesh"], 0) + 1

    tris = verts = prims = 0
    has_uv = False
    for mi, mesh in enumerate(meshes):
        refs = mesh_refs.get(mi, 1)
        for prim in mesh.get("primitives", []):
            prims += refs
            attrs = prim.get("attributes", {})
            if any(k.startswith("TEXCOORD_") for k in attrs):
                has_uv = True
            pos_idx = attrs.get("POSITION")
            n_vert = accessors[pos_idx].get("count", 0) if pos_idx is not None else 0
            verts += n_vert * refs
            mode = prim.get("mode", 4)  # 4 = TRIANGLES
            if "indices" in prim:
                n_idx = accessors[prim["indices"]].get("count", 0)
            else:
                n_idx = n_vert
            if mode == 4:
                tris += (n_idx // 3) * refs
            elif mode in (5, 6):  # TRIANGLE_STRIP / FAN
                tris += max(0, n_idx - 2) * refs

    stats.update(
        triangle_count=tris,
        vertex_count=verts,
        primitive_count=prims,
        has_uv=has_uv,
    )
    return stats


def _inspect_trimesh(glb: Path, stats: dict) -> dict:
    import trimesh

    scene = trimesh.load(str(glb), force="scene")
    tris = verts = 0
    has_uv = False
    for geom in scene.geometry.values():
        tris += len(getattr(geom, "faces", []))
        verts += len(getattr(geom, "vertices", []))
        uv = getattr(getattr(geom, "visual", None), "uv", None)
        if uv is not None and len(uv):
            has_uv = True
    stats.update(
        triangle_count=tris,
        vertex_count=verts,
        mesh_count=len(scene.geometry),
        node_count=len(scene.graph.nodes),
        has_uv=has_uv,
        inspect_source="trimesh",
    )
    return stats


def validate_glb(glb: Path) -> dict:
    """gltf-transform validate 실행 결과 요약."""
    proc = run([GLTF_TRANSFORM, "validate", str(glb)], timeout=900)
    out = (proc.stdout or "") + (proc.stderr or "")
    # 출력은 ERROR/WARNING/INFO/HINT 섹션으로 나뉘고, 비어 있으면
    # "info: No errors found." 같은 문장이 들어간다. 섹션 헤더를 세지 않도록 파싱한다.
    sections = {}
    current = None
    for line in out.splitlines():
        s = line.strip()
        if s in ("ERROR", "WARNING", "INFO", "HINT"):
            current = s.lower()
            sections[current] = []
        elif current and s and not s.startswith("─"):
            sections[current].append(s)
    counts = {
        k: 0 if (len(v) == 1 and v[0].startswith("info: No ")) else len(v)
        for k, v in sections.items()
    }
    return {
        "ok": proc.returncode == 0 and counts.get("error", 0) == 0,
        "counts": counts,
        "issues": {k: v for k, v in sections.items()
                   if v and not v[0].startswith("info: No ")},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="GLB 메시 통계 추출")
    ap.add_argument("glb", nargs="+", type=Path)
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    for p in args.glb:
        stats = inspect_glb(p)
        if args.validate:
            stats["validation"] = validate_glb(p)
        print(f"== {p}")
        print(json.dumps(stats, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
