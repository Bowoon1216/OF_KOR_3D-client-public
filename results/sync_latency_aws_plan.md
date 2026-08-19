# 상태 동기화 지연 측정 — AWS 실행 계획 (KOREN 대조)

`tools.loadgen` 으로 2026-08-14 KOREN VM 에서 잰 값과 **비교 가능한** AWS 측정을 하기 위한
절차와 기록 서식이다. 에셋 전송 측정([`transfer_run_journal.md`](transfer_run_journal.md))과는
다른 축이다 — 저건 파일 전송 처리량, 이건 실시간 상태 동기화 지연이다.

> 대기 중인 **다른** 측정이 둘 더 있다. 도구·지표·대상이 전부 다르므로 **한 세션으로 묶지 말고
> 따로 돌린다** — 동시에 돌리면 서로가 서로의 CPU·대역 부하가 되어 양쪽 값이 다 못 쓰게 된다.
>
> - 서버 처리 상한 (EC2 내부 loopback) → [`transfer_loopback_plan.md`](transfer_loopback_plan.md)
> - 경합 하 체감 (전송 부하 + 동기화 동시) → [`koren_bandwidth_plan.md`](koren_bandwidth_plan.md)
>
> 이 문서의 값은 그 세 번째 실험의 **무부하 기준선**으로 쓰인다. 단, 여기 기준선은 서버 내부
> loopback 이라 시계 보정 불확실도가 0.28 ms 다 — 클라이언트에서 잰 값과 절대값으로 비교하지
> 말고 부하 전후 Δ 로 비교한다.

비교의 유효성은 "설정이 같다" 가 아니라 **"같게 맞춘 것과 다를 수밖에 없는 것이 각각 무엇인지
기록되어 있다"** 에서 나온다. 전송 측정에서 tmpfs 서빙 여부를 추측으로 적었다가 정정한
일(§0)의 교훈이 그대로 적용된다: **확인할 수 없는 항목은 기본값을 사실처럼 적지 말고
`확인 필요` 로 둔다.**

---

## 1. KOREN 기준선 (동결 — 다시 계산하지 않는다)

### 실행

```bash
# VM 에서, uvicorn 이 떠 있는 상태로 새 SSH 창
cd ~/OF-KOR-3D-server && source venv/bin/activate
python -m tools.loadgen --clients 6 --rate 30 --duration 60 \
  --run-id 2026-08-14_vm_local_r6_01
```

방 6733-8169 · 클라이언트 6명 · 30.0Hz · 60.0초 · 실제 소요 62.4초

### 하네스 집계 (클라이언트 측 관측)

| 지표 | 값 |
|---|---:|
| 표본 / 송신 / 수신 | 10,260 / 1,800 / 10,800 |
| e2e p50 | 0.90 ms |
| e2e p95 | 1.38 ms |
| e2e p99 | 1.57 ms |
| e2e max | 3.15 ms |
| **100ms 초과 비율** | **0.00%** |
| p99−p50 (분산) | 0.66 ms |
| 지터 (중앙값) | 0.00 ms |
| RTT p50 | 0.76 ms |
| 시계 보정 불확실도 (중앙값) | 0.28 ms |
| 하네스 CPU | 2.3% |

### 서버 집계 (서버 측 관측)

| 구간 | n | p50 | p95 | p99 | min | max | mean | >target | p99−p50 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| e2e | 10,638 | 0.90 | 1.38 | 1.58 | 0.47 | 4.24 | 0.96 | 0.00% | 0.67 |
| rtt | 180 | 1.45 | 2.86 | 14.96 | 0.51 | 15.62 | 1.93 | 0.00% | 13.50 |
| relay | 1,798 | 0.00 | 0.01 | 0.02 | 0.00 | 0.08 | 0.00 | 0.00% | 0.02 |

(단위 ms. 원문 JSON 의 `p50Ms` 등을 그대로 옮겼다.)

### 이 기준선에서 이미 눈에 걸리는 것 — AWS 에서도 같은 방식으로 확인한다

