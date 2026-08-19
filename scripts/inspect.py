#!/usr/bin/env python
"""GLB 메시 통계 추출 CLI (명세 §4의 scripts/inspect.py).

실제 로직은 glb_stats.py 에 있다. 이 파일명이 stdlib `inspect` 를 가리기 때문에
다른 스크립트는 절대 `import inspect` 하지 않고 `from glb_stats import ...` 를 쓴다.

    python scripts/inspect.py assets/converted/rooflight.glb --validate
"""
import _pathfix  # noqa: F401

import sys

from glb_stats import main

if __name__ == "__main__":
    sys.exit(main())
