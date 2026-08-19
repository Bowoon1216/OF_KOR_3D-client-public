# 전송 성능 측정 실행 기록

`ASSET_TRANSFER_TEST_PLAN.md` 실측 세션의 전체 기록. 재현에 필요한 모든 것을 남긴다.

원시 로그는 [`results/logs/`](logs/) 에 단계별로 있다. 이 문서는 그 로그의 색인과 판단 근거다.

---

## 0. 실행 환경

| 항목 | 값 | 출처 |
|---|---|---|
| 측정일 | 2026-08-13 (KST) | |
| 클라이언트 | MacBook (darwin 24.6.0), Python 3.14.0, curl 8.7.1 | |
| 위치 / 회선 | home / Wi-Fi | |
| ISP | LG U+ (Lg Powercomm) | speedtest |
| 회선 실측 | **↓276.12 / ↑71.39 Mbps**, speedtest ping 56.82 ms | `logs/00_speedtest.txt` |
| 서버 | AWS EC2 t3.medium, ap-northeast-2, gp3 | 계획 §1 |
| 서버 SW | OF_KOR_3D Server 0.1.0 / nginx 1.24.0 (Ubuntu) | `/openapi.json`, 응답 헤더 |
| 타겟 | `https://AWS_HOST_REDACTED` | |

### 서빙 위치: EBS (두 번 틀렸고 2026-08-14 에 로그로 확정)

계획 §1 의 "에셋은 tmpfs 에서 서빙" 조건을 **만족하지 않는다.** 이 세션이 실제로 때린 경로는
`/static/assets/a_*/` 이고 그 매체는 **EBS gp3** 다. 서버 nginx 접근 로그가 근거다:

| 경로 | 요청 수 | 매체 |
|---|---:|---|
| `a_ddfbb893/site_stacked_meshopt.glb` | 333 | EBS |
| `a_0db8b84f/site_stacked_draco.glb` | 252 | EBS |
| `a_56077c0a/site_stacked_raw.glb` | 11 | EBS |
| `bench/…` | 11 (8/12, 검증 curl) | tmpfs |

기록이 두 번 틀렸다.

1. 세션 실행 시 `--serving "disk (/static/assets, nginx)"` — **추측이었다.** API 업로드가
   `/static/assets/{id}/` 에 저장하는 것까지만 확인하고 매체를 단정했다
2. 2026-08-13, 담당자 확인을 근거로 `tmpfs` 로 정정 — **이것도 틀렸다.** tmpfs 마운트는
   실제로 존재하고 부팅마다 채워지지만, **측정이 그 경로를 타지 않았다**

**마운트가 존재하는 것과 측정이 그 경로를 탄 것은 다른 사실이다.** 8/13 정정은 전자만 확인했다.
"확인할 수 없는 값을 추측으로 적지 말라" 는 교훈에 한 단계가 더 필요했다 — **확인했더라도
그것이 내가 확정하려는 사실인지 봐야 한다.** 클라이언트에서 볼 수 없는 항목은 서버 로그로만
확정된다.

두 경로의 파일은 바이트가 같다(md5 일치)므로 **측정값 자체는 유효하다.** 정정 대상은 메타데이터뿐이고,
결과 JSON 3개의 `meta.server.serving`·`serving_note` 를 고쳤다 (`samples` 는 두 차례 모두 미수정).

곁가지로 확정된 것: **정적 서빙은 nginx 가 아니라 백엔드(FastAPI `StaticFiles`)가 한다.**
nginx 설정은 `proxy_pass` 하나뿐이다. §3.3 의 "서버 응답 8~9 ms" 도 nginx 가 아니라
uvicorn + ASGI 미들웨어 + 프록시의 합이다.

**loopback 측정도 같은 `a_*` 를 잰다** — 매체가 다른 두 값으로 비율을 내면 §11 의 3배 판정이
오염된다 ([`transfer_loopback_plan.md`](transfer_loopback_plan.md) §0-1).