| 관측 | 사실 | 해석 |
|---|---|---|
| e2e n: 하네스 10,260 vs 서버 10,638 | 378 차이 | 두 하네스가 표본을 세는 정의가 다르다. **확인 필요.** 두 수치를 한 표에 섞지 않는다 |
| 수신 10,800 vs e2e 표본 10,260 | 540 누락 (5.0%) | 540 = 90 송신 × 6 클라이언트 = 30Hz 기준 3초. 초기 구간 폐기로 **보이지만 추측이다.** `tools/loadgen` 코드로 확인할 것 |
| relay n 1,798 vs 송신 1,800 | 2 부족 | 마지막 프레임 절단으로 보인다. **확인 필요** |
| RTT p50: 하네스 0.76 vs 서버 1.45 | 약 2배 | 측정 지점이 다르다. 두 값은 서로의 검증이 아니다 |
| 서버 RTT p99 14.96 ms (p50 1.45) | 꼬리 10배 | n=180 이라 p99 는 상위 2개 표본이 결정한다. 추세가 아니라 **꼬리값**으로 취급 |
| relay p50 0.00 ms | 0 으로 출력 | "지연 없음" 이 아니라 **타이머 해상도 이하**다. 그렇게 쓴다 |

### KOREN 쪽에 아직 없는 기록

**아래 항목은 KOREN VM 에서 다시 캡처해야 비교표가 완성된다.** AWS 만 캡처하면 §4 표의
KOREN 열이 빈다.

- VM CPU 모델 · vCPU 수 · RAM · 커널
- Python / uvicorn / uvloop 버전, uvicorn 실행 인자 (워커 수, `--reload` 여부)
- 서버 코드 커밋 해시
- loadgen 이 nginx/TLS 를 경유했는지, uvicorn 에 직결했는지
- 측정 중 서버의 다른 부하 (IFC 변환 잡 등) 유무

---

## 2. 같게 맞추는 것 (고정 조건)

| # | 조건 | 값 | 왜 |
|---|---|---|---|
| 1 | 부하 파라미터 | `--clients 6 --rate 30 --duration 60` | 이것만 같아도 비교가 되는 게 아니지만, 다르면 비교가 아예 성립하지 않는다 |
| 2 | 하네스 실행 위치 | **EC2 인스턴스 내부** (loopback) | KOREN 이 VM 내부였다. 인터넷 경로를 빼고 서버 처리 시간만 비교하기 위함 |
| 3 | 경유 경로 | **uvicorn 직결. nginx·TLS 미경유** | KOREN 이 "uvicorn 이 떠 있는 상태" 에 붙었다. wss/nginx 를 끼우면 TLS 와 프록시 버퍼링이 함께 바뀐다 |
| 4 | 서버 코드 | KOREN 과 **동일 커밋** (`git rev-parse HEAD` 로 대조) | 서버 코드가 다르면 하드웨어 비교가 아니다 |
| 5 | uvicorn 실행 형태 | 워커 수 · 로그 레벨 · `--reload` 여부 동일 | 워커 2개는 하드웨어 개선처럼 보이는 다른 변수다 |
| 6 | 방 구성 | 방 1개에 클라이언트 6명 전원 | 방 2개로 3+3 이면 팬아웃이 절반이다 |
| 7 | 서버 유휴 상태 | IFC 변환 잡 0건, 다른 사용자 세션 0건 | 전송 측정 §9 가 변환 중 측정을 금지한 것과 같은 이유. t3.medium 2 vCPU 에서는 영향이 더 크다 |
| 8 | 워밍업 처리 | KOREN 과 동일하게 처리 | loadgen 이 내부적으로 초기 구간을 버리는지 §1 에서 미확정. **확정 전에는 KOREN 과 똑같이 "추가 워밍업 없이 1회"** 로 돌린다. 워밍업을 넣은 실행은 별도 run-id 로 남기고 섞지 않는다 |
| 9 | 반복 회차 | KOREN 이 `_01` 1회 → AWS 도 1회가 최소 조건 | 권장은 양쪽 3회(`_01`~`_03`)다. 1회끼리 비교하면 결과에 **"1회 측정"** 이라고 명시한다 |
| 10 | run-id 규칙 | `2026-08-14_aws_local_r6_01` | `<날짜>_<위치>_r<클라이언트수>_<회차>`. KOREN `vm_local` ↔ AWS `aws_local` |

