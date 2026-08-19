"""GLB 컨테이너 저수준 편집.

`gltf-transform` 에는 "루트 노드에 translation 을 먹인다"에 해당하는 CLI 명령이 없다.
합성 씬을 만들려면 병합 *전에* 각 GLB 를 원하는 위치로 옮겨야 하므로,
GLB 의 JSON 청크만 고쳐 쓰는 최소한의 편집기를 둔다. BIN 청크는 손대지 않는다.
"""
from __future__ import annotations

import _pathfix  # noqa: F401

import json
import struct
from pathlib import Path

GLB_MAGIC = b"glTF"
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def read_glb(path: Path) -> tuple[dict, bytes]:
    """GLB 를 (JSON 문서, BIN 청크) 로 분해."""
    data = path.read_bytes()
    magic, version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError(f"{path}: GLB 가 아님")
    if version != 2:
        raise ValueError(f"{path}: glTF {version} 는 지원하지 않음")

    doc: dict | None = None
    binary = b""
    offset = 12
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        payload = data[offset + 8 : offset + 8 + chunk_len]
        if chunk_type == CHUNK_JSON:
            doc = json.loads(payload.decode("utf-8"))
        elif chunk_type == CHUNK_BIN:
            binary = payload
        offset += 8 + chunk_len + (-chunk_len % 4)

    if doc is None:
        raise ValueError(f"{path}: JSON 청크 없음")
    return doc, binary


def write_glb(path: Path, doc: dict, binary: bytes) -> None:
    """(JSON 문서, BIN 청크) 를 GLB 로 직렬화. 청크는 4바이트 정렬 패딩."""
    json_bytes = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)  # JSON 은 공백으로 패딩
    bin_bytes = binary + b"\x00" * (-len(binary) % 4)  # BIN 은 0 으로 패딩

    total = 12 + 8 + len(json_bytes) + (8 + len(bin_bytes) if bin_bytes else 0)
    out = bytearray()
    out += struct.pack("<4sII", GLB_MAGIC, 2, total)
    out += struct.pack("<II", len(json_bytes), CHUNK_JSON) + json_bytes
    if bin_bytes:
        out += struct.pack("<II", len(bin_bytes), CHUNK_BIN) + bin_bytes
    path.write_bytes(bytes(out))


def translate_glb(src: Path, dst: Path, translation: tuple[float, float, float],
                  name: str | None = None, scale: float | None = None) -> None:
    """씬의 모든 루트 노드를 새 부모 노드 아래로 넣고 translation 을 적용한다.

    기존 루트 노드의 transform 을 건드리지 않으므로 원본 지오메트리는 그대로다.
    """
    doc, binary = read_glb(src)
    nodes = doc.setdefault("nodes", [])
    scenes = doc.setdefault("scenes", [{"nodes": []}])
    scene_idx = doc.get("scene", 0)
    scene = scenes[scene_idx]

    wrapper = {"name": name or dst.stem, "children": list(scene.get("nodes", []))}
    if tuple(translation) != (0.0, 0.0, 0.0):
        wrapper["translation"] = [float(v) for v in translation]
    if scale is not None and scale != 1.0:
        wrapper["scale"] = [float(scale)] * 3

    nodes.append(wrapper)
    scene["nodes"] = [len(nodes) - 1]
    write_glb(dst, doc, binary)


def _position_accessors(doc: dict) -> list[int]:
    seen: list[int] = []
    for mesh in doc.get("meshes", []):
        for prim in mesh.get("primitives", []):
            idx = prim.get("attributes", {}).get("POSITION")
            if idx is not None and idx not in seen:
                seen.append(idx)
    return seen