---

## 1. 서버 API 확인

배포된 `/openapi.json` 에서 직접 확인한 것 (문서가 아니라 실행 중인 서버가 등록한 라우트):

```
POST    /api/assets              GLB 업로드 (합계 512MB 한도)
GET     /api/assets              내가 올린 에셋만 (limit 최대 100)
DELETE  /api/assets/{asset_id}
POST    /api/assets/ifc          IFC 업로드 + 변환 예약. ?convert 파라미터 있음
GET     /api/assets/jobs         변환 잡 목록
GET     /api/assets/jobs/{job_id} 변환 잡 상태
GET     /api/metrics/net-allowance ENA 스로틀 카운터
```

### 계획 문서와 달랐던 것

| 계획 §6.2 기대 | 실제 | 조치 |
|---|---|---|
| `X-Server-Recv-Ms` / `X-Server-Store-Ms` / `X-Server-Db-Ms` | `Server-Timing` 의 `recv`/`store`/`db` | 두 형식 모두 파싱. 실측한 헤더 이름을 세션 메타에 기록 |
| SSH `ethtool -S ens5` 로 스로틀 감시 (§5.3) | `GET /api/metrics/net-allowance` 가 같은 카운터 노출 | SSH 없이 라운드 전후 차이로 판정 |
| 잡 조회 경로 (추정) `/api/assets/ifc/jobs/{id}` | **`/api/assets/jobs/{id}`** | 양쪽 코드 수정. 추정이 틀렸음 |

### `?convert=false` — §6.1 대응책이 서버에 반영됨

계획 §6.1 은 "동기 변환이면 측정 전용 엔드포인트를 요청하라" 고 했다. 서버가 그걸 넣어줬다.
원본을 받아 저장까지만 하고 `skipped` 상태의 기록용 잡만 남긴다. 변환기 가용성(503)과
동시 잡 수(429) 검사도 건너뛴다 — 둘 다 "변환을 시작할 수 있는가" 를 묻는 질문인데
시작하지 않기 때문이다.

이 옵션이 없었다면 업로드 측정에 **약 110분의 변환 대기**가 붙었다 (hoist 33MB × 21회 ×
196초, 동시 변환 2건 제한 때문에 기다리지 않으면 429). 서버 설명에도 같은 수치가 적혀 있다.

`skipped` 는 `ready`/`failed` 가 아니어서 처음 구현한 잡 대기 로직이 40분 타임아웃까지
매달렸다. 종료 상태로 처리하도록 고쳤다.

---

## 2. 측정 대상 파일 (§2.1) — 서버 배치 및 무결성 검증

`logs/01_publish.txt`, `logs/02_targets.txt`

| 변형 | 로컬 bytes | 서버 bytes | Content-Length | sha256 일치 | 업로드 소요 |
|---|---:|---:|---:|:---:|---:|
| raw | 339,231,180 | 339,231,180 | 339231180 | ✅ | 42.4s |
| meshopt | 36,637,416 | 36,637,416 | 36637416 | ✅ | 4.6s |
| draco | 13,595,320 | 13,595,320 | 13595320 | ✅ | 1.7s |

sha256 (§4-2 — 9월에 같은 바이트를 쟀다는 근거):

```
81157c4c507b1905de3dfaab33e7b6336414fd73b45f0710f7876193c85ce5be  site_stacked_raw.glb
b24152cb4c1b57718bac062f9e0f4af8822a526ae4f49fef371dd576d0b0cd04  site_stacked_meshopt.glb
bad876fa1f8c7e3ac2ba5924cf64936e8fd33e7a69535689b763ebdd42b717ad  site_stacked_draco.glb
```

세 파일 모두 서버가 돌려준 해시가 로컬과 일치했다. 전송 중 손상이나 서버 측 재인코딩이
없었다는 뜻이다.