**부하가 실제로 같게 걸렸는지는 파라미터가 아니라 송신·수신 카운트로 확인한다.**
AWS 결과의 `송신 1800 / 수신 10800` 이 KOREN 과 몇 % 이상 다르면 하네스가 목표 Hz 를
못 낸 것이고, 그 실행은 지연 비교에 쓸 수 없다.

---

## 3. 다를 수밖에 없는 것 (기록 대상)

같게 만들 수 없다. 기록해서 결론의 조건으로 붙인다.

두 호스트는 별개다. **KOREN VM** = `ubuntu@ofkor3d`, 레포 `~/OF-KOR-3D-server` (8/14 loadgen 을
여기서 돌렸다). **AWS EC2** = AWS_IP_REDACTED (`AWS_HOST_REDACTED`), 레포
`/data/OF-KOR-3D-server`. **AWS 쪽 SSH 접속 정보가 아직 없다** —
[`transfer_loopback_plan.md`](transfer_loopback_plan.md) §8-1 과 같은 항목이고, 한 번 받으면
두 측정에 함께 쓴다.

| 항목 | KOREN | AWS | 지연에 미치는 영향 |
|---|---|---|---|
| CPU 모델 / vCPU / 클럭 | 확인 필요 | t3.medium, 2 vCPU (버스터블) | e2e 의 주된 결정 요인 |
| RAM / 커널 / 배포판 | 확인 필요 | 확인 필요 | 스케줄러·타이머 해상도 |
| Python / uvicorn / uvloop | 확인 필요 | **python 3.12.3** (8/14 확인). uvicorn·uvloop 확인 필요 | uvloop 유무는 수백 µs 규모로 갈린다 |
| 가상화 / 이웃 부하 | 확인 필요 | Nitro, 공유 테넌시 | 꼬리 지연(p99, max)의 원인 |
| 리전 / 위치 | 확인 필요 | ap-northeast-2 | loopback 측정에서는 무관 |

### t3.medium 은 버스터블 — 이것이 이 측정의 최대 함정이다

CPU 크레딧이 소진되면 2 vCPU 가 베이스라인(t3.medium 기준 vCPU 당 20%)으로 스로틀된다.
그 상태에서 잰 지연은 **하드웨어 성능이 아니라 크레딧 잔량을 잰 것**이고, KOREN 대조 결론이
그대로 뒤집힐 수 있다.

- 측정 **전후로** `CPUCreditBalance` 를 기록한다 (CloudWatch. 그래프 캡처라도 남긴다)
- 크레딧 모드가 `standard` 인지 `unlimited` 인지 기록한다 — `unlimited` 면 스로틀 대신 과금이다
- 측정 직전 30분간 다른 작업(배포, 변환, 전송 측정)을 돌리지 않는다
- 크레딧이 낮으면 **측정을 미룬다.** 낮은 상태로 재고 각주로 변명하지 않는다

### 하네스 CPU 는 서버와 같은 코어를 쓴다

loopback 측정이므로 하네스가 서버 CPU 를 잠식한다. KOREN 에서 하네스 CPU 는 2.3% 였다.
2 vCPU 에서 이 비중이 크게 오르면 경합이 지연에 섞인다. **하네스 CPU 값을 반드시 옮겨 적고,
KOREN 대비 크게 다르면 비교 전에 원인을 밝힌다.**

