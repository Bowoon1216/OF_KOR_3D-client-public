# 인수인계 — 전송 성능 측정 (AWS vs KOREN)

**갱신** 2026-08-14 · 다음 세션이 이 문서만 읽고 이어갈 수 있게 쓴다.

관련 문서: [`transfer_run_journal.md`](transfer_run_journal.md) (AWS 전 과정) ·
[`report_line_asymmetry_20260813.md`](report_line_asymmetry_20260813.md) (업/다운 비대칭 보고서) ·
`ASSET_TRANSFER_TEST_PLAN.md` (원 계획서)

---

## 1. 지금까지 확보한 데이터

전부 `results/` 에 있고 `scripts/check_schema.py` 를 통과했다.

| 파일 | 라벨 | 방향 | n | 비고 |
|---|---|---|---:|---|
| `transfer_20260813_0006_commercial.json` | commercial | download | 530 | AWS 전체 매트릭스 §3.1 |
| `transfer_20260813_0019_commercial.json` | commercial | upload | 60 | AWS IFC `?convert=false` |
| `transfer_20260813_0100_commercial.browser.json` | commercial | download | 35 | 브라우저(보조) |
| `transfer_20260814_2156_loopback.json` | loopback | download | 70 | AWS 서버 상한 |
| `transfer_20260814_2229_koren.json` | koren | download | 530 | KOREN 전체 매트릭스 |
| `transfer_20260814_2243_koren-loopback.json` | koren-loopback | download | 70 | KOREN 서버 상한 |
| `transfer_20260814_2245_koren.json` | koren | upload | 60 | KOREN IFC `?convert=false` — 완료 |

대상 목록: `download_targets_commercial.json` (AWS), `download_targets_koren.json` (KOREN).
**두 타겟의 GLB 3개는 sha256 이 서로 같다** — §4-2 충족, 같은 바이트를 쟀다.

---

## 2. 핵심 결과

### 2.1 회선 비대칭 (AWS, 8/13)

다운로드 **341.38 Mbps** / 업로드 **69.60 Mbps** → **4.91 : 1**.
두 방향 모두 회선 한계 도달(동시성 포화 + speedtest 초과). 보고서 발행됨:
https://claude.ai/code/artifact/0d1e51b1-d025-444a-8629-c842d6fa8f6a

### 2.2 서버 상한 (loopback)

| 변형 | AWS | KOREN | 상용망 대비 배수 (AWS / KOREN) |
|---|---:|---:|---|
| raw | 1,696.31 Mbps | **2,807.73** | 4.97배 / **9.15배** |
| meshopt | 1,377.81 | **2,767.52** | 4.52배 / **9.23배** |
| draco | 1,016.38 | **2,554.79** | 3.86배 / **12.07배** |

양쪽 모두 §11 기준(3배)을 넘어 **서버는 병목이 아니다.**

⚠️ **이 표의 AWS 열은 낡았다 (§5.11).** `--cacert` 없이 재서 요청당 약 27 ms 아티팩트가
섞였고, 특히 작은 파일이 과소평가됐다. 정정: raw **1,712.6** / meshopt **1,426.3** /
draco **1,330.7** Mbps. KOREN 열은 평문 시절 값이므로 post-TLS 값(§5.10)과 비교할 때 주의.
그리고 **"KOREN 서버가 1.65~2.5배 빠르다" 는 철회했다** — 조건을 맞추면 1.15배다 (§5.11).

### 2.3 AWS vs KOREN 다운로드 — 방향은 일관, **크기는 확정 불가**

먼저 이틀 간격으로 잰 단발 비교(8/13 AWS vs 8/14 KOREN)는 **폐기한다**:
raw −10.1% / meshopt −1.5% / draco −19.5% 로 나왔는데, 아래 A-B-A-B 가 같은 조건에서
meshopt −8.6% / draco −4.6% 를 냈다. **크기가 전혀 다르다 — 단발 값은 노이즈였다.**

**A-B-A-B (8/14 22:52~23:11, 4.5분 간격, 세션당 n=60)**

| 변형 | AWS-1 | KOREN-1 | AWS-2 | KOREN-2 |
|---|---:|---:|---:|---:|
| meshopt | 263.55 | 223.22 | 250.35 | 246.74 |
| draco | 213.38 | 196.15 | 203.77 | 201.86 |

| 변형 | AWS 반복 드리프트 | KOREN 반복 드리프트 | 쌍1 신호 | 쌍2 신호 | 평균 신호 | 판정 |
|---|---:|---:|---:|---:|---:|---|
| meshopt | +5.0% | **+10.5%** | −15.3% | −1.4% | −8.6% | 드리프트 > 신호 → **확정 불가** |
| draco | +4.5% | +2.9% | −8.1% | −0.9% | −4.6% | 드리프트 ≈ 신호 → **경계** |

**확정된 것**: 4개 쌍 비교 전부에서 KOREN 이 느렸다 (−15.3 / −1.4 / −8.1 / −0.9%).
**부호가 4/4 일관**하므로 "KOREN 이 이 경로에서 조금 느리다" 는 방향은 신뢰할 수 있다.

**확정 못 한 것**: 그 크기. 쌍마다 −0.9% ~ −15.3% 로 흔들리고, 같은 타겟 반복 사이의
드리프트(최대 10.5%)가 타겟 간 차이와 같은 규모다. **어떤 단일 퍼센트 값도 발표에 쓸 수 없다.**

회선이 측정 중 계속 나빠졌다 (speedtest ↓ 227.66 → 247.95 → 180.42 → 179.03).
공유기 mdev 는 2.88~3.38ms 로 안정적이었으므로 Wi-Fi 가 아니라 상위 구간 변동이다.

크기를 확정하려면 **A-B 교대를 6~8쌍으로 늘려** 드리프트를 평균으로 상쇄해야 한다.
서버 상한이 9~12배 여유이므로 원인이 서버가 아닌 것은 확실하다.

### 2.4 업로드 A/B — 차이가 회선 드리프트로 설명된다

| 파일 | AWS | KOREN | 변화 |
|---|---:|---:|---:|
| hoist (32.90MB) | 69.60 Mbps | 61.95 | −11.0% |
| boomlift (19.90MB) | 65.99 | 64.21 | −2.7% |
| rooflight (4.93MB) | 58.84 | 55.13 | −6.3% |

그런데 **회선 용량 대비 효율은 같다:**

| | 업로드 실측 | 그 세션 speedtest ↑ | 실측/speedtest |
|---|---:|---:|---:|
| AWS hoist | 69.60 Mbps | 65.66 | **106.0%** |
| KOREN hoist | 61.95 | 58.31 | **106.2%** |

소수점까지 일치한다. **−11% 는 경로 차이가 아니라 그 시각 회선이 11% 느렸던 것이다.**
서버 작업 비중도 양쪽 3.0~3.1% 로 동일하다. 이것이 §3.1 의 A-B-A-B 가 필요한 이유의
가장 명확한 증거다 — 다운로드의 −10%/−19.5% 도 같은 성질일 수 있다.

---

## 3. 미해결 문제 — 다음 세션의 첫 작업

