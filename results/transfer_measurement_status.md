# 에셋 전송 성능 측정 — 준비 상태

`ASSET_TRANSFER_TEST_PLAN.md` 기준. 2026-08-12 시점.

측정 도구는 완성되어 검증까지 끝났고, **실제 측정은 인증 자격증명이 없어 시작하지 못했다.**

---

## 1. 측정 대상 파일 (§2.1) — 확정, 동결

`compose.py` 로 hoist 20단 적층 씬을 만들고 압축 변형본을 생성했다.

| 변형 | 계획 예상 | 실측 | 차이 |
|---|---:|---:|---:|
| `site_stacked_raw.glb` | ~370MB | **339.23MB** | -8.3% |
| `site_stacked_meshopt.glb` | ~35MB | **36.64MB** | +4.7% |
| `site_stacked_draco.glb` | ~17MB | **13.60MB** | -20.0% |

씬 제원: 20단 · z축 간격 8.874m · 전체 높이 182.5m · 삼각형 5,579,960 · 정점 14,226,960 ·
노드 260 · 메시 60 · 텍스처 0 · glTF 검증 오류 0.

**§4-2 에 따라 9월까지 이 파일을 그대로 쓴다. 재생성 금지.** 동일 파일임을 증명하는 해시:

```
81157c4c507b1905de3dfaab33e7b6336414fd73b45f0710f7876193c85ce5be  site_stacked_raw.glb
b24152cb4c1b57718bac062f9e0f4af8822a526ae4f49fef371dd576d0b0cd04  site_stacked_meshopt.glb
bad876fa1f8c7e3ac2ba5924cf64936e8fd33e7a69535689b763ebdd42b717ad  site_stacked_draco.glb
```

### 적층 씬은 좌표를 데이터에 구워야 한다 (해결된 함정)

처음 만든 적층 씬의 meshopt 변형본이 **2.84MB** 로 나왔다. 계획 예상의 1/12 이다.

원인은 dedup 이었다. `translate_glb` 는 래퍼 노드에 translation 을 주는 방식이라 20단의
accessor 바이트가 원본과 한 글자도 다르지 않고, `gltf-transform meshopt` 파이프라인의
dedup 이 그 동일성을 보고 20개를 1개로 접었다 (2.84MB ≈ hoist 단품 meshopt 2.66MB).
draco 는 dedup 을 안 해서 20 × 0.68MB = 13.6MB 로 남아, 두 변형본의 비율이 압축률이
아니라 "dedup 을 하느냐" 를 재고 있었다.

`glb_edit.bake_transform_glb` 를 추가해 POSITION 데이터에 `p = p*scale + t` 를 직접 적용했다.
단마다 배율을 0.3% 씩 다르게 주어 (1.000 → 1.057) 지오메트리가 실제로 달라진다.
결과가 위 표의 36.64MB 다. 실제 20개층 현장도 바이트 동일 복제본 20개는 아니므로
물리적으로도 이쪽이 맞다.

---

## 2. 완성된 도구

| 파일 | 역할 |
|---|---|
| `scripts/measure.py` | CLI 하네스 (권위 데이터). 동시성 C · 라운드 R · TTFB · 스로틀 감시 · 세션 진단 |
| `scripts/report.py` | §8 집계 → `summary_*.md` (표 1·2·3) |
| `scripts/publish.py` | 다운로드 대상을 서버에 올리고 대상 목록 생성 |
| `scripts/check_schema.py` | §7 스키마 검사 (CLI·브라우저 동일성 확인) |
| `scripts/ofk_api.py` | 백엔드 클라이언트 (로그인 · IFC 업로드 · 잡 폴링 · ENA 카운터) |
| `src/measure/transferHarness.ts` | 브라우저 하네스 (보조). CLI 와 같은 JSON 스키마 |

### §4 불변 조건 반영 상태