### 응답 헤더 (측정 전제 확인)

```
Cache-Control: no-store, no-cache, must-revalidate   ← §4-5 캐시 무력화
Timing-Allow-Origin: *                               ← §5.2 브라우저 구간 분해 가능
Accept-Ranges: bytes
Content-Type: model/gltf-binary
Server: nginx/1.24.0 (Ubuntu)
```

`Timing-Allow-Origin` 이 붙어 있어 브라우저 하네스가 DNS/TCP/TTFB 를 분해할 수 있다.
계획 §5.2 가 "부재 시 `resource: null` 로 두라" 고 대비한 경우에 해당하지 않는다.

### 적층 씬이 계획 크기와 맞지 않았던 문제 (해결)

처음 만든 적층 씬의 meshopt 변형본이 **2.84MB** 로 나왔다. 계획 예상 35MB 의 1/12 이다.

원인은 dedup 이었다. 래퍼 노드에 translation 을 주는 방식(`translate_glb`)은 20단의
accessor 바이트가 원본과 한 글자도 다르지 않아, `gltf-transform meshopt` 파이프라인의
dedup 이 20개를 1개로 접었다 (2.84MB ≈ hoist 단품 meshopt 2.66MB). draco 는 dedup 을
하지 않아 20 × 0.68MB = 13.6MB 로 남았고, 결과적으로 두 변형본의 비율이 압축률이 아니라
"dedup 을 하는가" 를 재고 있었다.

`glb_edit.bake_transform_glb` 로 POSITION 데이터에 `p = p*scale + t` 를 직접 적용했다.
단마다 배율을 0.3% 씩 달리해(1.000 → 1.057) 지오메트리가 실제로 달라진다.

| 변형 | 계획 예상 | dedup 접힘 | 확정 |
|---|---:|---:|---:|
| raw | ~370MB | 339.22MB | **339.23MB** (-8.3%) |
| meshopt | ~35MB | 2.84MB ❌ | **36.64MB** (+4.7%) |
| draco | ~17MB | 13.59MB | **13.60MB** (-20.0%) |

씬 제원: hoist 20단, z축 간격 8.874m, 전체 높이 182.5m, 삼각형 5,579,960,
정점 14,226,960, 노드 260, 메시 60, 텍스처 0, glTF 검증 오류 0.

---

## 3. 측정 결과

집계표는 [`summary_20260813.md`](summary_20260813.md). 원시 데이터는 세 파일이다.

| 파일 | 하네스 | 방향 | 샘플 | 비고 |
|---|---|---|---:|---|
| `transfer_20260813_0006_commercial.json` | cli | download | 530 | 권위 데이터. egress 17.14GB |
| `transfer_20260813_0019_commercial.json` | cli | upload | 60 | IFC, `?convert=false` |
| `transfer_20260813_0100_commercial.browser.json` | browser | download | 35 | 보조. 정합성 확인용 |

**스로틀 오염 0건, 실패 0건, ENA 카운터 조회 실패 0회.** 세 파일 모두 §7 스키마 검사 통과.

### 3.1 병목은 클라이언트 회선이다 (§11 판정)

동시성을 10배 올려도 합계 처리량이 늘지 않는다.

| 조건 | 스트림당 | 합계 |
|---|---:|---:|
| raw C=1 | 341.38 Mbps | **341 Mbps** |
| meshopt C=1 | 304.63 Mbps | 305 Mbps |
| meshopt C=3 | 115.12 Mbps | **345 Mbps** |
| meshopt C=10 | 39.33 Mbps | **393 Mbps** |
| draco C=10 | 37.15 Mbps | 372 Mbps |

스트림당 처리량이 동시성에 정확히 반비례한다 — 고정된 파이프를 나눠 쓰는 형태다.
단일 스트림 341 Mbps 는 speedtest 실측(227~285 Mbps)보다 높다. **서버는 병목이 아니다.**