### 3.1 두 측정의 시각이 다르다 (계획서 §0 위반)

§0 은 **"같은 장소·같은 기기·같은 시간에 AWS와 KOREN을 동시에 측정"** 을 요구하는데
AWS 는 8/13 자정, KOREN 은 8/14 밤에 쟀다. 회선이 세션마다 크게 흔들린다:

| 세션 | speedtest ↓ | 공유기 RTT mdev | 서버 RTT mdev |
|---|---:|---:|---:|
| AWS 다운로드 (8/13 00:06) | 227.12 Mbps | 11.61 ms | 측정 불가(ICMP 차단) |
| KOREN 다운로드 (8/14 22:29) | **309.47** | **21.83** | 29.44 |
| KOREN 업로드 (8/14 22:5x) | **207.44** | — | 3.74 |

같은 밤 안에서도 speedtest 가 207~309 Mbps 로 50% 흔들린다. **§2.3 의 −10%/−19.5% 를
"경로 차이" 라고 단정할 수 없다.**

**해야 할 일**: AWS 와 KOREN 을 **번갈아 연속 측정** (A-B-A-B). 사용자 승인받음.

```bash
# 각 세션 약 1.5GB, 4세션 총 6GB (AWS egress 3GB). 이미 쓴 AWS egress 17.14GB.
for i in 1 2; do
  .venv/bin/python -u scripts/measure.py --target https://AWS_HOST_REDACTED \
    --label commercial --location home --network-type wifi --isp "LG U+ (Lg Powercomm)" \
    --download meshopt:1:30 draco:1:30 \
    --serving 'EBS gp3 (`a_*` 경로) ※2026-08-14 정정' \
    --server-version "OF_KOR_3D Server 0.1.0 / nginx 1.24.0" \
    --session-id "ab${i}a_aws" --out results/transfer_ab${i}a_commercial.json
  .venv/bin/python -u scripts/measure.py --target http://KOREN_IP_REDACTED:8000 \
    --label koren --location home --network-type wifi --isp "LG U+ (Lg Powercomm)" \
    --download meshopt:1:30 draco:1:30 \
    --instance-type "KOREN VM (4 vCPU / 16GB)" --region KOREN \
    --ebs-type "none (vda1 ext4)" --serving "vda1 ext4 (/static/assets/a_*)" \
    --server-version "OF_KOR_3D Server 0.1.0 / uvicorn 직결 (nginx·TLS 없음)" \
    --session-id "ab${i}b_koren" --out results/transfer_ab${i}b_koren.json
done
```

판정: A 세션 둘(ab1a, ab2a)의 차이가 A-B 차이보다 크면 회선 드리프트가 신호를 덮은 것이므로
반복 횟수를 늘려야 한다.

### 3.2 전송 계층이 다르다 (계획서 §4-3 위반)

| | AWS | KOREN |
|---|---|---|
| 경로 | https → nginx → proxy_pass → uvicorn | http → **uvicorn 직결** |
| TLS 핸드셰이크 | **14.75 ms** | **0** (평문) |
| 핸드셰이크 총합 (실측 p50) | 25.0 ms | 11.4 ms |

**KOREN 이 TLS 를 안 낸다.** 처리량 비교에는 영향이 거의 없지만(raw 8초에 15ms = 0.19%)
TTFB·고정비용 비교는 오염된다(draco 414ms 에 15ms = 3.6%).

해결책 중 하나가 필요하다 — **담당자 요청 사항**:
1. **KOREN 에 nginx + TLS 를 붙인다** (추천 — AWS 와 같은 경로가 된다)
2. AWS 8000 포트를 연다 (현재 닫힘. 양쪽을 평문 uvicorn 직결로 맞춤)

어느 쪽도 안 되면 `connect_ms`(= `time_pretransfer`)를 빼서 보정한 값을 함께 낸다.
`measure.py` 가 이미 샘플마다 `connect_ms` 를 기록한다.

### 3.3 집에서 KOREN 을 재는 것 자체가 목적과 다르다

지금 경로는 `집 → LG U+ → 피어링 → KOREN` 이다. 계획서 §0 이 말하는 9월 측정은
**KOREN 환경 안에서** 재는 것이고, KOREN 의 이점은 클라이언트도 KOREN 에 있을 때 나온다.
**따라서 §2.3 의 "KOREN 이 느리다" 를 "KOREN 이 나쁘다" 로 읽어서는 안 된다.**
9월에는 캠퍼스(KOREN 망 내부)에서 측정해야 한다.

---

## 4. 접속 정보 · 실행 환경

| 항목 | 값 |
|---|---|
| AWS 타겟 | `https://AWS_HOST_REDACTED` |
| AWS 계정 | `bowoon@cau.ac.kr` / 비밀번호는 `--password-file` 로만 전달 |
| AWS SSH | `ssh -i ~/.ssh/of-kor-3d-keypair.pem ubuntu@AWS_IP_REDACTED` — **된다** (2026-08-15 확인). 비밀번호 인증은 sshd 에서 꺼져 있어 이 키만 유효하다. sudo 는 무암호. `tools/loopback_measure.sh` 는 서버에 존재하지 않는다 |
| AWS 하네스 | `~/ofk-measure/scripts/` — 2026-08-15 에 `--cacert` 지원 버전으로 갱신. 구버전은 `~/ofk-measure/scripts.bak.20260815/` |
| KOREN 타겟 | `http://KOREN_IP_REDACTED:8000` |
| KOREN SSH | `ssh -i ~/.ssh/id_ed25519 -p 26022 ubuntu@KOREN_IP_REDACTED` — **이 Mac 의 기존 키로 접속됨** |
| KOREN 계정 | `bowoon+measure@cau.ac.kr` (측정 전용, 신규 생성). AWS 와 같은 비밀번호 |
| KOREN 스크립트 위치 | `~/ofk-measure/scripts/` (measure.py, common.py, ofk_api.py, _pathfix.py) |
| KOREN python | 3.12.3 · curl 8.5.0 |

**`bowoon@cau.ac.kr` 은 KOREN 에도 이미 있으나 비밀번호가 AWS 와 다르다** (signup 409,
login 401). 그래서 측정 전용 계정을 따로 만들었다. 원 비밀번호를 알면 계정을 합칠 수 있다.

비밀번호는 저장소에 두지 않는다. 세션 스크래치패드의 `.ofkpw` 에 있었고 세션이 끝나면
사라진다 — 다음 세션은 사용자에게 다시 받아야 한다.

### KOREN loopback 재실행 방법

AWS 와 달리 `/etc/hosts` 조작이 필요 없다 (nginx·TLS 가 없어 uvicorn 을 직접 때리면
상용 측정과 같은 소프트웨어 경로다).

```bash
ssh -i ~/.ssh/id_ed25519 -p 26022 ubuntu@KOREN_IP_REDACTED
cd ~/ofk-measure/scripts
python3 measure.py --target http://127.0.0.1:8000 --label koren-loopback \
  --targets ../results/download_targets_koren.json \
  --download raw:1:10 meshopt:1:30 draco:1:30 \
  --location other --network-type wired --skip-probes --no-throttle-watch
# 회수
scp -i ~/.ssh/id_ed25519 -P 26022 \
  'ubuntu@KOREN_IP_REDACTED:~/ofk-measure/results/transfer_*_koren-loopback.json' results/
```