시계 보정 불확실도(KOREN 0.28 ms)도 같이 본다. loopback 에서는 작아야 정상이고,
이 값이 커지면 e2e 자체의 신뢰도가 그만큼 떨어진다 — 0.28 ms 불확실도로 0.2 ms 차이를
논할 수 없다.

---

## 4. 실행 전 캡처 (KOREN·AWS 양쪽에서 같은 명령)

출력을 그대로 로그로 남긴다. AWS → `results/logs/10_env_aws.txt`,
KOREN → `results/logs/12_env_koren.txt`.

```bash
# 호스트
uname -a; nproc; free -m; uptime
lscpu | grep -E 'Model name|^CPU\(s\)|MHz|Hypervisor|Flags' | head

# 런타임
python -V
pip show uvicorn fastapi uvloop websockets 2>/dev/null | grep -E 'Name|Version'

# 서버 코드 리비전 — 양쪽이 같아야 한다
cd ~/OF-KOR-3D-server && git rev-parse HEAD && git status --porcelain

# uvicorn 이 어떻게 떠 있는지 (워커 수·reload·바인드 주소)
ps -eo pid,etime,pcpu,args | grep -i '[u]vicorn'
ss -ltnp | grep -E ':8000|:80|:443'

# 서버가 유휴한지 (§2-7)
curl -s localhost:8000/api/assets/jobs | head -c 400; echo

# loadgen 사용법 — 플래그를 추측하지 않기 위해 먼저 찍고 로그에 남긴다
python -m tools.loadgen --help
```

AWS 에서만 추가:

```bash
# 인스턴스 신원 (IMDSv2)
TOK=$(curl -sX PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
for k in instance-type placement/availability-zone; do
  curl -sH "X-aws-ec2-metadata-token: $TOK" \
    http://169.254.169.254/latest/meta-data/$k; echo
done

# CPU 크레딧 — 측정 전후 두 번. 권한이 없으면 콘솔 그래프를 캡처해 첨부
aws cloudwatch get-metric-statistics --namespace AWS/EC2 \
  --metric-name CPUCreditBalance --dimensions Name=InstanceId,Value=<i-…> \
  --start-time <ISO> --end-time <ISO> --period 300 --statistics Minimum
```

`aws` CLI 나 CloudWatch 권한이 EC2 에 없을 수 있다. 없으면 **없다고 적고 콘솔 값을 붙인다.**
`확인 필요` 로 남기는 것이 추정치를 적는 것보다 낫다.

---

## 5. 실행

```bash
# EC2 에서, uvicorn 이 떠 있는 상태로 새 SSH 창
cd ~/OF-KOR-3D-server && source venv/bin/activate
python -m tools.loadgen --clients 6 --rate 30 --duration 60 \
  --run-id 2026-08-14_aws_local_r6_01 \
  2>&1 | tee ~/loadgen_aws_local_r6_01.txt
```

- 파라미터는 §2-1 그대로. **바꾸지 않는다.**
- 출력 **전문**을 저장한다 — 하네스 블록과 `서버 집계:` JSON 이 모두 필요하다.
  KOREN 기준선도 이 출력이 원본이다.
- `--run-id` 만 바꾼다. 회차를 늘리면 `_02`, `_03`.
- 위 `tee` 파일을 `results/logs/11_loadgen_aws_local_r6_01.txt` 로 가져온다.
- loadgen 이 자체 결과 파일을 남기는지, 출력 경로 플래그가 있는지는 **§4 의 `--help` 출력으로
  확인한 뒤** 쓴다. 이 문서는 `--clients` / `--rate` / `--duration` / `--run-id` 외의 플래그를
  추측해 적지 않았다.

3회 돌릴 경우 사이에 60초 이상 간격을 둔다 (커널 소켓·CPU 크레딧 회복). 회차별 값을
평균하지 말고 §6 표에 회차를 나눠 적는다.

---

## 6. 결과 기록 서식

### 표 A — 하네스 집계

