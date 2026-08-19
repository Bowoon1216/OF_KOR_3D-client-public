"""sys.path 에서 scripts/ 를 맨 뒤로 보낸다.

`scripts/inspect.py` 가 stdlib `inspect` 를 가리면 trimesh 등 서드파티가 깨진다.
명세가 요구하는 파일명은 유지하되, 표준 라이브러리가 항상 먼저 잡히게 한다.
각 진입 스크립트의 최상단에서 `import _pathfix` 한 줄만 넣으면 된다.
"""
import sys
from pathlib import Path

_HERE = str(Path(__file__).resolve().parent)
while sys.path and sys.path[0] in ("", ".", _HERE):
    sys.path.pop(0)
if _HERE not in sys.path:
    sys.path.append(_HERE)