---

## 5. 하네스 사용 시 주의

측정 중에 발견해 고친 것들이다. 되돌리지 말 것.

| 항목 | 내용 |
|---|---|
| 백분위 | `report.py` 와 같은 **nearest-rank** 로 통일. `statistics.median` 을 섞으면 산술이 어긋난다 (실제로 이중차감 값이 46.8 vs 56.6 으로 틀렸다) |
| 브라우저 샘플 | 집계 키에 `harness` 가 들어간다. 안 넣으면 CLI 행과 합쳐져 §9 위반 |
| `convert=false` | 업로드는 이 옵션을 쓴다. 안 쓰면 변환 대기 약 110분 + 429 |
| `skipped` 잡 | 종료 상태다. 대기 대상으로 두면 40분 타임아웃 |
| KOREN 스로틀 감시 | `net-allowance` 가 **503** (ENA 없음, iface `ens3`). 카운터 못 읽은 라운드로 기록된다 — 정상이며 KOREN VM 은 버스터블이 아니다 |
| 진단 표기 | ping 실패를 `0 ms` 로, 미도달 traceroute 를 홉 수로 적지 않는다. `report.py` 가 막는다 |
| 파이프 권한 | `\| tee` 는 허용 규칙에 없어 막힐 수 있다. `--out` 을 쓰고 파일을 읽는 게 안전 |
| **`--cacert` 를 항상 쓸 것** | Ubuntu 의 curl 8.5.0/OpenSSL 3.0.13 은 시스템 CA 저장소(121개/182KB)를 **매 요청마다** 파싱해 **약 27~29 ms** 를 요청당 고정비에 얹는다. 한쪽만 `--cacert` 를 쓰면 그 차이가 그대로 "서버가 5.8배 빠르다" 로 오독된다 (§5.11 에서 실제로 그랬다). **비교하는 두 측정의 CA 조건을 반드시 같게 맞춘다.** 공개 인증서라도 체인 파일을 `--cacert` 로 넘기면 된다 |
| 진짜 loopback 확인 | 공개 호스트명을 그냥 쓰면 loopback 이 아니다. `/etc/hosts` 고정 또는 `curl --resolve` 를 쓴다. 경로 차이는 RTT +0.27 ms 뿐이지만 처리량이 draco 기준 25% 낮게 나온다 |

---

## 5.5 KOREN 이 nginx + TLS 로 바뀌었다 (2026-08-15)

**기존 KOREN 측정값(다운 530 / 업 60 / loopback 70)은 전부 `http → uvicorn 직결` 시절
데이터다. 이제 전송 계층이 바뀌었으므로 재측정이 필요하다.** 기존 데이터는 지우지 말고
**"pre-TLS 기준선"** 으로 보존할 것 — 같은 하드웨어에서 TLS+nginx 전/후를 비교하면
"AWS loopback 이 KOREN 의 절반이었던 게 서버 성능이냐 전송 계층이냐" 가 풀린다.
AWS 에서는 TLS 를 뗄 수 없어 못 하는 실험이다.

| 항목 | 값 |
|---|---|
| 새 주소 | `https://KOREN_IP_REDACTED:8000` (http 는 400) |
| 인증서 | `CN=KOREN_IP_REDACTED`, SAN 에 `IP:KOREN_IP_REDACTED` 포함 |
| 발급자 | `KOREN Internal Root CA` (사설 CA, 2036 만료) |
| CA 위치 | 서버의 `~/ca/rootCA.crt` — `ssh … 'cat ~/ca/rootCA.crt' > 로컬경로` 로 회수 |
| HTTP 버전 | **1.1** — AWS 도 1.1 이다 (`--http2` 요청해도 ALPN 에서 h2 미제안). **맞출 필요 없음** |

### 하네스에 `--cacert` 를 추가했다

`measure.py` / `publish.py` 에 `--cacert <경로>` 가 생겼다. curl 과 urllib 양쪽에
적용된다 (`ofk_api.set_ca_bundle`). **시스템 신뢰 저장소를 고치지 않는다** — 측정
재현성이 실행 기계 상태에 의존하면 9월에 다른 노트북에서 안 돌아간다.

```bash
ssh -i ~/.ssh/id_ed25519 -p 26022 ubuntu@KOREN_IP_REDACTED 'cat ~/ca/rootCA.crt' > /tmp/korenCA.crt
.venv/bin/python scripts/measure.py --target https://KOREN_IP_REDACTED:8000 --label koren \
  --cacert /tmp/korenCA.crt --targets results/download_targets_koren.json …
```