| 조건 | 상태 |
|---|---|
| 1. 타겟 주소 파라미터화 | `--target` 필수 인자. 하드코딩 없음. 9월 이중 타겟 실행 가능 |
| 2. 동일 파일 사용 | 위 3개 파일 + 해시 기록. `results/scene_manifest.json` 에 제원 |
| 3. 실제 백엔드로 측정 | `/api/assets` · `/api/assets/ifc` 대상. `server/serve.py` 는 하네스 검증에만 씀 |
| 4. 워밍업 1회 폐기 | 조건마다 워밍업 1라운드 실행 후 파일에 기록하지 않음 |
| 5. 캐시 무력화 | 매 요청 `?t={timestamp_ns}` + `Cache-Control: no-cache, no-store` |
| 6. 세션 메타데이터 | §7 스키마 그대로. `check_schema.py` 로 검증 |

### §9 "하지 말 것" 을 코드로 막았다

- `raw` + C>1 → 실행 거부 (egress 예상치를 계산해 보여주고 중단)
- `loopback` + C>1 → 실행 거부 (2 vCPU CPU 경합)
- egress 예상 60GB 초과 → `--yes` 없이는 중단
- 스로틀된 라운드 → `throttled: true` 로 표시하고 집계에서 제외, **제외 개수를 리포트에 명시**
- CV 를 "지터" 로 부르지 않음 — 표 1 각주에 구분을 명시
- 업로드 변환이 도는 동안 다음 라운드를 쏘지 않음 (기본 동작으로 잡 완료 대기)

### 검증한 것 (로컬, 수치는 폐기)

`server/serve.py` + 목업 백엔드를 상대로 하네스 동작만 확인했다. §4-3 이 금지하는 것은
이 서버로 **데이터를 생산하는 것**이고, 하네스 검증은 여기서 해야 한다.

- 동시성 배리어: C개 스트림이 Barrier 로 동시 발사되고 전부 끝난 뒤 다음 라운드 진행
- 전송 완결성: `bytes_received == file_size_bytes` (339,231,180 바이트 전량 수신 확인)
- TTFB 분리 기록, 핸드셰이크 구간(`connect_ms`) 별도 기록
- 스로틀 카운터 증가 라운드 → `throttled: true` → 집계에서 제외됨
- 카운터 조회 실패 라운드 수를 세어 메타데이터에 기록
- IFC 업로드 202 처리 · 잡 폴링 · 변환 완료 대기 · 결과 에셋 자동 삭제
- 429 `CONVERSION_BUSY` 감지: 잡을 비우지 않으면 4.3ms 로 응답이 돌아온다.
  "업로드가 10배 빨라진" 것처럼 보이는 값인데, 하네스가 실패로 분류하고 집계에서 뺀다
- §7 스키마 검사 통과, 브라우저 하네스 필드 집합 일치

---

## 3. 업로드는 IFC 로 (§2.2)

`POST /api/assets/ifc` 규격을 받아 프론트엔드와 하네스를 모두 IFC 로 바꿨다.

- 사용자 업로드는 `.ifc` / `.ifczip` 만 받는다. `.glb` 는 업로드 전에 걸러낸다 (서버는 415)
- 필드 이름이 `files` 가 아니라 **`file`**, 반복 필드가 아니다
- 성공은 **202 Accepted**. 응답 본문은 에셋이 아니라 변환 잡(`j_…`)
- `waitForIfcJob` 이 `ready` 까지 폴링해 완성된 에셋을 돌려주므로 호출부는 그대로다
- 전송 진행률과 변환 진행률을 따로 표시한다 (32.9MB 변환 196초 — 전송 100% 에서 멈춘
  화면은 실패로 읽힌다)

### §6.1 의 최대 함정은 서버 설계로 해소되었다

변환이 응답 밖으로 빠졌으므로 업로드 응답 시간에 변환 시간이 섞이지 않는다.
`server_work = store + db` 이고 `recv` 는 본문 수신 시간(=네트워크)이라 빼지 않는다 —
빼면 네트워크를 이중 차감해 9월 KOREN 개선폭을 과소평가한다.

### 대신 새 제약이 생겼다

업로드가 끝나면 서버 CPU 에서 변환이 시작된다. §9 는 측정 중 서버에서 변환을 돌리는 것을
금지하므로, 하네스는 **라운드마다 변환 완료를 기다린 뒤** 다음 라운드를 쏜다.
그 대가가 세션 시간이다. 로컬 변환 시간 기준 R=20 이면:

| 파일 | 크기 | 변환 1회 | 21라운드 대기 |
|---|---:|---:|---:|
| hoist | 32.9MB | 196.0s | 약 69분 |
| boomlift | 19.9MB | 97.6s | 약 34분 |
| rooflight | 4.93MB | 18.6s | 약 7분 |

합계 약 **1시간 50분** (전송 시간 별도). t3.medium 의 CPU 는 이 노트북과 다르므로
자릿수 감각용 추정치다. 세션 시작 시 하네스가 이 예상치를 출력한다.

줄이려면 두 가지 중 하나가 필요하다. 어느 쪽도 §4-3 을 깨지 않는다.
1. 변환을 건너뛰는 측정 전용 엔드포인트 (§6.1 의 2번 대응)
2. 업로드 R 을 20 → 10 으로 낮춘다 (§8.1 상 p50 만 유효해지고 p95 는 못 낸다)

---

## 4. 시작을 막고 있는 것

### 세 시간짜리 세션을 위한 보강 (실측 직전에 넣음)

실측 전에 두 가지를 고쳤다. 둘 다 긴 세션에서만 드러나는 문제다.

1. **한 스트림의 실패가 세션 전체를 죽이던 문제.** `curl` 프로세스 타임아웃이
   워커 스레드에서 예외로 올라오면 `future.result()` 에서 다시 던져져 세션이 끝났다.
   마지막 라운드의 타임아웃 하나로 세 시간 분량의 샘플을 다 잃는 구조였다.
   이제 실패는 `error` 가 채워진 실패 샘플로 남고 세션은 계속된다.
2. **조건이 끝날 때마다 파일에 쓴다.** 중간에 끊겨도 그때까지의 샘플이 남는다.
   미완료 파일은 `meta.complete: false` 로 저장되고, `report.py` 가 이걸 보면
   "미완료 세션을 집계에 포함했다" 를 경고로 올린다 — n 이 조용히 줄어든 표를 막는다.

### (1) 인증 자격증명 — 전면 차단

다운로드·업로드 **양쪽 모두** Bearer 토큰이 필요하다. 다운로드도 대상 GLB 를
`POST /api/assets` 로 서버에 올려야 시작할 수 있다.

```bash
# 이것만 있으면 바로 돌아간다
OFK_PASSWORD='…' .venv/bin/python scripts/publish.py \
    --target https://AWS_HOST_REDACTED --label commercial --email '…'

OFK_PASSWORD='…' .venv/bin/python scripts/measure.py \
    --target https://AWS_HOST_REDACTED --label commercial \
    --location home --network-type wifi --directions download upload --email '…'
```

### (2) `POST /api/assets/ifc` 가 배포되지 않았다

규격은 받았지만 `https://AWS_HOST_REDACTED` 에 아직 없다.
POST 가 405 를 내는데, 이는 경로가 `DELETE /api/assets/{asset_id}` 에 `asset_id="ifc"`
로 걸려서 나는 응답이다 (`DELETE /api/assets/ifc` → 401). `/openapi.json` 에도 없다.
코드는 규격대로 써 뒀으므로 배포되면 바로 동작한다.

### ~~(3) 변환 잡 조회 경로 미확인~~ — 확인됨, 가정이 틀렸다

규격을 받아 확인했다. 실제 경로는 **`GET /api/assets/jobs/{jobId}`** 다.
업로드는 `/api/assets/ifc` 인데 조회는 `/ifc` 가 없는 `/api/assets/jobs/{id}` 다.
가정했던 `/api/assets/ifc/jobs/{jobId}` 는 틀렸고, 양쪽 모두 고쳤다.

같이 반영한 규격 사항:

- **폴링 간격 1초** (서버 권장). 2초·3초로 두었던 것을 1초로 낮췄다
- **완료 판정은 `status` 로만** 한다. `progress` 는 완료 전까지 99 를 넘지 않으므로
  100 을 완료 신호로 쓰면 영원히 안 끝난다
- `ready` 응답에 에셋 전체가 중첩되어 오므로 두 번째 요청을 하지 않는다
- **403(남의 잡)·404(없는 잡)는 폴링 종료 조건**으로 처리한다. 이전 구현은 조회 실패를
  전부 일시적 장애로 보고 deadline 까지 재시도했다
