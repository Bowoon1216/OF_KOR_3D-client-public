# Phase 1 자산 파이프라인 — 진행 보고

작성: 2026-08-09 · 대상 문서: `PHASE1_asset_pipeline_spec.md`

## 상태 요약

| Phase | 내용 | 상태 |
|---|---|---|
| 0 | 환경 구축 | ✅ 완료 |
| 1 | 변환 파이프라인 관통 → 전 에셋 확장 | ✅ 완료 (6/6, spa 제외) |
| 2 | 압축 변형본 생성 | ✅ 완료 |
| 3 | 복잡 모델 검증 (`boomlift`, `hoist`) | ✅ 완료 — **인스턴싱 효과 없음, 아래 참조** |
| 4 | 합성 씬 구성 | ✅ 완료 (51.75 MB) |
| 5 | 측정 하네스 | 🟡 **코드만 완료** — 실측 세션은 서버 구축 후 |

`spa` (Spa Building / ArchiCAD) 는 원본 IFC 미확보로 전 단계에서 제외했다 (사용자 확인).

---

## Phase 0 — 환경 구축

명세는 Ubuntu 기준이나 실제 환경은 **macOS 15 (Darwin 24.6.0) / x86_64 (Intel i9-9980HK)**.
`apt-get` 대신 Homebrew를 사용했고, 대체 라이브러리 도입은 없다.

| 도구 | 버전 | 설치 경로 |
|---|---|---|
| Python | 3.14.0 | `.venv/` (프로젝트 로컬 venv) |
| ifcopenshell | 0.8.5 | pip (`py314-macosx_10_15_x86_64` 휠 존재) |
| trimesh | 5.0.0 | pip |
| numpy / pandas | 2.5.1 / 3.0.5 | pip |
| Node / npm | v22.20.0 / 10.9.3 | 기존 |
| @gltf-transform/cli | 4.4.2 | `node_modules/.bin/` (전역 `-g` 대신 로컬) |
| IfcConvert | 0.8.6-e333c1c (OCC 7.8.1) | `tools/IfcConvert` |
| assimp | 6.0.5 | Homebrew |

전체 기록: [`results/environment.json`](environment.json)

### 명세와 달라진 점

1. **IfcConvert 조달 경로**: Homebrew/pip에 포뮬러·패키지가 없어 IfcOpenShell 공식 S3
   빌드 저장소(`s3://ifcopenshell-builds`)에서 macOS x86_64 최신 빌드
   `IfcConvert-v0.8.6-e333c1c-macos64.zip` (2026-07-18)을 받아 `tools/`에 배치했다.
   `tools/`는 `.gitignore` 대상 — 재현 절차는 README에 있다.
2. **지원 출력 포맷 확인**: 명세의 경고대로 `--help`로 검증한 결과 0.8.6은
   `.glb`를 **네이티브로 지원**한다 (`obj / dae / glb / stp / igs / xml / json / rdb / svg / h5 / ttl / ifc`).
   따라서 dae·obj 경유 없이 direct 경로가 가능하다.
3. **가상환경 사용**: 시스템 Python 오염을 피하려 `.venv/`를 만들었다.

---

## Phase 1 — 변환

**전 에셋이 1순위 `direct` 경로로 성공.** dae·obj 폴백은 한 번도 필요하지 않았다
(코드에는 남아 있어 실패 시 자동 시도).

```
tools/IfcConvert -y --no-progress <input>.ifc assets/converted/{별칭}.glb
```

원본 IFC는 읽기만 했고 수정하지 않았다.

| 별칭 | IFC | GLB | 변환 s | 피크 RSS | 삼각형 | 정점 | mesh | **prim** | node | mat | tex | **has_uv** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `rooflight` | 4.93 MB | 2.65 MB | 18.6 | 807 MB | 39,268 | 90,500 | 2 | 5 | 2 | 4 | 0 | **false** |
| `boomlift` | 19.90 MB | 10.97 MB | 97.6 | — | 156,218 | 377,494 | 1 | 46 | 1 | 6 | 0 | **false** |
| `hoist` | 32.90 MB | 16.98 MB | 196.0 | — | 278,998 | 711,348 | 3 | 106 | 12 | 16 | 0 | **false** |
| `elevator` | 1.94 MB | 1.01 MB | 7.2 | — | 10,838 | 32,514 | 1 | 100 | 1 | 100 | 0 | **false** |
| `shingle_a` | 2.48 MB | 4.61 MB | 18.2 | — | 94,180 | 143,772 | 28 | 28 | 28 | 15 | 0 | **false** |
| `shingle_b` | 2.45 MB | 4.60 MB | 15.8 | — | 93,812 | 143,568 | 28 | 28 | 28 | 15 | 0 | **false** |