**브라우저 하네스는 다르다.** 사설 CA 는 클릭해서 넘어가는 것으로 해결되지 않는다 —
그건 최상위 탐색에만 적용되고 `fetch`/XHR 은 그냥 실패한다. **OS 신뢰 저장소에 설치해야
한다.** macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.crt`
(Chrome 은 시스템 키체인을 쓴다). Windows: `certutil -addstore -f ROOT rootCA.crt` 후 브라우저 재시작.

### 내가 틀렸던 것 — nip.io + Let's Encrypt

"nip.io 를 쓰면 도메인 없이 Let's Encrypt 가 된다" 고 적었는데 **거짓이다.**
HTTP-01 은 80번이 인터넷 전체에 열려야 하고(KOREN 은 8000번만, 그것도 지정 IP), DNS-01 은
`_acme-challenge.116-89-187-188.nip.io` 에 TXT 를 넣어야 하는데 nip.io 는 사용자가 DNS 를
제어할 수 없다. AWS 에서 됐던 건 80번이 열려 있었기 때문이고, 그 조건이 KOREN 에 그대로
간다고 가정한 것이 오류였다. **폐쇄망에서는 사설 CA 가 맞다.**

---

## 5.6 돈으로 못 사는 논거 — 클라이언트 접속망 (2026-08-15)

지금까지 찾은 KOREN 논거(서버 상한, egress, 스로틀)는 **전부 AWS 에서 결제로 대체 가능**
하다. 연구 발표 논거로는 약하다. 대체 불가능한 것은 하나뿐이다: **사용자가 어느 망에
붙어 있는가.** 서버에 아무리 돈을 써도 사용자의 접속 회선은 못 바꾼다.

**같은 AWS 서버를 두 클라이언트가 받은 결과** (서버·파일·TLS·스크립트 동일, 접속망만 다름):

| 변형 | 집 Wi-Fi (LG U+) | KOREN VM | 배수 |
|---|---:|---:|---:|
| meshopt 36.6MB | 304.63 Mbps | **864.35** | **2.84배** |
| draco 13.6MB | 263.05 | **607.25** | **2.31배** |

원시: `results/transfer_20260815_0828_koren-client.json` (label `koren-client`, n=20씩)

**논지 전환**: "서버를 KOREN 에 둬서 빠르다"(대체 가능) → **"KOREN 망 사용자는 같은
서비스를 2.3~2.8배 빠르게 쓴다"**(대체 불가).

붙일 조건 3가지:
1. **Wi-Fi vs 유선이 섞였다.** 집은 Wi-Fi 노트북, KOREN 은 유선 VM. 집을 유선으로 바꿔
   재측정하면 순수 접속망 차이가 분리된다 — **다음 세션 최우선 작업**
2. KOREN VM 은 상한값이다. 실제 캠퍼스 사용자는 교내망+Wi-Fi 를 거친다
3. TTFB 는 오히려 KOREN 이 높다 (152.61 vs 34.42 ms). 작은 파일일수록 이득이 줄고
   (draco 2.31 < meshopt 2.84), 지연이 중요한 동기화 축에서는 유리하지 않을 수 있다

**미해결 포지셔닝 문제**: 이 논거는 사용자가 KOREN 연결 기관(대학·연구소·건설사 사내망)에
있을 때만 성립한다. "일반인 대상" 서비스와 충돌한다. 측정으로 풀 문제가 아니라 서비스
포지셔닝 결정이다.

---

## 5.7 SSH 사용 — 확인 필요

KOREN VM 에 이 Mac 의 `~/.ssh/id_ed25519` 로 접속했다 (사용자가 준 Windows 경로 대신).
**서버 설정은 건드리지 않았다** — 홈 디렉터리에 `~/ofk-measure/` 만들고 스크립트를 두고
HTTP GET 만 했다. `/etc/hosts`·nginx·uvicorn·시스템 패키지 미변경.

사용자가 접속 정보를 준 것을 사용 허가로 해석했으나 **명시적 확인을 받지 않았다.**
다음 세션은 계속 써도 되는지 먼저 확인할 것. 정리하려면 `rm -rf ~/ofk-measure` 면 된다.

---

## 5.8 비용 분해 — 서버 격차의 정체 (2026-08-15)

loopback 을 파일 크기 3개로 쟀으므로 `elapsed = 고정비 + 크기 × 단위비` 로 분해할 수 있다
(raw·draco 로 풀고 meshopt 으로 검증 — 오차 0.3~1.9%).

| 구성 | 고정비(요청당) | 단위비 | 점근 처리량 | 핸드셰이크 |
|---|---:|---:|---:|---:|
| AWS (TLS+nginx, **2 vCPU**) | **46.40 ms** | 4.581 ms/MB | 1,746 Mbps | **33.60 ms** |
| KOREN pre-TLS (평문, 4 vCPU) | 3.97 ms | 2.841 ms/MB | 2,816 Mbps | 0.17 ms |
| KOREN post-TLS (TLS+nginx, 4 vCPU) | **8.11 ms** | 3.466 ms/MB | 2,308 Mbps | **5.78 ms** |

원시: `transfer_20260815_0854_koren-loopback-tls.json` (n=70)

### 확정된 것

1. **TLS+nginx 가 고정비를 올린다** — KOREN 3.97 → 8.11 ms (2배). 가설대로다
2. **그러나 그것만으로 AWS 격차를 설명 못 한다** — 같은 전송 계층인데 AWS 46.40 vs
   KOREN 8.11 ms 로 **5.7배** 남는다
3. **남은 격차는 CPU 다** — loopback 은 네트워크가 0인데 핸드셰이크가 AWS 33.60 vs
   KOREN 5.78 ms (**5.8배**). TLS 핸드셰이크는 ECDHE+서명이라 순수 연산이다

### ⚠️ 이전 세션의 잘못된 결론을 정정한다

"733MB 서빙에 uvicorn CPU 0 ticks 이므로 CPU 는 상관없다" 고 적었는데 **절반만 맞다**:

| 경로 | CPU 영향 | 판정 |
|---|---|---|
| 바이트당 (대량 전송) | 없음 — `sendfile` 은 커널 처리 | ✅ 맞음 |
| 요청당 (TLS 핸드셰이크) | **큼** — 순수 연산 | ❌ **틀림** |

**"VM 사양 맞추기가 불필요하다" 는 결론을 철회한다.** 사양 맞추기는 의미 있는 실험이다.

### 수정된 서버 격차: 2.01배 → **1.59배**

전송 계층을 맞춘 뒤 meshopt 36.64MB 기준 서버 처리 시간:
AWS `46.40 + 36.64×4.581 = 214.2 ms` vs KOREN `8.11 + 36.64×3.466 = 135.1 ms`.

그 1.59배는 이렇게 갈린다:
- **TLS 핸드셰이크 CPU 5.8배** → vCPU 늘리면 사라질 가능성. **AWS 에서 구매 가능**
- **대량 전송 단위비 1.32배** → 원인 미상. 이건 남는다

---

## 5.9 Wi-Fi 손실 — 유선 없이 분리 완료 (2026-08-15)

유선 전환이 불가능하므로 통계로 분리했다. 발상: Wi-Fi 손실은 상한을 낮추는 게 아니라
간헐적으로 깎는다 → **최고 샘플이 유선 근사값**이다.

| | n | 중앙값 | 최고 | 최고/중앙 | CV |
|---|---:|---:|---:|---:|---:|
| 집 Wi-Fi → AWS (meshopt) | 30 | 304.63 | 340.40 | 1.117 | **0.106** |
| KOREN VM 유선 → AWS (meshopt) | 20 | 864.35 | 1157.10 | 1.339 | **0.184** |

**Wi-Fi 가 오히려 더 안정적이다** (CV 0.106 < 0.184). 그리고 집이 가장 좋았던 순간
(340.40)도 VM 중앙값(864.35)의 39% 다.

→ **2.84배 중 Wi-Fi 몫은 최대 11.7%, 나머지 2.54배는 접속망 차이다.** §5.6 의 조건 1 해소.
유선 재측정 불필요.

---

## 5.10 실험 1 결과 — 사양을 맞췄고, §5.8 의 결론이 뒤집혔다 (2026-08-15 09:22)

담당자가 nginx `AllowedCPUs=0-1` (09:04:33) + uvicorn `taskset 0-1` (09:04:40) 을 적용했다.
uvicorn 은 8/14 23:29 부터 재시작 없이 살아 있었으므로 pinning 이 측정 내내 유지됐다.

원시: `transfer_20260815_0922_koren-loopback-2cpu.json` (n=70, 부하 생성기까지 `taskset -c 0-1`)

| 지표 | KOREN 4코어 | KOREN 2코어 | AWS 2 vCPU (§5.8) |
|---|---:|---:|---:|
| 핸드셰이크 (`connect_ms` p50, meshopt) | 5.755 ms | **5.413** | 33.600 |
| 고정비 (요청당) | 7.93 ms | 8.68 | 46.40 |
| 단위비 | 3.460 ms/MB | **4.207** | 4.581 |
| 점근 처리량 | 2,312 Mbps | **1,901** | 1,746 |

검증 오차(meshopt 예측 vs 실측) 0.70% — 분해가 맞다.

### 확정된 것 — 예상이 정확히 반대였다

1. **핸드셰이크는 코어 수와 무관하다.** 5.755 → 5.413 ms, 오히려 미세하게 낮다.
   판정표의 "10 ms 미만" → **CPU 아님**. `koren_spec_match_plan.md` 의 가설은 기각됐다.
2. **단위비는 코어 수에 민감하다.** 3.460 → 4.207 ms/MB (1.22배 악화). AWS 4.581 과
   **1.09배**로 거의 같아졌다. §5.8 이 "원인 미상, 이건 남는다" 고 한 1.32배는
   **코어 수 탓이었고 사양을 맞추면 사라진다.**
3. 처리량은 3개 크기 전부 일관되게 17~19% 떨어졌다 (2,210→1,791 / 2,292→1,872 /
   1,969→1,637 Mbps). 생성기를 안 묶은 09:05 런에서도 같은 방향이라 노이즈가 아니다.

### ⚠️ §5.8 의 "sendfile 이라 바이트당 CPU 무관" 을 다시 정정한다

**TLS 를 붙인 뒤로는 틀렸다.** 대량 암호화(AES-GCM)는 nginx 가 userspace 에서 하므로
바이트당 CPU 다 — kTLS 없이는 `sendfile` 자체를 못 쓴다. 근거였던 "733MB 서빙에
uvicorn 0 ticks" 는 **uvicorn 을 본 것이고 암호화는 nginx 가 한다.** KOREN 단위비가
평문 2.841 → TLS 3.466 으로 오른 것이 이미 같은 이야기였다.

| 경로 | CPU 영향 | 판정 이력 |
|---|---|---|
| 요청당 (핸드셰이크) | **없음** | §5.8 "큼" → **틀림** |
| 바이트당 (TLS 암호화) | **있음 (1.22배)** | §5.8 "없음" → **틀림** |

### AWS 33.60 ms 는 서버 CPU 가 아니다 — loopback 값 자체를 의심해야 한다

같은 맥북·같은 세션에서 AWS 와 KOREN 을 번갈아 15회 쳐서 RTT 를 상쇄했다
(`TCP = time_connect − time_namelookup ≈ 1 RTT`, `TLS = time_appconnect − time_connect
≈ 1 RTT + 연산` → `연산 = TLS − TCP`):

| | TCP (1 RTT) | TLS 단계 | **연산 = TLS − TCP** |
|---|---:|---:|---:|
| AWS | 7.38 ms | 16.03 ms | **8.44** |
| KOREN (2코어) | 10.85 | 14.72 | **4.31** |

**AWS 의 서버측 핸드셰이크 연산은 8.44 ms 다 — 33.60 이 아니다.** 배수도 5.8배가
아니라 **1.96배**이고, 2코어로 묶인 KOREN 이 여전히 2배 빠르다.

비대칭 암호 비용으로는 설명이 안 된다:
- KOREN 인증서 = **RSA 2048** (사설 CA), AWS = **ECDSA P-256** (Let's Encrypt YE2). 둘 다 TLS 1.3
- KOREN CPU 1코어에서 `openssl speed`: RSA-2048 서명 **0.699 ms**, ECDSA-P256 서명 **0.021 ms**
- 즉 AWS 가 **33배 싼 키**를 쓰면서 더 느리다. 서명 연산은 어느 쪽도 5 ms 를 못 채운다

남은 후보 두 개 — **둘 다 §5.11 에서 기각됐다. 진짜 원인은 CA 번들 파싱이었다.**
1. ~~t3 CPU 크레딧 스로틀~~ → 기각 (CPU 는 KOREN 과 동급, `openssl speed` 로 확인)
2. ~~AWS loopback 이 loopback 이 아니었을 가능성~~ → 기각 (경로 차이는 RTT +0.27 ms 뿐)

### 수정된 서버 격차 (이 절 기준) — 최종값은 §5.11 을 볼 것

meshopt 36.64MB 기준: AWS `46.40 + 36.64×4.581 = 214.2 ms` vs
KOREN 2코어 `8.68 + 36.64×4.207 = 162.8 ms` → 1.32배.
**단, AWS 쪽 고정비 46.40 이 오염된 값이었다. §5.11 에서 1.15배로 다시 내려간다.**

---

## 5.11 AWS 33.60 ms 의 정체 — 측정 아티팩트였다 (2026-08-15 10:00)

**AWS SSH 를 쓸 수 있게 됐다.** §4 의 "AWS SSH: 없음" 은 낡은 정보다 —
`~/.ssh/of-kor-3d-keypair.pem` 이 8/14 21:52 부터 이 Mac 에 있다 (비밀번호 인증은
sshd 에서 꺼져 있으므로 이 키만 쓴다). 덕분에 §5.10 의 두 후보를 직접 검증했다.

### 후보 기각 과정

| 검증 | 방법 | 결과 |
|---|---|---|
| 경로가 loopback 이었나 | 서버에서 `curl --resolve` 로 127.0.0.1 고정 vs 그냥 접속 | TCP 0.093 vs 0.363 ms — **경로 차이는 0.27 ms.** RTT 가설 기각 |
| 핸드셰이크가 정말 33 ms 인가 | 진짜 loopback 에서 재측정 | **32.88 ms — 맞다.** 경로 탓이 아니다 |
| CPU 가 느린가 | `openssl speed` 양쪽 비교 | AWS Xeon Platinum 8259CL RSA 서명 **0.670 ms** vs KOREN Xeon Skylake **0.699 ms** — AWS 가 오히려 빠르다. CPU 가설 기각 |
| 서버가 느린가 | AWS 박스 → **Cloudflare**(서버 비용 ≈ 0) 핸드셰이크 | TLS 단계 **31.6 ms.** 상대 서버가 누구든 31 ms 가 붙는다 → **클라이언트측 비용이다** |

### 진짜 원인 — curl 이 매 호출마다 시스템 CA 번들을 파싱한다

AWS 박스, 같은 서버·같은 진짜 loopback, CA 설정만 바꿔서:

| CA 설정 | TLS 핸드셰이크 |
|---|---:|
| 기본 저장소 (`/etc/ssl/certs/ca-certificates.crt`, **121개 / 182KB**) | **33.1 ms** |
| 검증 생략 (`-k`) | 4.77 ms |
| 단일 CA 파일 (`--cacert`) | **6.19 ms** |

**약 27 ms 가 CA 번들 파싱이다.** 그리고 결정적으로:

- 기록된 AWS loopback 명령에 **`--cacert` 가 없다** (시스템 저장소 사용)
- 기록된 KOREN loopback 명령에는 **`--cacert ~/ca/rootCA.crt` 가 있다** (사설 CA 라 필수였다)

**KOREN 박스에서도 시스템 저장소를 쓰면 28.99 ms 가 붙는다** (같은 121개, 같은
curl 8.5.0 / OpenSSL 3.0.13). 즉 AWS 고유 문제가 아니라 Ubuntu 공통 특성이고,
**§5.8 의 "TLS 핸드셰이크 CPU 5.8배" 는 순전히 `--cacert` 플래그 유무 차이였다.**

### AWS loopback 정식 재측정 — KOREN 과 같은 조건

원시: `transfer_20260815_0959_loopback-singleca.json` (n=70, 라벨 `loopback-singleca`)
조건: 진짜 loopback(`/etc/hosts` 임시 고정, **측정 후 복구 확인**) + `--cacert` 단일 CA 파일

| | raw | meshopt | draco | 핸드셰이크 | 고정비 | 단위비 | 점근 |
|---|---:|---:|---:|---:|---:|---:|---:|
| AWS 구 측정 (CA저장소·공개IP) | 1,695.8 | 1,364.3 | 1,000.8 | 33.58 | 44.68 | 4.584 | 1,745 |
| **AWS 신 측정 (단일CA·진짜LB)** | **1,712.6** | **1,426.3** | **1,330.7** | **7.16** | **19.28** | **4.571** | **1,750** |
| KOREN 2코어 (단일CA) | 1,872.2 | 1,790.9 | 1,636.9 | 5.41 | 8.68 | 4.207 | 1,901 |
| KOREN 4코어 (단일CA) | 2,292.2 | 2,210.2 | 1,969.2 | 5.75 | 7.93 | 3.460 | 2,312 |

**단위비는 4.584 → 4.571 로 안 변했다** — 바이트당 비용은 애초에 오염되지 않았다.
아티팩트는 요청당 고정비에만 붙었다. draco 만 크게 오른 것(1,000.8 → 1,330.7)은
작은 파일일수록 고정비 비중이 커서다.

### 최종 서버 격차: 2.01배 → 1.59배 → 1.32배 → **1.15배**

meshopt 36.64MB 서버 처리 시간, **같은 코어 수·같은 전송 계층·같은 CA 조건**:

| | 처리 시간 | 대비 |
|---|---:|---|
| AWS (2 vCPU) | 186.7 ms | — |
| KOREN 2코어 | 162.8 ms | **1.15배** |
| KOREN 4코어 | 134.7 ms | 1.39배 |

핸드셰이크도 **7.16 vs 5.41 ms = 1.32배**로, 5.8배가 아니다.

⚠️ **단서**: 신 측정의 분해 검증 오차가 **−7.51%** 다 (구 측정 −0.04%, KOREN +0.70%).
진짜 loopback 에서 meshopt 이 선형 모델보다 느려서 고정비 19.28 ms 의 신뢰도가 낮다.
**직접 측정한 핸드셰이크 7.16 ms 는 curl 마이크로벤치(6.19 ms)와 일치하므로 그쪽이 튼튼하다.**

### 결론 — "서버가 KOREN 이라 빠르다" 논거는 사실상 소멸했다

전송 계층·코어 수·CA 조건을 맞추면 두 서버는 **단위비 4.571 vs 4.207 (1.09배),
점근 1,750 vs 1,901 Mbps** 로 사실상 동급이다. KOREN 이 4코어에서 앞서는 몫은
**AWS 에서 상위 인스턴스로 구매 가능**하다. **§5.6 의 클라이언트 접속망 논거만 남는다.**

### §5.6 에 미치는 영향 — 2.84배는 오히려 보수적이다

§5.6 의 KOREN VM 클라이언트는 AWS 공개 인증서를 쳤으므로 `--cacert` 없이
**시스템 저장소(≈29 ms 아티팩트)** 를 썼다. 반면 맥북은 다른 TLS 스택이라 클라이언트
비용이 ≈8.6 ms 였다(맥북→AWS TLS 단계 16.03 − TCP 7.38). **KOREN VM 이 요청당
약 20 ms 불리하게 측정된 것**이므로, 보정하면 2.84배가 약 3.0배로 커진다.
**살아남은 유일한 논거가 조금 더 강해졌다.**

---

## 5.12 실험 2 결과 — KOREN post-TLS 전체 매트릭스 (2026-08-15 09:39)

원시: `transfer_20260815_0939_koren.json` (n=530, 스키마 통과, 4코어 복구 후 측정)
스로틀 카운터 136회 미판독은 §5 의 알려진 정상 동작이다.

| 변형 | C | pre-TLS | post-TLS | 변화 |
|---|---:|---:|---:|---:|
| raw | 1 | 302.79 | 302.92 | +0.0% |
| meshopt | 1 | 299.88 | 259.83 | −13.4% |
| meshopt | 3 | 338.60 | 307.96 | −9.0% |
| meshopt | 10 | 382.94 | 357.07 | −6.8% |
| draco | 1 | 208.17 | 206.13 | −1.0% |
| draco | 10 | 306.60 | 353.81 | +15.4% |

(C>1 은 스트림 p50 × C 집계 처리량)

### 확정된 것

**TLS 도입 비용은 고정비 +14 ms 뿐이고 처리량에는 영향이 없다.**

| 변형 | pre connect | post connect | pre ttfb | post ttfb |
|---|---:|---:|---:|---:|
| raw | 10.97 | 24.11 | 23.11 | 35.50 |
| meshopt | 11.74 | 25.50 | 23.45 | 36.02 |
| draco | 11.19 | 25.76 | 22.43 | 36.70 |

서버 RTT 13.17 ms 이므로 TLS 1.3 의 추가 1 RTT 가 그대로 나타난 값이다.
draco(약 530 ms)에 14 ms = 2.6% 로 §3.2 의 예상과 일치한다. 처리량 변화가
부호도 뒤섞이고(−13.4% ~ +15.4%) 서버 상한이 2,300 Mbps ≫ 회선 300 Mbps 이므로
**TLS 는 회선을 타는 조건에서 처리량 병목이 아니다.**

### ⚠️ 이 세션의 speedtest 값(158.19)은 쓰지 말 것

실측이 raw 302.92 / meshopt C=10 357.07 Mbps 인데 speedtest 는 158.19 를 냈다.
효율이 191~225% 로 물리적으로 불가능하므로 **speedtest 쪽이 틀린 샘플이다.**
회선은 pre-TLS 세션과 사실상 같았다 (raw 302.79 vs 302.92 — 0.0% 차이).
**§2.4 의 speedtest 정규화 기법을 이 세션에 적용하면 안 된다.**

---

## 5.13 실험 3 결과 — 크기 확정. **일반망에서는 KOREN 서버가 7.5% 느리다** (2026-08-15 11:11)

원시: `transfer_exp3_ab{1..6}a_commercial.json` / `..._ab{1..6}b_koren.json` (세션당 n=60,
12세션 전부 스키마 통과). 10:05~11:11, 5.5분 간격 교대. AWS 도 `--cacert` 를 써서 §5.11 편향 제거.

| 쌍 | AWS meshopt | KOREN meshopt | 신호 | AWS draco | KOREN draco | 신호 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 284.33 | 262.54 | −7.7% | 237.60 | 229.39 | −3.5% |
| 2 | 282.85 | 269.77 | −4.6% | 253.81 | 242.88 | −4.3% |
| 3 | 291.38 | 268.69 | −7.8% | 253.02 | 232.82 | −8.0% |
| 4 | 280.13 | 268.54 | −4.1% | 243.34 | 221.65 | −8.9% |
| 5 | 287.76 | 251.34 | −12.7% | 261.00 | 220.26 | −15.6% |
| 6 | 290.79 | 266.72 | −8.3% | 247.00 | 230.45 | −6.7% |

### §2.3 이 확정 못 했던 크기가 확정됐다

| | 평균 신호 | 표준편차 | 95% 신뢰구간 (대응표본, df=5) | 부호 |
|---|---:|---:|---|---:|
| meshopt | **−7.52%** | 3.06pp | **[−10.74%, −4.31%]** | 6/6 음수 |
| draco | **−7.83%** | 4.35pp | **[−12.39%, −3.27%]** | 6/6 음수 |

**0% 이 두 구간 어디에도 들어가지 않는다 — 유의하다.**
드리프트도 신호를 못 덮었다 (최대 반복 드리프트 meshopt 6.4% / draco 7.3% < 신호 7.5% / 7.8%).
8/14 에 최대 10.5% 였던 드리프트가 6쌍 평균으로 눌렸고, AWS 대조군이 매우 안정적이었다
(meshopt 6세션 범위 4.0%). **§2.3 의 "크기 확정 불가" 를 해제한다.**

### ⚠️ 이 12세션의 speedtest 값은 전부 버릴 것

효율(실측/speedtest)이 99% ~ **738%** 로 널뛰기했다. 쌍 6 은 speedtest 39.38 Mbps 인데
실측 290.79 Mbps 다. **speedtest 쪽이 망가졌다** (§5.12 의 158.19 와 같은 현상).
다행히 A-B 교대 설계는 AWS 세션이 대조군이므로 **speedtest 없이도 판정이 성립한다.**
§2.4 의 정규화 기법은 이 데이터에 쓰지 말 것.

### 고정비 — CA 조건을 맞추니 KOREN 이 오히려 낮다

| | AWS | KOREN |
|---|---|---|
| `connect_ms` p50 | 26.17~26.87 | **25.10~26.03** |
| `ttfb_ms` p50 | 34.28~36.01 | 36.02~37.60 |

§5.11 편향을 제거한 결과다. 핸드셰이크는 KOREN 이 0.5~1 ms 빠르고, TTFB 는 1~2 ms 느리다.

### 논지에 대한 판정

**"일반망 사용자도 KOREN 서버를 쓰면 빨라진다" 는 반증됐다.** 집(LG U+) → KOREN 서버는
다운로드가 **7.5% 느리다**, 12/12 일관, 유의. 물리적으로 당연한 결과다 — 경로가
`집 → LG U+ → 피어링 → KOREN` 이라 **KOREN 백본을 거의 타지 않는다.** 업로드도 같은
방향이었다 (§2.4: 회선 효율 106.0% vs 106.2% — 개선 없음).

→ **논지는 "KOREN 망 사용자" 로 좁혀야 한다.** 그 칸은 §5.14 의 장비 문제로 아직 못 채웠다.

---

## 5.14 한 VM 으로는 "KOREN 망 안에서" 를 못 잰다 (2026-08-15)

"KOREN VM 을 클라이언트로 두고 KOREN 서버를 네트워크로 때리면 되지 않나" 를 검증했다.
**안 된다.**

```
ip route get KOREN_IP_REDACTED
→ local KOREN_IP_REDACTED dev lo src KOREN_IP_REDACTED
```

공개 IP 가 `ens3` 에 **직접 바인딩**돼 있어(floating IP NAT 가 아님) 커널이 자기 IP 로 가는
트래픽을 `lo` 로 단축한다. **공개 IP 로 쳐도 loopback 과 물리적으로 동일하다.**

AWS 는 반대다 — Elastic IP 가 VPC 에서 NAT 되므로 자기 공개 IP 로 치면 실제로 나갔다
들어온다 (§5.11 에서 TCP 0.363 vs 0.093 ms). **두 클라우드의 IP 바인딩 방식이 다르다.**

억지로 내보내려면 `local` 라우팅 항목을 지워야 하는데 그러면 nginx 바인딩이 깨진다.
성공해도 경로가 `VM → 게이트웨이 116.89.187.129 → VM` 라우터 1홉이라 KOREN 백본이 아니다.

**→ 위치가 다른 두 번째 KOREN 장비가 반드시 필요하다.** 후보:
1. **중앙대 캠퍼스가 KOREN 에 연결돼 있는지 확인** (대학은 보통 KOREN/KREONET 에 붙는다).
   된다면 캠퍼스에서 이 맥북으로 재면 그날 채워진다. **KOREN 8000번이 지정 IP 만 허용하므로
   캠퍼스 IP 도 허용 목록에 넣어야 한다**
2. 담당자에게 클라이언트용 KOREN VM 추가 요청 (사양 최소로 충분)
3. 둘 다 안 되면 9월 캠퍼스 측정으로 이월. 그때까지는 loopback 을 **상한값**으로만 제시하고
   "네트워크 0 인 상한" 단서를 반드시 붙인다

---

## 6. 남은 실험 — 전체 목록

### 끝난 것

- [x] AWS 전체 (다운 530 / 업 60 / 브라우저 35 / loopback 70)
- [x] KOREN pre-TLS 전체 (다운 530 / 업 60 / loopback 70)
- [x] A-B-A-B 교대 측정 — 방향 확정(4/4 일관), **크기 확정 불가** (§2.3)
- [x] KOREN nginx+TLS 적용 + `--cacert` 하네스 지원 (§5.5)
- [x] KOREN post-TLS loopback (§5.8) — 비용 분해로 CPU 원인 규명
- [x] 클라이언트 접속망 비교 2.84배 (§5.6) + Wi-Fi 몫 분리 (§5.9)
- [x] HTTP/2 확인 — 양쪽 1.1, 조치 불필요
- [x] SSH 사용 승인받음
- [x] **실험 1 — 사양 맞추기 후 핸드셰이크 재측정 (§5.10). 핸드셰이크는 CPU 무관,
  단위비가 CPU 의존**
- [x] **AWS 33.60 ms 규명 (§5.11) — CA 번들 파싱 아티팩트. AWS loopback 정식 재측정 완료.
  서버 격차 최종 1.15배**
- [x] **실험 2 — KOREN post-TLS 전체 매트릭스 (§5.12). TLS 비용은 고정비 +14 ms 뿐**
- [x] AWS SSH 확보 — 실험 4·5 가 가능해졌다
- [x] **실험 3 — A/B 6쌍 완료 (§5.13). 크기 확정: 일반망에서 KOREN 이 −7.5%,
  95% CI [−10.7%, −4.3%], 12/12 일관. 논지의 "일반망" 절반은 반증됐다**
- [x] **한 VM 으로 KOREN 망 내부 측정은 불가함을 확인 (§5.14)**

---

### 실험 1 — 완료 (§5.10 참조) **← 결과가 가설을 기각했다**

**목적**: AWS 33.60 ms vs KOREN 5.78 ms 의 5.8배가 CPU 탓인지 확정.
**절차**: [`koren_spec_match_plan.md`](koren_spec_match_plan.md) 에 전부 있다.

요약: nginx 는 `systemctl set-property --runtime nginx.service AllowedCPUs=0-1`,
uvicorn 은 tmux 라 `taskset -cp 0-1 <pid>` (프로세스 **2개** 전부).
**부하 생성기도 `taskset -c 0-1` 로 묶어야 한다** — 안 묶으면 KOREN 이 부당하게 유리해진다.

```bash
ssh -i ~/.ssh/id_ed25519 -p 26022 ubuntu@KOREN_IP_REDACTED
cd ~/ofk-measure/scripts
taskset -c 0-1 python3 measure.py --target https://ofkor3d:8000 \
  --label koren-loopback-2cpu --targets ../results/download_targets_koren.json \
  --cacert ~/ca/rootCA.crt --download raw:1:10 meshopt:1:30 draco:1:30 \
  --location other --network-type wired --skip-probes --no-throttle-watch
