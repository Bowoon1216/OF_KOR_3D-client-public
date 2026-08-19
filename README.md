# OF_KOR_3D

KOREN 인프라 기반 AI 제스처 3D 원격 협업 플랫폼 — 넷 챌린지 캠프 시즌13

프론트엔드(Vite + React + TS)와 **에셋 파이프라인**(IFC → glTF 변환 및 전송 성능 측정)을 함께 둔다.
이 문서는 에셋 파이프라인 쪽을 다룬다. 상세 진행 상황은 [`results/phase1_progress.md`](results/phase1_progress.md).

## 디렉터리

```
assets/
  raw/          원본 IFC — 읽기 전용. 절대 수정·덮어쓰기 금지
  converted/    변환 결과 GLB 및 압축 변형본
  scenes/       합성 씬
scripts/
  convert.py    IFC → GLB (direct → dae → obj 순으로 폴백)
  optimize.py   압축 변형본 생성 / 인스턴싱 전후 비교
  inspect.py    GLB 통계 CLI (로직은 glb_stats.py)
  compose.py    합성 씬 생성 (적층 씬 포함)
  publish.py    다운로드 측정 대상을 서버에 올리고 대상 목록 생성
  measure.py    전송 시간 측정 하네스 (동시성·TTFB·스로틀 감시)
  report.py     측정 결과 집계 → summary_*.md (표 1·2·3)
  check_schema.py  transfer_*.json 스키마 검사 (CLI·브라우저 동일성)
  ofk_api.py    백엔드 최소 클라이언트 (로그인·업로드·ENA 카운터)
  glb_stats.py  GLB 통계 추출
  glb_edit.py   GLB 저수준 편집 (노드 translation, 좌표 굽기)
  common.py     공통 유틸 · 파일명→별칭 매핑
results/
  asset_manifest.json      에셋별 변환·압축 통계
  scene_manifest.json      합성 씬 통계
  environment.json         도구 버전 기록
  download_targets_*.json  다운로드 측정 대상 URL (publish.py 산출물)
  transfer_*.json          전송 측정 원시 데이터 + 세션 메타데이터
  summary_*.md             집계표 (표 1 다운로드 · 표 2 업로드 · 표 3 압축 효과)
  baseline_*.csv           (구) Phase 1 측정 원시 데이터
  session_*.json           (구) Phase 1 세션 메타데이터
server/
  serve.py      측정용 정적 파일 서버
tools/
  IfcConvert    IfcOpenShell 바이너리 (git 미포함)
```

## 셋업

```bash
python3 -m venv .venv
.venv/bin/pip install ifcopenshell trimesh numpy pandas

npm install @gltf-transform/cli          # node_modules/.bin/gltf-transform
brew install assimp                       # macOS (Ubuntu: apt-get install assimp-utils)

# IfcConvert — Homebrew/pip 에 없다. IfcOpenShell 공식 빌드에서 받는다.
mkdir -p tools && cd tools
curl -LO https://s3.amazonaws.com/ifcopenshell-builds/IfcConvert-v0.8.6-e333c1c-macos64.zip
unzip -o IfcConvert-v0.8.6-e333c1c-macos64.zip && chmod +x IfcConvert
xattr -d com.apple.quarantine IfcConvert   # macOS Gatekeeper
```

플랫폼이 다르면 같은 버킷에서 `linux64` / `win64` / `macosm164` 빌드를 받는다.
버전이 바뀌면 [`results/environment.json`](results/environment.json)을 갱신할 것.

## 사용

```bash
# 1. 변환 (assets/raw 전체)
.venv/bin/python scripts/convert.py --validate

# 2. 압축 변형본 (raw / draco / meshopt / full)
.venv/bin/python scripts/optimize.py

# 3. 인스턴싱 전후 비교
.venv/bin/python scripts/optimize.py --instance hoist boomlift

# 4. 합성 씬
.venv/bin/python scripts/compose.py site_minimal --fill-to-mb 50
.venv/bin/python scripts/compose.py site_stacked          # hoist 20단 적층 (전송 측정용)
.venv/bin/python scripts/optimize.py site_stacked --scenes
```

### 전송 성능 측정

`ASSET_TRANSFER_TEST_PLAN.md` 의 절차다. **실제 백엔드를 상대로 측정한다** —
`server/serve.py` 로 재고 9월에 백엔드로 재면 두 변수가 동시에 바뀐다.