- 전부 `gltf-transform validate` **ERROR 0 / WARNING 0**.
- 삼각형 수가 전부 임계값 1,000을 크게 상회 — 지오메트리 유실 정황 없음.
- 타임아웃·OOM 없음. 최대는 `hoist` 196초.
- `shingle_a/b`는 GLB가 IFC보다 크다(2.5 MB → 4.6 MB). IFC는 파라메트릭 정의를
  텍스트로 담지만 GLB는 삼각형화된 정점 데이터를 담기 때문으로, 정상이다.

### ⚠️ 보고 대상 — UV 전무

**6개 에셋 전부 `has_uv = false`, `texture_count = 0`이다.** 예외 없다.

명세대로 이번 단계에서 고치지 않고 기록만 한다. 다만 **현 상태로는 GI 라이트맵 베이킹이
전 에셋에서 불가능**하다. IfcConvert에 `--generate-uvs` 옵션(박스 프로젝션)이 있으나,
라이트맵용 언랩은 겹침 없는 UV 아일랜드가 필요해 박스 프로젝션으로는 부족하다.
라이트맵 단계 진입 전에 별도 언랩 파이프라인(xatlas 등) 도입 여부를 결정해야 한다.

`texture_count = 0`의 부수 효과로 **Phase 2의 KTX2 압축이 전 에셋에서 무의미**해졌다 (아래).

### 드로우콜 지표는 `node_count`가 아니라 `primitive_count`

IfcConvert의 glTF 시리얼라이저는 계층을 크게 접는다 — `boomlift`는 156K 삼각형인데
`node_count = 1`이다. 드로우콜은 노드가 아니라 **프리미티브 단위**로 발생하므로
`primitive_count`를 함께 기록하도록 `inspect` 로직을 확장했다.
`elevator`는 노드 1개지만 재질 100종 × 프리미티브 100개로, 크기 대비 드로우콜 부하가 가장 높다.

---

## Phase 2 — 압축 변형본

| 에셋 | raw | draco | meshopt | full | draco 절감 | meshopt 절감 |
|---|---:|---:|---:|---:|---:|---:|
| `rooflight` | 2.65 MB | 0.12 MB | 0.40 MB | 0.40 MB | 95.3 % | 85.0 % |
| `boomlift` | 10.97 MB | 0.49 MB | 1.69 MB | 1.69 MB | 95.5 % | 84.6 % |
| `hoist` | 16.98 MB | 0.68 MB | 2.66 MB | 2.66 MB | 96.0 % | 84.3 % |
| `elevator` | 1.01 MB | 0.13 MB | 0.24 MB | 0.24 MB | 86.9 % | 76.4 % |
| `shingle_a` | 4.61 MB | 0.27 MB | 0.67 MB | 0.67 MB | 94.0 % | 85.4 % |
| `shingle_b` | 4.60 MB | 0.27 MB | 0.68 MB | 0.68 MB | 94.1 % | 85.3 % |
| **`site_minimal`** | **51.75 MB** | **2.29 MB** | **4.76 MB** | **4.76 MB** | **95.6 %** | **90.8 %** |

- 압축 후 크기가 커진 케이스 **없음**.
- 전 변형본에서 `triangle_count` 불변 — 압축 과정의 지오메트리 손실 없음.
- 처리 시간은 에셋당 1초 내외 (`site_minimal`도 수 초).

### ⚠️ 보고 대상 — `full` == `meshopt`

`texture_count == 0`이라 KTX2(uastc) 단계를 전 에셋에서 건너뛰었고,
결과적으로 **`full` 변형본이 `meshopt`와 바이트 단위로 동일**하다.
manifest에 `skipped_steps: ["uastc (texture_count == 0)"]`로 기록했다.