- 변환 제한 시간 기본 **900초**. hoist 는 로컬 196초라 여유가 있지만, t3.medium 의
  2 vCPU 가 노트북보다 느리면 `CONVERSION_TIMEOUT` 이 날 수 있다 — 실측에서 확인할 것
- **서버 재시작 시 미완료 잡은 전부 `failed` / `SERVER_RESTART`** 가 된다. 워커가 사라져
  절대 끝나지 않으므로 기다려도 소용없고, 그 라운드는 실패로 기록된다.
  측정 중 서버가 재시작되면 그 조건은 다시 돌려야 한다

### `POST /api/assets` (다운로드 대상 업로드) 규격도 확인했다

- 전체 합계 **512MB** 한도. raw 339.23MB 는 통과하지만, 올린 뒤 413 을 받으면 가정용
  상향 회선으로 수십 분이 낭비되므로 `publish.py` 가 업로드 전에 막는다
- 응답의 `sha256` 은 **엔트리 파일 해시**다. `publish.py` 가 로컬 해시와 비교해
  불일치 시 경고하고 `sha256_match` 를 대상 목록에 기록한다 — §4-2 "같은 바이트를
  쟀다" 의 근거가 여기서 나온다
- 저장 구조는 에셋당 폴더 하나(`/static/assets/{id}/{filename}`)

### (4) loopback 측정용 SSH

§3.1 의 loopback C=1 은 서버에서 하네스를 돌려야 한다. §11 은 "loopback 처리량이
commercial 의 3배 미만이면 멈추고 보고" 를 요구하는데, loopback 값이 없으면 이 판정을
못 한다. `report.py` 는 두 라벨이 다 있으면 비율 표를 자동 생성한다.

---

## 5. 해결된 항목 (§11 보고 대상이었던 것)

| 항목 | 결론 |
|---|---|
| 서버 타이밍 헤더 이름이 문서와 다름 | 계획의 `X-Server-Recv-Ms` 가 아니라 `Server-Timing` 의 `recv`/`store`/`db`. 양쪽 형식을 모두 읽도록 구현. 실측한 헤더 이름을 세션 메타데이터에 기록해 리포트에서 근거로 쓴다 |
| SSH `ethtool` 로 스로틀 감시 | `GET /api/metrics/net-allowance` 가 같은 ENA 카운터를 노출한다 (iface `ens5` 확인). SSH 없이 라운드 전후 차이로 판정 |
| 적층 결과가 예상 크기와 다름 | 위 §1 — dedup 이 원인이었고 좌표 굽기로 해결 |
| IFC 업로드 엔드포인트 없음 | 규격 확보. 배포 대기 |
| `gltf-transform` 미설치 | `package.json` 에 devDependency 로 기록. 이전에는 기록되지 않아 `npm install` 이 지웠다 |
| `speedtest-cli` 미설치 | `.venv` 에 설치. §5.4 진단 4종 모두 실행 가능 |

---

## 6. §10 완료 기준 대비

- [x] `site_stacked` 3개 변형본 생성 — **tmpfs 배치는 미확인** (업로드 후 서버가 어디서 서빙하는지 `publish.py` 가 HEAD 로 점검해 기록한다)
- [ ] loopback C=1 상한 측정 — SSH 필요
- [ ] commercial 다운로드 매트릭스 — 자격증명 필요 (egress 예상 18.2GB, 승인받음)
- [ ] commercial 업로드 측정 — 자격증명 + IFC 엔드포인트 배포 필요. 변환 분리는 확인됨(비동기)
- [x] 스로틀 카운터 기록 및 오염 샘플 제외 — 구현·검증 완료
- [x] 세션 진단 4종 — 구현 완료 (speedtest / 서버 ping / traceroute / 공유기 ping 자동 탐지)
- [x] 브라우저 하네스가 CLI 와 동일 스키마 — 필드 집합 일치 확인. **아직 실행하지 않았다**
- [ ] `summary_*.md` 표 1·2·3 — 도구 완성, 실측 데이터 대기
- [x] 타겟 URL 파라미터화 — `--target` 필수
- [x] 재현용 실행 명령어 보존 — 세션 메타데이터의 `command` 필드