```bash
# 1. 다운로드 대상을 서버에 올리고 대상 목록을 만든다 (1회)
OFK_PASSWORD=… .venv/bin/python scripts/publish.py \
    --target https://<host> --label commercial --email <이메일>

# 2. 측정 — 타겟은 반드시 파라미터. 9월에 같은 스크립트로 KOREN 을 연속 측정한다
.venv/bin/python scripts/measure.py --target https://<host> --label commercial \
    --location home --network-type wifi
.venv/bin/python scripts/measure.py --target https://<koren-host> --label koren \
    --location campus --network-type wired

# 3. 집계 — 여러 경로를 함께 주면 loopback 대비 비율까지 낸다
.venv/bin/python scripts/report.py results/transfer_*_loopback.json \
    results/transfer_*_commercial.json

# 4. 스키마 검사 (브라우저 하네스 결과도 같은 명령으로)
.venv/bin/python scripts/check_schema.py results/transfer_*.json
```

브라우저 하네스(보조)는 `src/measure/transferHarness.ts` 다. 개발자 콘솔에서
`window.ofkTransferHarness.run({…})` → `.save(결과)` 로 CLI 와 같은 스키마의 JSON 을
내려받는다. 집계에 쓰는 권위 데이터는 CLI 결과다.

## 별칭 매핑

BIMobject 다운로드 파일명이 제품명과 크게 달라 `scripts/common.py`의
`ALIAS_PATTERNS`에서 파일명 토큰으로 별칭을 붙인다. IFC 원본 파일명은 바꾸지 않는다.

| 별칭 | 제품 | 매칭 토큰 |
|---|---|---|
| `rooflight` | Kingspan Ecoplan ISO plus | kingspan / ecoplan / skylight |
| `boomlift` | Haulotte H18 SXL | haulotte / h18sxl |
| `hoist` | Alimak Scando 650 FC | alimak / scando / s650 |
| `elevator` | TK Elevator Victoria EN-27 | thyssenkrupp / victoria |
| `shingle_a` / `shingle_b` | VMZINC Rectangular Shingle | 590x885 / 420x630 |
| `spa` | Spa Building (ArchiCAD) | — 원본 미확보 |

새 IFC 를 추가하면 `ALIAS_PATTERNS`에 토큰을 넣는다. 매칭 실패 시 파일명 슬러그가
별칭이 되고, 충돌하면 에러로 멈춘다 (조용히 덮어쓰지 않는다).

## 측정 시 지켜야 할 것

- 타겟 주소를 하드코딩하지 않는다. 9월에 AWS·KOREN 두 타겟을 같은 스크립트로 연속 실행한다.
- 씬을 다시 만들지 않는다. `assets/scenes/site_stacked_*.glb` 를 9월까지 그대로 쓴다.
  (적층 씬은 좌표를 데이터에 굽는다 — 노드 transform 으로 옮기면 dedup 이 20단을 1단으로 접는다.)
- 조건마다 워밍업 1라운드를 버린다. 매 요청 URL 에 `?t={timestamp_ns}`.
- 평균만 남기지 않는다. 표본 수에 따라 낼 수 있는 백분위만 낸다 —
  `n<30` → p50, `30≤n<100` → p50·p95, `n≥100` → p50·p95·p99. n=10 에서 p99 는 최댓값일 뿐이다.
- 스로틀된 라운드를 집계에 넣지 않는다. `GET /api/metrics/net-allowance` 로 라운드 전후
  ENA 카운터를 비교하고, 증가한 라운드는 제외하되 **제외 개수를 리포트에 적는다**.
- 다운로드 완료 시간의 표준편차를 "지터"라고 부르지 않는다. 그건 처리량 변동성(CV)이고,
  지터는 RTT 연속 샘플 간 변화량으로 동기화 측정에서만 쓰는 별개 지표다.
- 업로드 응답 시간에서 변환 시간을 분리한다. 서버가 일한 시간은 `store + db` 이고
  `recv` 는 본문 수신 시간(=네트워크)이라 추가로 빼면 네트워크를 이중 차감한다.
- 측정 위치·회선 종류·시간대를 반드시 기록한다. 섞으면 데이터가 무의미해진다.
- speedtest / 서버 ping / traceroute / **공유기 ping** 을 세션마다 돌린다. 공유기까지의
  `mdev` 가 곧 Wi-Fi 구간 노이즈 바닥값이고, 이 값이 없으면 리포트에서 한계를 밝힐 수 없다.