→ **측정 매트릭스의 `full` 조건은 현재 `meshopt`와 완전 중복이다.**
텍스처 있는 에셋이 들어오기 전까지 측정 시간을 25 % 절약하려면 `full`을 빼도 된다.
다만 9월 비교에서 조건을 맞추려면 그대로 두는 편이 안전하다 — 판단 필요.

---

## Phase 3 — 복잡 모델 검증

### 변환 부하

`boomlift`(19.9 MB, 156K tri)와 `hoist`(32.9 MB, 279K tri) 모두 **타임아웃·OOM 없이 완료**.
`hoist` 196초가 최대이며, 피크 메모리도 문제 없는 수준이었다.

### ⚠️ 보고 대상 — 인스턴싱 효과가 사실상 없다

`gltf-transform instance` 전후 비교:

| 에셋 | 크기 전 → 후 | 절감 | node 전 → 후 | prim 전 → 후 | `EXT_mesh_gpu_instancing` 노드 |
|---|---|---:|---|---|---:|
| `hoist` | 16.98 → 16.96 MB | 0.11 % | 12 → 3 | 106 → 79 | **1** |
| `boomlift` | 10.97 → 10.96 MB | 0.10 % | 1 → 1 | 46 → 46 | 0 |
| `elevator` | 1.01 → 0.98 MB | 2.35 % | 1 → 1 | 100 → 100 | 0 |
| `shingle_a` | 4.61 → 4.60 MB | 0.14 % | 28 → 28 | 28 → 28 | 0 |
| `shingle_b` | 4.60 → 4.59 MB | 0.14 % | 28 → 28 | 28 → 28 | 0 |
| `rooflight` | 2.65 → 2.65 MB | 0.04 % | 2 → 2 | 5 → 5 | 0 |

**명세의 예상("`hoist`에서 인스턴싱 효과가 가장 크게 나타날 것")과 다르다.**
`hoist`가 그나마 유일하게 효과가 있었지만 노드 12→3, 프리미티브 106→79,
용량 절감 0.11 %에 그쳤다. 시연용 "최적화 효과 그래프"로 쓸 수 있는 수치가 아니다.

원인은 두 가지다.

1. **다운로드한 `hoist` 모델이 마스트 반복 구조가 아니다.**
   파일명이 `S650_single_L=3.9m 1500mm raised enclosure.ifc`로, Alimak Scando 650의
   **단일 섹션(L=3.9 m)** 이다. 실제 바운딩 박스도 8.87 m 로 마스트 타워가 아니다.
   명세가 기대한 "마스트 섹션 동일 형상 반복"이 모델 안에 존재하지 않는다.
2. **IfcConvert가 지오메트리를 월드 좌표로 굽는다.** 공유 메시 참조 자체가 사라진다.
   이를 확인하려고 `--permissive-shape-reuse`("increase reuse of geometries") 옵션으로
   `boomlift`·`hoist`를 재변환해 비교했으나 **결과 구조가 완전히 동일**했다
   (`boomlift_reuse`, `hoist_reuse` 키로 manifest에 기록).
   즉 옵션 문제가 아니라 소스 지오메트리에 재사용 가능한 반복이 없다.

**판단이 필요한 지점**: 인스턴싱 최적화 효과를 시연 자료로 쓰려면
(a) 마스트가 여러 섹션 적층된 Alimak 모델을 다시 받거나,
(b) `compose.py`가 만드는 합성 씬 수준에서 동일 에셋 반복 배치에 인스턴싱을 적용하는
방향으로 전환해야 한다. 현재 `site_minimal`은 `rooflight` 9개를 복제 배치하므로 (b)의
소재는 이미 있다. 임의 판단하지 않고 여기서 멈춘다.

---

## Phase 4 — 합성 씬

### `assets/scenes/site_minimal.glb` — **51.75 MB** (목표 50 MB 충족)

| 항목 | 값 |
|---|---|
| 크기 | 51,746,668 B (51.75 MB) |
| 삼각형 / 정점 | 788,628 / 1,903,342 |
| mesh / primitive / node | 22 / 197 / 42 |
| material / texture | 58 / 0 |
| 합성 시간 | 1.6 s |
| validate | ERROR 0 / WARNING 0 |

구성:

| 구성 요소 | 배치 | 크기 |
|---|---|---:|
| `boomlift` | 원점 | 10.97 MB |
| `hoist` | x + 15 m | 16.98 MB |
| `rooflight` × 9 | z + 15 m, 3×3 격자 (간격 8 m) | 23.8 MB |

### 명세와 달라진 점

명세의 `site_minimal`은 `spa`(본체) + `boomlift`(15 m 이격)이다.
**`spa` 원본 IFC가 확보되지 않아** 씬의 뼈대가 빠졌고, 그만큼의 용량을
`hoist` 배치와 `rooflight` 반복(명세 §7 "미달하면 인스턴싱 개수를 늘려 채운다")으로 채웠다.
정의는 `scripts/compose.py`의 `SCENES` 딕셔너리에 있고, `omitted` 필드에 제외 사유를 남겼다.

`site_full`은 명세대로 정의만 두고 빌드하지 않았다 (`skeleton_only: True`).

### 구현 메모 — 좌표 배치

`gltf-transform merge`에는 좌표 오프셋 기능이 없다. 명세가 지시한 대로 **병합 전에 각 GLB의
루트 노드에 translation을 적용**해야 하는데 이에 해당하는 CLI 명령이 없어,
GLB의 JSON 청크만 고쳐 쓰는 최소 편집기(`scripts/glb_edit.py`)를 만들었다.
기존 루트 노드들을 새 부모 노드 아래로 넣고 거기에 translation을 준다 — 원본 지오메트리는 손대지 않는다.
좌표 단위는 POSITION accessor의 min/max로 m/mm를 자동 판별한다 (전 에셋 모두 m 단위였다).
`merge`는 `--merge-scenes`를 붙여야 한 씬으로 합쳐진다 (기본은 입력별 씬 분리 → 첫 씬만 렌더링됨).

---

## Phase 5 — 측정 하네스 (코드만)

서버 미구축 상태라 **코드 작성과 로컬 루프백 검증까지만** 수행했다 (사용자 지시).
실제 상용망 측정 세션은 수행하지 않았으므로 `results/`에 baseline CSV가 없다.

### `server/serve.py`

표준 라이브러리만 사용 (`ThreadingHTTPServer`). 외부 의존성 없음.

| 엔드포인트 | 동작 |
|---|---|
| `GET /health` | 상태 확인 |
| `GET /assets` | 제공 가능한 GLB 목록 (JSON) |
| `GET /assets/{filename}` | 다운로드 |
| `POST /upload` | 업로드 (본문 = 파일 바이트, 기본은 폐기) |

- 전 응답에 `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` + `Pragma` + `Expires: 0`
- `X-Server-Elapsed-Ms` / `X-Server-Recv-Ms` 헤더로 서버 측 처리 시간 노출 (CORS expose 포함)
- 서빙 디렉터리 밖 경로 접근 차단 (`relative_to` 검증)

> 측정 전용이다. 인증·레이트리밋이 없으므로 공개망에 그대로 띄우지 말 것.

### `scripts/measure.py`

명세 §8의 4가지 필수 항목을 전부 구현했다.

1. 조건당 기본 10회 (`--runs`). 10 미만이면 경고를 출력한다.
2. p50 / p95 / min / max / stddev / 평균 / CV% 를 모두 집계표에 기록.
3. 매 요청 URL에 `?t={time.time_ns()}` — 다운로드·업로드 양쪽 모두.
   요청 헤더에도 `Cache-Control: no-cache, no-store`, `Accept-Encoding: identity`
   (전송 바이트를 파일 크기와 일치시켜 처리량 계산을 왜곡하지 않기 위함).
4. 워밍업 1회는 `run_index = 0`으로 CSV에 남기되 집계에서 제외.

병목 구분용으로 세션마다 `speedtest-cli --json` / `ping -c 20` / `traceroute` /
`iperf3 -J`(옵션)를 함께 실행해 `results/session_*.json`에 저장한다.
도구가 없으면 그 사실을 `available: false`로 기록한다 (조용히 넘어가지 않는다).

출력:
- `results/baseline_YYYYMMDD_HHMM.csv` — 명세 §8의 13개 컬럼 + `server_elapsed_ms` / `ok` / `error`
- `results/session_YYYYMMDD_HHMM.json` — 세션 메타데이터 + 진단 결과
- `results/summary_YYYYMMDD.md` — p50/p95 포함 집계표 (같은 날 세션을 누적 append)