**2026-08-14 에 loopback 을 실측해 §11 의 비율을 채웠다** (절차·판정:
[`transfer_loopback_plan.md`](transfer_loopback_plan.md), 집계: [`summary_20260814.md`](summary_20260814.md)).

| 변형 | loopback C=1 | commercial C=1 | loopback/commercial |
|---|---:|---:|---:|
| raw | **1,696.31 Mbps** (p50 1,600.3 ms) | 341.38 Mbps | **4.97배** |
| meshopt | **1,377.81 Mbps** (p50 214.8 ms) | 304.63 Mbps | **4.52배** |
| draco | **1,016.38 Mbps** (p50 108.7 ms) | 263.05 Mbps | **3.86배** |

세 변형 모두 3배를 넘어 §11 보고 기준에 걸리지 않는다. **위의 간접 근거(동시성 무관 합계 포화)로
내렸던 결론이 직접 증거로 확인됐다.** 서버 상한은 1.02~1.70 Gbps 이고 집 회선(↓276 Mbps)의
4~6배이므로, 회선이 개선되면 서버가 받아줄 여유가 그만큼 있다.

작은 파일일수록 비율이 낮다(4.97 → 3.86) — 고정 비용 비중이 커지기 때문이다 (§3.3).

이 값은 **"상한" 이 아니라 "상한의 하한 근사"** 다. 2 vCPU 에서 curl 과 서버가 CPU 를 나눠
쓰므로(`measure.py` 가 loopback 을 C=1 로 강제하는 이유) 실제 상한은 더 높다. 정적 서빙 주체가
FastAPI `StaticFiles` 이므로 "nginx 상한" 이라고 부르지 않는다 (§0).

측정 조건: `tools/loopback_measure.sh` 가 `/etc/hosts` 로 공개 호스트명을 127.0.0.1 로 꺾어
**같은 TLS·SNI·nginx server 블록**을 타게 했다. **ENA 스로틀 카운터 변화 없음**으로 트래픽이
ENI 를 거치지 않았음이 확인됐고, 샘플 70건 전량 채택(throttled 0 · 실패 0), 측정 후 hosts 복구
확인. 같은 `a_*`(EBS) 경로를 쟀다 — 매체가 다르면 이 비율이 오염된다 (§0).

### 3.2 업로드 — §6.2 의 이중 차감 경고가 실측으로 확인됨

| 파일 | 크기 | p50 | 처리량 | `recv` | `store+db` |
|---|---:|---:|---:|---:|---:|
| hoist | 32.90MB | 3,773.7 ms | 69.60 Mbps | 3,602.7 ms (95.5%) | 114.4 ms (**3.0%**) |
| boomlift | 19.90MB | 2,371.5 ms | 65.99 Mbps | 2,280.1 ms (95.3%) | 70.7 ms (3.0%) |
| rooflight | 4.93MB | 643.2 ms | 58.84 Mbps | 592.2 ms (90.2%) | 22.1 ms (3.4%) |

`recv` 가 전체의 90~96% 다. nginx 가 `proxy_request_buffering off` 로 본문을 흘려보내므로
multipart 파싱이 클라이언트 바이트 도착 속도에 묶이기 때문이고, 즉 `recv` ≈ 전송 시간이다.
서버가 실제로 일한 시간은 `store + db` = **3.0~3.4%** 뿐이다.

`recv` 까지 뺐다면 hoist 의 네트워크 시간이 3,773.7 − 3,602.7 − 114.4 = **56.6 ms** 로
나와 실제(3,659.3 ms)의 **1.5%** 가 된다. 계획 §6.2 가 경고한 그대로다.

(백분위는 `report.py` 와 같은 nearest-rank 로 통일했다. `statistics.median` 은 n 이
짝수일 때 가운데 두 값을 평균해서 같은 표에 두 방식을 섞으면 산술이 어긋난다 —
이 절의 `recv` 값이 처음에 3,612.5 로 적혀 46.8 ms 라는 틀린 차감 결과가 나왔다.)