## 프론트엔드 ↔ 백엔드 연동

백엔드 API 는 별도 저장소(FastAPI, 기본 `http://localhost:8000`)이며 명세서는 `API명세서.md` 다.

```bash
cp .env.example .env.local     # VITE_API_BASE_URL 을 백엔드 주소로
npm run dev                    # http://localhost:3000 (백엔드 CORS 허용 origin)
```

주소는 헤더의 **Settings** 에서 실행 중에도 바꿀 수 있다 (localStorage 오버라이드가 `.env` 보다
우선한다). 여러 노트북으로 다자간 데모를 할 때 각 기기에서 서버 IP 만 바꿔 넣으면 된다.

```
src/config/env.ts        서버 주소 한 곳 관리 (API / WS / 정적 에셋)
src/config/measurement.ts 측정 세션 설정 — run id, 위치, 캐시 무력화, 워밍업 제외
src/api/                 REST 클라이언트 (fetch) + TanStack Query 훅
  http.ts                단일 통로. 토큰 주입, error 형식 통일, 401 시 토큰 폐기
  assetDownload.ts       에셋 다운로드 — fetch + getReader 스트리밍 + Performance API 분해
  assets.ts              IFC 업로드 — XHR (fetch 는 업로드 진행률을 주지 않음) + 변환 잡 폴링
src/realtime/            WebSocket — welcome / 30Hz 병합 송신 / 시계 동기화 / telemetryReport
src/three/assetLoader.ts 다운로드 → parse → compile 구간 측정 (draco·meshopt·KTX2 지원)
src/measure/transferHarness.ts  브라우저 전송 측정 (보조). CLI 와 같은 JSON 스키마로 출력
```

### 사용자 업로드는 IFC 만 받는다

건축가는 Revit·ArchiCAD 를 쓰므로 사용자가 올리는 것은 **`.ifc` / `.ifczip`** 이고,
GLB 변환은 서버가 한다 (`POST /api/assets/ifc`). `.glb` 를 올리면 서버가 415 를 낸다.

응답은 **202 Accepted** 이고 그 시점에는 변환이 시작도 안 했다. 본문은 에셋이 아니라
변환 잡(`j_…`)이라 이 응답으로 뷰어를 열 수 없다. `waitForIfcJob` 이 `status === 'ready'`
까지 폴링한 뒤 완성된 에셋을 돌려주므로, 방 붙이기·목록 갱신 쪽 코드는 바뀌지 않는다.

주의할 제약 두 가지:

- 사용자당 동시 변환 **2건**. 세 번째 요청은 429 `CONVERSION_BUSY` 다
- 32.9MB IFC 의 변환이 약 **196초**. 전송 진행률과 변환 진행률을 따로 표시해야 한다
  (전송 100% 에서 멈춘 화면은 사용자에게 실패로 읽힌다)

용도별 선택 근거:

| 용도 | 선택 | 이유 |
|---|---|---|
| 에셋 다운로드 | `fetch` + `getReader()` | 진행률을 스트리밍으로 받는다. axios 는 응답 전체를 버퍼링해 수백 MB GLB 에서 못 쓴다 |
| 에셋 업로드 | XHR + 잡 폴링 | `fetch` 는 업로드 진행률을 주지 않는다. IFC 변환은 비동기라 202 뒤에 폴링한다 |
| 일반 REST | `fetch` + TanStack Query | 캐싱·재시도·로딩 상태 |
| 실시간 동기화 | WebSocket | 절대 transform 30Hz 병합 송신 |
| 성능 측정 | Performance API | DNS / TCP / TTFB / 전송을 분리해야 "느린 게 네트워크인지 서버인지" 를 가린다 |

**Phase 1 전송 시간 베이스라인은 프론트엔드로 재지 않는다.** 브라우저는 캐시·커넥션 재사용·동시
요청 제한 때문에 변수가 많다. 그 숫자는 `scripts/measure.py` 가 만들고, 프론트엔드는 브라우저에서만
알 수 있는 "입장 ~ 렌더링 완료"(`joinToRenderMs`)만 `POST /api/metrics/asset-load` 로 보고한다.
이때도 같은 규율을 따른다 — 캐시 무력화(`?t=`), 워밍업 1회 제외, 측정 위치·회선 종류 기록.
