"""파이프라인 스크립트 공통 유틸."""
from __future__ import annotations

import datetime
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

RAW_DIR = ROOT / "assets" / "raw"
CONVERTED_DIR = ROOT / "assets" / "converted"
SCENES_DIR = ROOT / "assets" / "scenes"
RESULTS_DIR = ROOT / "results"
MANIFEST_PATH = RESULTS_DIR / "asset_manifest.json"

IFCCONVERT = ROOT / "tools" / "IfcConvert"
GLTF_TRANSFORM = ROOT / "node_modules" / ".bin" / "gltf-transform"

# 파일명 → 별칭 매핑. 원본 IFC 파일명은 BIMobject 다운로드명 그대로 두고
# 여기서만 별칭을 붙인다 (assets/raw/ 는 읽기 전용으로 취급).
#
# 실제 다운로드 파일명이 명세 §1의 제품명과 크게 다르므로 (예: Alimak Scando 650 FC 는
# "S650_single_L=3.9m ...", VMZINC Shingle 은 "VMZINC_SHI RECT-...") 파일명에 실제로
# 등장하는 토큰으로 매칭한다. 위에서부터 첫 매치가 이긴다 — 순서를 바꾸지 말 것.
ALIAS_PATTERNS = [
    ("rooflight", ["kingspan", "ecoplan", "skylight"]),
    ("boomlift", ["haulotte", "h18sxl", "h18"]),
    ("hoist", ["alimak", "scando", "s650"]),
    ("elevator", ["thyssenkrupp", "victoria", "en-27", "tk_elevator"]),
    ("shingle_a", ["590x885"]),
    ("shingle_b", ["420x630"]),
    ("spa", ["spa_building", "spabuilding", "spa-building"]),
]


def alias_for(path: Path) -> str:
    """IFC 파일 경로에서 별칭을 추론한다. 매치 실패 시 stem 을 슬러그화."""
    stem = path.stem.lower()
    for alias, keys in ALIAS_PATTERNS:
        if any(k in stem for k in keys):
            return alias
    return "".join(c if c.isalnum() else "_" for c in stem).strip("_").lower()


def resolve_aliases(paths: list[Path]) -> dict[str, Path]:
    """경로 목록을 별칭 → 경로 로 매핑한다. 충돌은 조용히 넘기지 않고 에러."""
    out: dict[str, Path] = {}
    for p in sorted(paths):
        alias = alias_for(p)
        if alias in out:
            raise ValueError(
                f"별칭 '{alias}' 충돌: {out[alias].name} vs {p.name}. "
                f"ALIAS_PATTERNS 를 수정할 것."
            )
        out[alias] = p
    return out


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text())
    return {}


def save_manifest(manifest: dict) -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


def merge_entry(alias: str, data: dict) -> dict:
    """manifest 의 한 항목을 누적 갱신한다."""
    manifest = load_manifest()
    entry = manifest.get(alias, {})
    entry.update(data)
    manifest[alias] = entry
    save_manifest(manifest)
    return manifest


def run(cmd: list[str], timeout: int = 3600, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(c) for c in cmd],
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(cwd or ROOT),
        env={**os.environ, "PATH": f"{ROOT / 'node_modules' / '.bin'}:{os.environ.get('PATH', '')}"},
    )


def peak_rss_mb(pid_stats: subprocess.CompletedProcess) -> float | None:
    """/usr/bin/time -l 출력에서 maximum resident set size 를 MB 로 뽑는다."""
    for line in (pid_stats.stderr or "").splitlines():
        if "maximum resident set size" in line:
            try:
                return int(line.strip().split()[0]) / (1024 * 1024)
            except (ValueError, IndexError):
                return None
    return None


def fmt_mb(n: int | float) -> str:
    return f"{n / 1_000_000:.2f} MB"