**stddev가 평균의 50 %를 넘으면** 해당 행에 ⚠️ 를 붙이고 종료 시 "보고 대상"으로 출력한다.

### 로컬 루프백 검증 결과

`site_minimal`의 draco·meshopt 변형본으로 다운로드·업로드 3회씩 돌려 전 경로가 동작함을 확인했다.
워밍업 효과가 명확히 관측됐다 — draco 다운로드 **워밍업 37.9 ms → 이후 2.1~2.7 ms**.
명세가 "첫 요청은 연결 수립 비용이 섞인다"고 경고한 그대로다.
검증용 CSV·summary는 실측 데이터와 섞이지 않도록 삭제했다.

### 실측 세션에 필요한 것 (서버 구축 후)

- [ ] 서버 호스트 확보 및 `server/serve.py` 기동 (+ `iperf3 -s`)
- [ ] `pip install speedtest-cli`, `brew install iperf3` (현재 미설치 — 진단이 빈 값으로 남는다)
- [ ] 최소 2개 위치(campus / home 등) × 조건당 10회
- [ ] **모든 세션의 시간대를 고정할 것.** `local_hour`를 세션 메타에 기록하고 있으나,
      시간대가 다르면 비교 자체가 성립하지 않는다.

---

## 완료 기준 대조 (명세 §10)

| 기준 | 상태 |
|---|---|
| 7개 에셋 전부 GLB 변환 | 🟡 6/6 완료. `spa`는 원본 미확보로 제외 (사용자 확인) |
| `asset_manifest.json`에 전 에셋 통계 | ✅ |
| 각 에셋 4가지 압축 변형본 및 크기 비교표 | ✅ (`full`은 텍스처 부재로 `meshopt`와 동일) |
| `hoist` 인스턴싱 전후 노드 수·용량 비교 | ✅ 수치 확보. 단 **효과가 거의 없음** — 위 참조 |
| `site_minimal.glb` 50 MB 이상 | ✅ 51.75 MB |
| 최소 2개 위치 × 10회 반복 측정 | ⏸ 서버 구축 후 |
| `summary_*.md` p50/p95 집계표 | 🟡 코드 완료, 실측 대기 |
| 각 에셋 `has_uv` 목록 | ✅ **전 에셋 false** |

---

## 산출물

```
assets/converted/{alias}.glb                     변환 결과 (6종)
assets/converted/{alias}_{raw,draco,meshopt,full}.glb   압축 변형본
assets/converted/{alias}_instanced.glb           인스턴싱 비교본
assets/converted/{boomlift,hoist}_reuse.glb      --permissive-shape-reuse 비교본
assets/scenes/site_minimal{,_raw,_draco,_meshopt,_full}.glb
results/asset_manifest.json                      에셋 통계 (변환·압축·인스턴싱)
results/scene_manifest.json                      합성 씬 통계
results/environment.json                         도구 버전
scripts/{convert,optimize,inspect,compose,measure}.py
scripts/{common,glb_stats,glb_edit,_pathfix}.py
server/serve.py
tools/IfcConvert
```

### 구현 메모 — `scripts/inspect.py` 이름 충돌

명세가 요구하는 `scripts/inspect.py`는 Python 표준 라이브러리 `inspect`를 가린다.
`scripts/`가 `sys.path[0]`에 오므로 trimesh 등이 `import inspect`를 하면 우리 파일이 잡혀 깨진다.
실제 로직은 `glb_stats.py`에 두고 `inspect.py`는 얇은 CLI 래퍼로만 남겼으며,
각 스크립트가 `import _pathfix`로 `sys.path`에서 `scripts/`를 맨 뒤로 밀어 표준 라이브러리를 우선시킨다.

GLB 통계는 외부 도구 없이 **GLB 컨테이너의 JSON 청크를 직접 파싱**해 뽑는다
(`gltf-transform inspect`는 사람이 읽는 표 형식이라 파싱이 불안정하다).
Draco/meshopt 압축본도 accessor 메타데이터는 평문이라 동일하게 동작한다.
노드가 같은 메시를 여러 번 참조하면 삼각형 수를 참조 횟수만큼 합산한다.