def bake_transform_glb(src: Path, dst: Path, translation: tuple[float, float, float] = (0, 0, 0),
                       scale: float = 1.0, name: str | None = None) -> None:
    """POSITION 데이터를 직접 고쳐 `p = p * scale + translation` 을 적용한다.

    `translate_glb` 처럼 노드 transform 으로 옮기면 accessor 바이트가 원본과 한 글자도
    다르지 않다. `gltf-transform` 의 dedup 이 그 동일성을 보고 복제본을 하나로 접기 때문에,
    같은 에셋을 N 개 쌓은 씬이 압축 후 1개 크기로 줄어든다 (20단 적층 raw 339MB →
    meshopt 2.8MB 로 확인됨). 적층 씬은 단마다 데이터가 실제로 달라야 하므로 좌표를 쓴다.

    가정: POSITION 은 float VEC3, bufferView 는 tightly packed (byteStride 12 또는 미지정).
    IfcConvert 출력은 이 조건을 만족한다. 아니면 예외를 던진다 — 조용히 건너뛰면
    적층이 다시 dedup 으로 접히고 그 사실을 아무도 모른다.
    """
    import numpy as np

    doc, binary = read_glb(src)
    buf = bytearray(binary)
    t = np.asarray(translation, dtype=np.float64)
    touched: list[tuple[int, int]] = []

    for idx in _position_accessors(doc):
        acc = doc["accessors"][idx]
        if acc.get("componentType") != 5126 or acc.get("type") != "VEC3":
            raise ValueError(
                f"{src.name}: accessor {idx} 가 float VEC3 가 아님 "
                f"(componentType={acc.get('componentType')}, type={acc.get('type')})"
            )
        bv = doc["bufferViews"][acc["bufferView"]]
        if bv.get("byteStride") not in (None, 12):
            raise ValueError(f"{src.name}: accessor {idx} bufferView byteStride="
                             f"{bv['byteStride']} — tightly packed 이 아님")
        if bv.get("buffer", 0) != 0:
            raise ValueError(f"{src.name}: GLB 인데 buffer 인덱스가 0 이 아님")

        start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        length = acc["count"] * 12
        span = (start, length)
        if span in touched:
            continue
        for s, ln in touched:
            if start < s + ln and s < start + length:
                raise ValueError(f"{src.name}: POSITION accessor 바이트 구간이 겹친다 "
                                 f"({span} vs {(s, ln)}) — 두 번 변환될 위험")
        touched.append(span)

        arr = np.frombuffer(bytes(buf[start:start + length]), dtype="<f4").reshape(-1, 3)
        out = (arr.astype(np.float64) * scale + t).astype("<f4")
        buf[start:start + length] = out.tobytes()
        acc["min"] = [float(v) for v in out.min(axis=0)]
        acc["max"] = [float(v) for v in out.max(axis=0)]

    # 이름만 남기는 래퍼 노드. 좌표는 이미 데이터에 들어갔으므로 transform 은 넣지 않는다.
    nodes = doc.setdefault("nodes", [])
    scenes = doc.setdefault("scenes", [{"nodes": []}])
    scene = scenes[doc.get("scene", 0)]
    nodes.append({"name": name or dst.stem, "children": list(scene.get("nodes", []))})
    scene["nodes"] = [len(nodes) - 1]

    write_glb(dst, doc, bytes(buf))


def scene_bounds_hint(doc: dict) -> tuple[list[float], list[float]] | None:
    """POSITION accessor 의 min/max 로 대략적인 AABB 를 구한다.

    노드 변환을 반영하지 않으므로 정확한 바운딩 박스가 아니다.
    합성 시 "겹치지만 않으면 된다" 수준의 이격 거리를 정하는 용도.
    """
    accessors = doc.get("accessors", [])
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    found = False
    for mesh in doc.get("meshes", []):
        for prim in mesh.get("primitives", []):
            idx = prim.get("attributes", {}).get("POSITION")
            if idx is None:
                continue
            acc = accessors[idx]
            if "min" not in acc or "max" not in acc:
                continue
            found = True
            for i in range(3):
                lo[i] = min(lo[i], acc["min"][i])
                hi[i] = max(hi[i], acc["max"][i])
    return (lo, hi) if found else None
