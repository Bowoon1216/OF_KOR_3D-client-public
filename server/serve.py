"""측정용 정적 파일 서버 (명세 §8).

의존성 없이 표준 라이브러리만 쓴다 (재현성 우선). 측정 하네스 전용이며
운영 서버가 아니다 — 인증도 레이트 리밋도 없다. 공개망에 그대로 띄우지 말 것.

    python server/serve.py --host 0.0.0.0 --port 8000

엔드포인트
    GET  /health              상태 확인
    GET  /assets              제공 가능한 파일 목록 (JSON)
    GET  /assets/{filename}   다운로드
    POST /upload              업로드 (본문 = 파일 바이트, 기본은 폐기)

캐시는 전 응답에서 무력화한다. 측정값에 캐시가 섞이면 데이터 전체가 무의미해진다.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent

NO_CACHE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}

CHUNK = 1 << 20  # 1 MiB


class MeasureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OFKOR3D-measure/1.0"

    # --- 공통 ---------------------------------------------------------------

    def _send(self, code: int, body: bytes = b"", ctype: str = "application/json",
              extra: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in NO_CACHE.items():
            self.send_header(k, v)
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj: dict, extra: dict[str, str] | None = None) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json", extra)

    def _resolve(self, name: str) -> Path | None:
        """serve_dirs 안에서만 파일을 찾는다. 경로 탈출 차단."""
        name = unquote(name).lstrip("/")
        if not name or "\x00" in name:
            return None
        for base in self.server.serve_dirs:  # type: ignore[attr-defined]
            cand = (base / name).resolve()
            try:
                cand.relative_to(base.resolve())
            except ValueError:
                continue  # ../ 탈출 시도
            if cand.is_file():
                return cand
        return None

    def log_message(self, fmt: str, *args) -> None:
        if self.server.verbose:  # type: ignore[attr-defined]
            sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")

    # --- 라우팅 -------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        t0 = time.perf_counter()
        path = urlparse(self.path).path

        if path == "/health":
            self._json(200, {"ok": True, "server_time": time.time(),
                             "hostname": socket.gethostname()})
            return

        if path in ("/assets", "/assets/"):
            files = []
            for base in self.server.serve_dirs:  # type: ignore[attr-defined]
                for p in sorted(base.rglob("*.glb")):
                    files.append({"name": str(p.relative_to(base)),
                                  "size_bytes": p.stat().st_size})
            self._json(200, {"files": files})
            return

        if path.startswith("/assets/"):
            target = self._resolve(path[len("/assets/"):])
            if target is None:
                self._json(404, {"error": "not found", "path": path})
                return
            self._send_file(target, t0)
            return

        self._json(404, {"error": "not found", "path": path})

    do_HEAD = do_GET

    def _send_file(self, target: Path, t0: float) -> None:
        size = target.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "model/gltf-binary")
        self.send_header("Content-Length", str(size))
        for k, v in NO_CACHE.items():
            self.send_header(k, v)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers",
                         "X-Server-Elapsed-Ms, X-Server-Recv-Ms, X-File-Size, X-Server-Time")
        # 헤더 생성까지의 서버 측 처리 시간. 본문 전송 시간은 클라이언트가 잰다.
        self.send_header("X-Server-Elapsed-Ms", f"{(time.perf_counter() - t0) * 1000:.3f}")
        self.send_header("X-File-Size", str(size))
        self.send_header("X-Server-Time", f"{time.time():.6f}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(target, "rb") as f:
            while chunk := f.read(CHUNK):
                self.wfile.write(chunk)

    def do_POST(self) -> None:  # noqa: N802
        t0 = time.perf_counter()
        if urlparse(self.path).path != "/upload":
            self._json(404, {"error": "not found", "path": self.path})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._json(411, {"error": "Content-Length required"})
            return

        digest = hashlib.sha256()
        received = 0
        sink = None
        upload_dir = self.server.upload_dir  # type: ignore[attr-defined]
        if upload_dir:
            upload_dir.mkdir(parents=True, exist_ok=True)
            sink = open(upload_dir / f"upload_{int(time.time() * 1000)}.bin", "wb")
        try:
            while received < length:
                chunk = self.rfile.read(min(CHUNK, length - received))
                if not chunk:
                    break
                received += len(chunk)
                digest.update(chunk)
                if sink:
                    sink.write(chunk)
        finally:
            if sink:
                sink.close()

        elapsed_ms = (time.perf_counter() - t0) * 1000
        self._json(
            200,
            {
                "received_bytes": received,
                "expected_bytes": length,
                "complete": received == length,
                "sha256": digest.hexdigest(),
                "server_recv_ms": round(elapsed_ms, 3),
            },
            extra={
                "X-Server-Recv-Ms": f"{elapsed_ms:.3f}",
                "X-Server-Elapsed-Ms": f"{elapsed_ms:.3f}",
                "Access-Control-Expose-Headers": "X-Server-Elapsed-Ms, X-Server-Recv-Ms",
            },
        )

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"", "text/plain", {
            "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        })


def main() -> int:
    ap = argparse.ArgumentParser(description="측정용 정적 파일 서버")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--dir", action="append", type=Path, default=None,
                    help="서빙 디렉터리 (반복 지정 가능). 기본: assets/scenes, assets/converted")
    ap.add_argument("--upload-dir", type=Path, default=None,
                    help="업로드 본문을 저장할 디렉터리. 미지정 시 폐기(디스크 I/O 배제)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    serve_dirs = args.dir or [ROOT / "assets" / "scenes", ROOT / "assets" / "converted"]
    serve_dirs = [d for d in serve_dirs if d.exists()]
    if not serve_dirs:
        print("서빙할 디렉터리가 없다.", file=sys.stderr)
        return 1

    httpd = ThreadingHTTPServer((args.host, args.port), MeasureHandler)
    httpd.serve_dirs = serve_dirs           # type: ignore[attr-defined]
    httpd.upload_dir = args.upload_dir      # type: ignore[attr-defined]
    httpd.verbose = args.verbose            # type: ignore[attr-defined]
    httpd.daemon_threads = True

    print(f"serving on http://{args.host}:{args.port}")
    for d in serve_dirs:
        print(f"  {d.relative_to(ROOT) if d.is_relative_to(ROOT) else d}")
    print(f"  upload → {args.upload_dir or '(폐기)'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