| 지표 | KOREN `vm_local_r6_01` | AWS `aws_local_r6_01` | 차이 |
|---|---:|---:|---:|
| 표본 / 송신 / 수신 | 10,260 / 1,800 / 10,800 | | |
| 실제 소요 (s) | 62.4 | | |
| e2e p50 (ms) | 0.90 | | |
| e2e p95 (ms) | 1.38 | | |
| e2e p99 (ms) | 1.57 | | |
| e2e max (ms) | 3.15 | | |
| 100ms 초과 비율 | 0.00% | | |
| p99−p50 (ms) | 0.66 | | |
| 지터 중앙값 (ms) | 0.00 | | |
| RTT p50 (ms) | 0.76 | | |
| 시계 보정 불확실도 (ms) | 0.28 | | |
| 하네스 CPU | 2.3% | | |

### 표 B — 서버 집계

| 구간 | 측정 | n | p50 | p95 | p99 | max | mean | >target | p99−p50 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| e2e | KOREN | 10,638 | 0.90 | 1.38 | 1.58 | 4.24 | 0.96 | 0.00% | 0.67 |
| e2e | AWS | | | | | | | | |
| rtt | KOREN | 180 | 1.45 | 2.86 | 14.96 | 15.62 | 1.93 | 0.00% | 13.50 |
| rtt | AWS | | | | | | | | |
| relay | KOREN | 1,798 | 0.00 | 0.01 | 0.02 | 0.08 | 0.00 | 0.00% | 0.02 |
| relay | AWS | | | | | | | | |

### 표 C — 조건 대조 (이 표가 비면 위 두 표는 비교표가 아니다)

| 항목 | KOREN | AWS |
|---|---|---|
| 인스턴스 / VM 사양 | | t3.medium (2 vCPU) |
| CPU 모델 | | |
| 커널 / 배포판 | | |
| Python / uvicorn / uvloop | | |
| 서버 커밋 | | |
| uvicorn 워커 수 · reload | | |
| 경유 경로 | uvicorn 직결 (확인 필요) | uvicorn 직결 |
| 측정 시각 (KST) | 2026-08-14 | |
| CPU 크레딧 (전 → 후) | 해당 없음 | |
| 서버 동시 부하 | | |

---

## 7. 판정 규칙 (숫자를 보기 전에 정한다)

1. **1차 지표는 e2e p95·p99 와 100ms 초과 비율.** p50 은 보조다 — 목표는 평균이 아니라 꼬리다.
2. **검증 통과 기준: 100ms 초과 비율 0.00%.** KOREN 은 통과했다. AWS 도 이 값으로 판정한다.
3. **차이를 "차이" 로 부를 최소 폭**: 시계 보정 불확실도(0.28 ms 수준)와 회차 간 변동 중
   큰 쪽보다 작으면 **"차이 없음"** 으로 쓴다. 1회 측정에서 p99 0.2 ms 차이를 개선이나
   악화로 쓰지 않는다. 두 환경 모두 1 ms 대이므로 이 규칙이 거의 모든 항목에 걸린다.
4. **백분위 규칙** (README 측정 원칙과 동일): `n<30` → p50 · `30≤n<100` → p50·p95 ·
   `n≥100` → p50·p95·p99. e2e(n≈10⁴)는 전부 낼 수 있고, rtt(n=180)의 p99 는 낼 수는 있으나
   상위 2개 표본이 결정하는 꼬리값이다.
5. **`relay p50 0.00 ms` 는 "0" 이 아니라 "타이머 해상도 이하"** 로 서술한다.
6. **하네스 수치와 서버 수치를 한 행에 합치지 않는다.** 전송 측정에서 `cli` 와 `browser` 를
   합치지 않은 것과 같은 이유다 (§3.4) — 측정 지점이 다르면 다른 값이 나오는 게 정상이고,
   합치면 둘 다 무의미해진다.
7. **결론의 범위**: 이 측정은 loopback 이므로 **서버 처리 + 호스트 CPU** 를 비교한 것이다.
   "KOREN 이 사용자 체감 지연에서 낫다/못하다" 는 이 데이터로 말할 수 없다.
   그건 클라이언트에서 실제 회선을 타는 별도 측정(§8)이 필요하다.