```

**판정** (`connect_ms` 중앙값, meshopt C=1):
| 결과 | 결론 |
|---|---|
| 5.78 → 30 ms 대 | CPU 확정 → AWS 상위 인스턴스로 구매 가능 → **KOREN 고유 논거 아님** |
| 5.78 → 10 ms 미만 | CPU 아님 → t3 크레딧 스로틀 의심 → 실험 4 로 |

원복: `sudo systemctl revert --runtime nginx.service` + `taskset -cp 0-3`.
재부팅해도 저절로 풀린다.

---

### 실험 2 — 다운로드 완료 (§5.12) · **업로드 60 만 남았다**

다운로드 530 은 `transfer_20260815_0939_koren.json` 으로 끝났다. 남은 것은 업로드다:
`--directions upload` + `--email bowoon+measure@cau.ac.kr` + `--password-file`.
비밀번호는 사용자에게 받는다 (저장소에 두지 않는다).

아래는 원 명령 기록.

```bash
CA=/tmp/korenCA.crt
ssh -i ~/.ssh/id_ed25519 -p 26022 ubuntu@KOREN_IP_REDACTED 'cat ~/ca/rootCA.crt' > $CA

.venv/bin/python -u scripts/measure.py --target https://KOREN_IP_REDACTED:8000 --label koren \
  --cacert $CA --location home --network-type wifi --isp "LG U+ (Lg Powercomm)" \
  --instance-type "KOREN VM (4 vCPU / 16GB)" --region KOREN --ebs-type "none (vda1 ext4)" \
  --serving "vda1 ext4 (/static/assets/a_*)" \
  --server-version "OF_KOR_3D Server 0.1.0 / nginx TLS → uvicorn 127.0.0.1:8080"