업로드도 회선 한계다 — 69.60 Mbps 가 speedtest 상향 실측(65.7 Mbps)과 같은 수준이다.

**서버는 두 헤더 형식을 모두 보낸다**: `Server-Timing` 과 `X-Server-Recv-Ms` /
`X-Server-Store-Ms` / `X-Server-Db-Ms`. 계획 §6.2 가 기대한 이름이 실제로 존재한다
(앞서 "이름이 다르다" 로 §11 보고 대상에 올린 것은 OpenAPI 설명만 보고 판단한 것이었고,
실물 응답에는 둘 다 있다). 하네스는 문서 형식을 우선으로 쓴다. 응답에는 더 세분화된
`X-Server-Store-Read-Ms` / `X-Server-Store-Hash-Ms` / `X-Server-Store-Write-Ms` /
`X-Server-Total-Ms` 도 있어, 필요하면 저장 구간을 더 쪼갤 수 있다.

### 3.3 전송 외 고정 비용의 정체

계획 §8.2 표 3 은 "크기 절감률과 시간 절감률의 차이가 전송 외 고정 비용" 이라고만 한다.
두 하네스를 대조하면 그 고정 비용이 무엇인지 갈라진다.

| 구간 | CLI | 브라우저 |
|---|---:|---:|
| DNS+TCP+TLS | **25.0 ms** (요청마다) | **0.0 ms** (커넥션 재사용) |
| 서버 응답 대기 | (TTFB 에 포함) | **8.1 ms** |
| TTFB | 34.4 ms | — |

CLI TTFB 34.4 ms 중 **25.0 ms 가 연결 수립 비용(72%)** 이고, 서버가 응답을 시작하는 데
쓰는 시간은 8~9 ms 다. 브라우저가 독립적으로 잰 순수 서버 응답 8.1 ms 가 CLI 의 잔차와
일치한다 — 두 하네스가 서버 구간에서 교차 검증됐다.

CLI 가 매 요청 핸드셰이크를 내는 이유는 라운드마다 curl 프로세스를 새로 띄우기 때문이다.
§5.1 이 요구한 라운드 배리어(C개 동시 발사 후 전부 완료 대기)를 프로세스로 구현하면
커넥션을 넘길 수 없다. 이건 결함이 아니라 트레이드오프다 — 대신 §8.2 표 3 의 고정 비용이
측정값에 포함되며, 계획도 그걸 전제한다.

다만 크기 비례로 예상한 시간과의 차이는 핸드셰이크만으로 설명되지 않는다.
raw 를 기준으로 크기에 정비례한다면 meshopt 는 865 ms, draco 는 321 ms 여야 하는데
실측은 963 ms, 414 ms 다. 초과분이 각각 98 ms, 93 ms 로 거의 같다. 핸드셰이크 25 ms 와
서버 9 ms 를 빼면 약 60 ms 가 남고, 이는 TCP slow-start 의 congestion window 상승
구간으로 보인다 (파일이 작으면 최대 대역에 도달하기 전에 전송이 끝난다). **이 60 ms 의
정체는 추정이며 측정으로 확인한 것이 아니다.**

#### 2026-08-14 loopback 실측 — 고정 비용은 네트워크가 아니라 CPU 다

| | commercial (집→AWS) | loopback (서버 내부) |
|---|---:|---:|
| TTFB p50 | 34.4 ms | **35.05 ms** |
| 핸드셰이크(`connect`) p50 | 25.0 ms | **33.54 ms** |

**네트워크를 완전히 제거해도 핸드셰이크가 줄지 않는다 — 오히려 늘었다.** 위에서 25.0 ms 를
"연결 수립 비용" 으로만 적었는데, 그 정체는 전파 지연이 아니라 **TLS 연산과 curl 프로세스 기동의
CPU 시간**이다.