---

## 8. 하지 말 것

- **nginx/wss 경유 값과 uvicorn 직결 값을 같은 표에 넣기.** 두 조건이면 표를 나누고 조건을
  행 레이블에 적는다
- **크레딧이 소진된 t3 에서 잰 값으로 하드웨어 결론 내기** (§3)
- **변환 잡이나 다른 세션이 도는 중에 재기.** 전송 측정 §9 와 같은 금지 사항
- **ping RTT 로 서버 RTT 를 대체하기.** AWS 는 ICMP 를 차단한다 — 전송 측정에서 30발 전부
  손실로 이미 확인됐다(§3.5). loadgen 의 RTT 지표를 쓴다
- **회차 값을 평균해 한 줄로 만들기.** 회차를 남기고 폭을 보여준다
- **파라미터를 "AWS 가 느려서" 조정하기.** 조정하면 그건 다른 측정이고, 새 run-id 와 새 표가
  필요하다

---

## 9. 남은 확인 항목 (추측으로 채우지 않는다)

| # | 항목 | 확인 방법 |
|---|---|---|
| 1 | `tools.loadgen` 전체 플래그 · 결과 파일 경로 | `python -m tools.loadgen --help` (§4) |
| 2 | 하네스 e2e n(10,260)과 서버 e2e n(10,638)의 정의 차이 | 서버 담당자 / `tools/loadgen` 코드 |
| 3 | 수신 10,800 → 표본 10,260 의 540 누락이 초기 구간 폐기인지 | 같음. 워밍업 처리(§2-8) 결정이 여기 걸려 있다 |
| 4 | KOREN 실행이 nginx 를 경유했는지 | 서버 담당자 |
| 5 | KOREN VM 사양 · Python/uvicorn 버전 · 서버 커밋 | KOREN VM 에서 §4 캡처 |
| 6 | t3.medium 크레딧 모드(standard/unlimited)와 잔량 | EC2 콘솔 / CloudWatch |
| 7 | `--rate 30` 이 클라이언트당인지 방 합계인지 | `--help` 또는 코드. 표 A 의 송신·수신 카운트 해석이 달라진다 |

1·2·3 은 AWS 를 재기 전에 확인하는 것이 좋다. 특히 3 이 미확정인 상태로 워밍업을 넣으면
KOREN 과 다른 조건이 되어 이 문서 전체의 전제가 깨진다.

---

## 10. 재현 명령 요약

```bash
# ── 양쪽에서 동일 ──────────────────────────────────────────
# 0) 환경 캡처 (§4) → results/logs/10_env_aws.txt / 12_env_koren.txt
# 1) loadgen 사용법 확인
python -m tools.loadgen --help

# 2) 측정 — AWS
cd ~/OF-KOR-3D-server && source venv/bin/activate
python -m tools.loadgen --clients 6 --rate 30 --duration 60 \
  --run-id 2026-08-14_aws_local_r6_01 2>&1 | tee ~/loadgen_aws_local_r6_01.txt

# 3) 측정 — KOREN (기준선 재현 / 3회 대조가 필요할 때)
python -m tools.loadgen --clients 6 --rate 30 --duration 60 \
  --run-id 2026-08-14_vm_local_r6_02 2>&1 | tee ~/loadgen_vm_local_r6_02.txt

# 4) 로그 회수 (로컬에서)
scp <host>:~/loadgen_aws_local_r6_01.txt results/logs/11_loadgen_aws_local_r6_01.txt
scp <host>:~/loadgen_vm_local_r6_02.txt   results/logs/13_loadgen_koren_local_r6_02.txt
```

기록은 §6 의 세 표에 채운다. **표 C 를 채우지 않은 표 A·B 는 발표에 쓰지 않는다** —
조건이 없는 숫자 두 줄은 비교가 아니다.