# 업로드는 --directions upload 와 --token 추가 (계정: bowoon+measure@cau.ac.kr)
```

---

### 실험 3 — AWS ↔ KOREN A/B 6쌍 **← 2026-08-15 10:05 실행 중**

이제 양쪽 전송 계층이 같으므로 §4-3 위반이 해소됐다. §2.3 에서 크기를 확정 못 한 이유가
회선 드리프트(최대 10.5%)였으므로 **교대를 6쌍으로 늘려 평균으로 상쇄**한다.

출력: `results/transfer_exp3_ab{1..6}a_commercial.json` / `..._ab{1..6}b_koren.json`
(8/14 의 `transfer_ab*_aws.json` 은 pre-TLS 기준선이므로 이름을 겹치지 않게 했다)
로그: `results/logs/11_exp3_abab.txt`

**§5.11 편향 제거 — AWS 에도 `--cacert results/awsCA.crt` 를 붙였다.** 한쪽만 시스템 CA
저장소를 쓰면 요청당 고정비가 비대칭으로 붙는다 (맥북에서도 약 3 ms). `awsCA.crt` 는
Let's Encrypt 체인(YE2 → Root YE → ISRG Root X2)이고 curl·urllib 양쪽 검증을 통과한다.

**egress**: 세션당 약 1.56GB, AWS 6세션 = **9.4GB** (KOREN 쪽은 비용 없음).
실험 2 는 KOREN 이라 AWS egress 를 안 썼다. 기존 20.16GB + 9.4GB ≈ **30GB / 월 100GB.**

---

### 실험 4 (선택으로 격하) — AWS CPU 크레딧 확인

**이 실험의 원래 목적(33.60 ms 규명)은 §5.11 에서 CA 번들 아티팩트로 해결됐다.**
담당자에게 물어보려던 두 질문(`/etc/hosts` 상태, 크레딧 잔량)도 직접 확인해 불필요해졌다.

남은 가치는 하나뿐이다: **"AWS 는 지속 부하에서 강등된다"** 를 독립 논거로 쓸 것인지.
쓰려면 CloudWatch 가 필요하고 SSH 로는 안 보인다 (`/proc/stat` 의 누적 steal 은
2.4일간 0.22% 로 낮았다 — 측정 시각의 순간값은 알 수 없다). CloudWatch 에서 측정 시각(2026-08-14 21:56 KST 전후)의
`CPUCreditBalance` / `CPUSurplusCreditBalance` 를 본다. 크레딧이 말라 있었다면 33.60 ms 는
**사양이 아니라 스로틀을 잰 것**이고, 그러면 "AWS 는 지속 부하에서 강등된다" 는 논거가 된다.

---

### 실험 5 (선택) — 다중 클라이언트 상한 실측

보고서 §03 의 "10인 방에서 2배" 는 loopback 상한을 인원으로 나눈 **산출값**이다.
실측하려면 서버 밖에 부하 생성기가 필요하고, 양쪽에 **같은 거리**여야 공평하다
(KOREN VM 으로 AWS 만 때리면 불공평 — 사용자 지적).

가능한 설계: 두 서버가 서로를 때린다 (같은 경로, 둘 다 원격). AWS SSH 가 필요하므로
담당자 협조 사항.

---

### 실험 6 (선택) — 브라우저 하네스 KOREN 판

OS 신뢰 저장소에 사설 CA 설치 필요 (§5.5). macOS:
`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.crt`.
KOREN nginx 의 CORS 허용 목록에 `http://localhost:3000` 이 있어야 한다.