loopback 값이 더 큰 것은 2 vCPU 에서 curl 과 서버가 CPU 를 다투기 때문으로 보인다 —
commercial 은 클라이언트가 i9 맥북이었으므로 조건이 다르다. **이 차이의 정체는 측정으로 확정하지
않았다.**

실무적 함의: **회선이 개선돼도 이 고정 비용은 남는다.** 작은 파일에서 KOREN 개선폭을 크기 비례로
기대하면 안 된다. loopback draco 는 elapsed 107.8 ms 중 TTFB 35.0 ms = **32%** 가 고정 비용이고,
그래서 §3.1 의 비율이 raw 4.97배 → draco 3.86배로 떨어진다.

### 3.4 CLI 대 브라우저 정합성 (§5.2)

| 조건 | CLI p50 | 브라우저 p50 | 차이 |
|---|---:|---:|---:|
| meshopt C=1 | 963.2 ms | 1,013.5 ms | +5.2% |
| draco C=1 | 414.2 ms | 333.7 ms | −19.4% |
| meshopt C=3 | 2,522.7 ms | 1,946.2 ms | −22.9% |

작은 파일과 다중 스트림에서 브라우저가 빠르다. 원인은 위 3.3 의 커넥션 재사용이다.
draco(333 ms)에서는 25 ms 핸드셰이크가 7.5% 를 차지하고, C=3 에서는 브라우저가 한 커넥션에
멀티플렉싱해 TLS 핸드셰이크 3회를 아예 내지 않는다. meshopt C=1(1초 규모)에서는 고정
비용 비중이 작아 두 하네스가 5% 안에서 일치한다.

**이것이 계획 §9 가 "브라우저를 권위 데이터로 쓰지 말라" 고 한 이유의 실측 근거다.**
집계표에서 `browser` 행은 `(보조)` 로 표시하고 `cli` 행과 절대 합치지 않는다.

`Timing-Allow-Origin: *` 이 붙어 있어 **35/35 샘플 전부** 구간 분해가 됐다. 계획 §5.2 가
대비한 "TAO 부재 시 `resource: null`" 경우에 해당하지 않는다.

### 3.5 진단 실패 — 서버 RTT 를 ping 으로 낼 수 없다

- **서버 ping 30발 전부 손실 (100%)** — AWS 가 ICMP 를 차단한다
- **traceroute 목적지 미도달** — 9홉까지만 응답하고 이후 max TTL 까지 무응답.
  집계된 "63 hops" 는 실제 경로 길이가 아니다
- 대용으로 다운로드 TTFB 중앙값 39.2 ms 를 기재했다. 왕복 1회와 서버 응답 시작이
  들어 있어 RTT 의 상한 근사다

**Wi-Fi 노이즈 바닥값** (§8.3 필수 명시 항목): 공유기 RTT avg 7.243 ms /
**mdev 11.61 ms** / 최대 80.24 ms, 손실 0%. mdev 가 avg 보다 크다 — 간헐적 스파이크가 있고
이 노이즈가 위 모든 측정값에 포함되어 있다.

---

## 4. 측정 중에 고친 것

실측을 돌리면서 드러난 문제들이다. 모두 "없는 사실을 기록에 남기는" 부류였다.