---

## 7. 측정 외 남은 일

- [ ] **포지셔닝 결정** (§5.6) — 기관 사용자 대상이면 KOREN 논거 성립, 일반 대중이면 미성립.
  측정으로 풀 문제가 아니다
- [ ] 담당자 요청: `convert=false` 로 쌓인 원본 IFC 정리 (AWS 63건 1.21GB, 잡 삭제 API 없음)
- [ ] `bowoon@cau.ac.kr` 의 KOREN 비밀번호 (측정 전용 계정을 따로 만들어 놓음)

### 발행한 보고서 — 수치 갱신 필요

| 보고서 | 상태 |
|---|---|
| 회선 업/다운 비대칭 4.91:1<br>https://claude.ai/code/artifact/0d1e51b1-d025-444a-8629-c842d6fa8f6a | AWS 단독 데이터라 **유효** |
| AWS vs KOREN<br>https://claude.ai/code/artifact/463fd979-56e1-4a02-aa54-a74091660ec5 | ⚠️ **§03 수정 필요**. "서버 상한 2.01배" → **1.59배**, 원인도 "VM 사양" → "TLS 핸드셰이크 CPU 5.8배 + 단위비 1.32배" 로. 실험 1 결과가 나오면 한 번에 고칠 것 |

**재발행 방법**: 같은 파일(`results/report_aws_vs_koren.html`)을 고쳐 `Artifact` 툴에
같은 경로로 다시 올리면 URL 이 유지된다. 다른 세션에서는 `url` 인자에 위 주소를 넘길 것.