| 문제 | 조치 |
|---|---|
| ping 실패(100% 손실)를 `서버 RTT avg 0 ms` 로 표기 | 실패로 명시하고 TTFB 대용 제시 |
| 목적지 미도달 traceroute 를 `63 hops` 로 표기 | "미도달" 명시, 응답한 홉 수만 보고 |
| `convert=false` 인데 "§9 위반: 변환을 기다리지 않았다" 경고 | 변환 예약 여부를 함께 보고 판정 |
| 브라우저 세션의 `회선 ↓0 / ↑0 Mbps` | "미측정" 으로 표기하고 이유 명시 |
| 브라우저 세션의 `ping ?발 전부 손실` | ping 을 못 돌리는 하네스임을 명시 |
| 브라우저 샘플이 CLI 행에 합쳐짐 (§9 위반) | 하네스를 집계 키에 넣어 행 분리, `(보조)` 표시 |
| mdev ≤ avg 인데도 "스파이크가 있다" 문장 출력 | 조건부로 변경 |
| 브라우저 `started_at` 이 UTC — session_id 와 날짜 어긋남 | `localIso()` 로 CLI 와 통일 |
| `skipped` 잡을 대기 대상으로 오인 → 40분 타임아웃 | 종료 상태로 처리 |
| 한 스트림 실패가 세션 전체를 죽임 | 실패 샘플로 남기고 계속 진행 |
| 중간에 끊기면 전량 손실 | 조건마다 flush, `complete: false` 표시 |
| `list_assets` 가 `limit=200` 으로 422 | 상한 100 + offset 페이징 |

---

## 5. 남은 일

- ~~**loopback C=1 상한 측정**~~ — **2026-08-14 완료.** 비율 raw 4.97 / meshopt 4.52 /
  draco 3.86배 → §11 기준 통과 (§3.1). 원시 데이터 `transfer_20260814_2156_loopback.json`,
  로그 `logs/06_download_loopback.txt`, 집계 [`summary_20260814.md`](summary_20260814.md)
- **서버 디스크 정리** — `convert=false` 업로드가 원본 IFC 를 보관한다. 63건 = **1.21GB**
  가 적재됐고 잡 삭제 엔드포인트가 없다(GET 만 존재). 9월에 같은 측정을 하면 또 1.2GB 가
  쌓인다. `DELETE /api/assets/jobs/{id}` 또는 수동 정리가 필요하다
- **업로드 p95** — R=20 이라 `n<30` 으로 p95 를 못 낸다 (§8.1). p95 가 필요하면 R=30 이상.
  `convert=false` 라 변환 대기가 없으므로 R 을 올려도 시간 비용은 전송 시간뿐이다
- **한 회선에서는 KOREN 대역 우위를 관측할 수 없다** — §3.1 의 포화(341~393 Mbps)가 집
  다운링크(↓276 Mbps)의 천장이고, 동시성을 올려도 합계가 평탄하므로 한 노트북에서 세션을 늘려도
  서버 쪽 요구량은 그 천장을 못 넘는다. 그래서 지표를 처리량에서 **경합 하의 동기화 지연**으로
  바꾼다 — 설계는 [`koren_bandwidth_plan.md`](koren_bandwidth_plan.md) §2

---

## 4. 재현 명령

```bash
# 씬 생성 (9월에는 하지 말 것 — §4-2)
.venv/bin/python scripts/compose.py site_stacked
.venv/bin/python scripts/optimize.py site_stacked --scenes

# 대상 배치
.venv/bin/python scripts/publish.py --target <URL> --label commercial \
    --email <이메일> --password-file <경로>

# 측정
.venv/bin/python scripts/measure.py --target <URL> --label commercial \
    --location home --network-type wifi --isp "LG U+ (Lg Powercomm)" \
    --server-version "OFK_KOR_3D Server 0.1.0 / nginx 1.24.0" \
    --serving "disk (/static/assets, nginx)"

# 업로드 (전송 시간만 — 변환은 §0 범위 밖)
.venv/bin/python scripts/measure.py --target <URL> --label commercial \
    --directions upload --location home --network-type wifi \
    --email <이메일> --password-file <경로>

# 집계
.venv/bin/python scripts/report.py results/transfer_*.json
.venv/bin/python scripts/check_schema.py results/transfer_*.json
```

비밀번호는 `--password-file` 로만 넘긴다. 명령줄 인자로 주면 세션 메타데이터의
`command` 필드에 그대로 적혀 `results/` 에 커밋된다.
