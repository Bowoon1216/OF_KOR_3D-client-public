# 에셋 전송 loopback 상한 측정 — 실행 절차

> **✅ 2026-08-14 실행 완료.** 결과: raw 4.97 / meshopt 4.52 / draco 3.86배 → §11 기준 통과.
> 집계는 [`summary_20260814.md`](summary_20260814.md), 판정은
> [`transfer_run_journal.md`](transfer_run_journal.md) §3.1.
> 아래는 재현용 절차다 (9월 KOREN 에서 같은 측정을 할 때 그대로 쓴다).
>
> 실행 중 확인된 것 두 개: ① `ubuntu` 의 sudoers 가 `(ALL:ALL) ALL` + `(ALL) NOPASSWD: ALL`
> 이라 실제 명령은 무암호로 통과하지만 래퍼의 `sudo -v`(전체 검증)는 암호를 요구한다 →
> `ssh -tt` 로 TTY 를 붙여 암호를 넣었다. ② 계획서 §4-3 의 유휴 확인 명령
> (`curl localhost:8000/api/assets/jobs`)은 **인증이 필요해 401 을 낸다** — 래퍼가 SQLite 를
> 직접 읽어 `running`/`queued` 를 세는 방식이 맞다.

[`transfer_run_journal.md`](transfer_run_journal.md) §5 "남은 일" 의 첫 항목을 닫기 위한 절차.
**서버(EC2)에 SSH 로 들어가서 `measure.py` 를 돌린다.**

전송·지연 측정은 세 축이고 이건 그중 **서버 처리 상한**이다. 나머지 둘은
경합 하 체감([`koren_bandwidth_plan.md`](koren_bandwidth_plan.md))과
무부하 동기화 지연([`sync_latency_aws_plan.md`](sync_latency_aws_plan.md))이다.
아래 §1 에서 구분한다 — 세 측정을 같은 세션으로 착각하면 서로의 결론에 엉뚱한 근거가 붙는다.
**특히 이 측정은 네트워크를 일부러 뺀 것이라 업링크 대역의 근거로 쓸 수 없다.**

---

> **2026-08-14 서버 확인(`loopback_mac_handoff.md`)으로 네 군데가 바뀌었다.** 아래 §0-1 이 요약이고
> 본문(§4·§5·§7·§8)에 반영했다.

## 0-1. 서버 확인으로 바뀐 것

| # | 바뀐 것 | 근거 |
|---|---|---|
| 1 | **측정 경로는 tmpfs 가 아니라 EBS 다.** 8/13 상용 세션이 때린 것은 `a_*` 경로(EBS)이고, tmpfs `bench/` 는 8/12 검증 curl 11건뿐이었다. 두 경로의 파일은 바이트가 같다(md5 일치) | nginx 접근 로그 |
| 2 | **`/etc/hosts` 를 손으로 안 건드린다.** 서버 레포의 `tools/loopback_measure.sh` 가 플립·검증·유휴 확인·ENA 대조·복구를 trap 으로 처리한다 | 서버 레포, 전 구간 실행 확인 완료 |
| 3 | **결과를 "nginx 상한" 이라고 쓰지 않는다.** 정적 서빙은 nginx 가 아니라 백엔드(FastAPI `StaticFiles`)가 한다. nginx 설정은 `proxy_pass` 하나뿐이다. 재는 값은 **uvicorn + ASGI 미들웨어 + nginx 프록시의 합**이다 | 서버 설정 |
| 4 | **`--serving` 플래그를 빼면 안 된다.** `choices` 가 없는 자유 문자열이고 **`default="tmpfs"`** 다 — 빼면 정확히 피하려던 그 값이 박힌다. 명시적으로 넘긴다 | `measure.py:888` |

**tmpfs 기록은 두 번 틀렸다.** 세션 실행 시엔 `disk (…)` 로 적었고(추측), 8/13 에 담당자 확인으로
`tmpfs` 로 정정했는데(journal §0), 이번 로그가 **측정 경로는 EBS 였다**는 걸 보여줬다. 마운트가
존재하는 것과 측정이 그 경로를 탄 것은 다른 사실이다 — journal §0 의 교훈이 한 단계 더 필요했다.

---

## 0. 왜 필요한가

journal §3.1 은 "서버는 병목이 아니다" 라고 판정했지만, 그 근거는 **동시성을 10배 올려도 합계
처리량이 포화한다**(클라이언트 회선이 한계다)는 간접 증거였다. **서버의 절대 상한 수치는 모른다.**

그래서 계획 §11 이 지정한 판정식 — `loopback C=1 처리량 / commercial C=1 처리량 < 3` 이면 보고
대상 — 의 **분자를 아직 못 넣었다.** 이 측정이 그 빈칸이다. 채우면 §5 의 항목이 닫힌다.

| 변형 | loopback C=1 | commercial C=1 | 비율 |
|---|---:|---:|---:|
| raw | **1,696.31 Mbps** | 341.38 Mbps | **4.97배** ✅ |
| meshopt | **1,377.81 Mbps** | 304.63 Mbps | **4.52배** ✅ |
| draco | **1,016.38 Mbps** | 263.05 Mbps | **3.86배** ✅ |

(2026-08-14 실측. 세 변형 모두 3배 초과 → 보고 대상 아님)

---

## 1. loadgen 측정과 무엇이 다른가

| | loadgen (sync_latency) | **measure.py loopback (이 문서)** |
|---|---|---|
| 도구 | `python -m tools.loadgen` — 서버 레포에 있음 | `scripts/measure.py` — **클라이언트 레포에 있음. 서버에 없다** |
| 지표 | 상태 동기화 지연 (ms, p95/p99) | 에셋 전송 처리량 (Mbps) + 전송 시간 |
| 대상 | WebSocket 릴레이 | `GET /static/assets/a_*/…` — nginx `proxy_pass` → FastAPI `StaticFiles` (EBS) |
| 실행 위치 | 서버 내부 (loopback) | 서버 내부 (loopback) — 여기만 같다 |
| 준비 | 없음 (레포에 이미 있음) | **파일 업로드 + 래퍼 스크립트 실행** |

---

## 2. 전제 — 코드로 확인한 사실 (추측 아님)

| 사실 | 근거 |
|---|---|
| **`pip install` 불필요** — stdlib + `curl` 만 쓴다 | `measure.py` / `ofk_api.py` / `common.py` 임포트 전수 확인. 서드파티 없음 |
| **다운로드 측정은 토큰이 필요 없다** | `run_session()` 은 `upload_matrix` 가 있을 때만 로그인한다 |
| 본문은 서버 디스크에 안 쓴다 | `download_stream()` 이 `curl -o /dev/null` |
| `--label loopback` → C=1 매트릭스 자동 선택 | `LOOPBACK_MATRIX` = raw 1×10, meshopt 1×30, draco 1×30 |
| loopback + C>1 은 실행 거부된다 | `check_guards()` — 2 vCPU 에서 부하 생성기와 서버의 CPU 경합을 재게 되므로 |
| 대상 목록 JSON 의 URL 은 **상대경로** → `--target` 이 앞에 붙는다 | `resolve_download_targets()`. 그래서 같은 JSON 으로 타겟만 바꿔 재사용 가능 |
| 스로틀 감시(`/api/metrics/net-allowance`)는 무인증 | `ofk_api.net_allowance()` — urllib, 헤더 없음 |
| 조건마다 워밍업 1라운드를 버린다 | `run_download_condition()` 의 `range(-1, r)` |

서버에 올려야 하는 파일은 4개 + 대상 목록 1개다. `report.py` / `check_schema.py` 는 회수한
JSON 을 로컬에서 돌리므로 올릴 필요 없다.

---

## 3. 왜 `/etc/hosts` 를 건드리는가

journal §5 는 "`curl --resolve` 로 같은 nginx·같은 인증서 경로를 타게 할 것" 이라고 적었지만,
`measure.py` 의 curl 인자는 고정이고 **`--resolve` 를 넘길 플래그가 없다.** 대안 3개를 비교했다.

| 방법 | 결과 |
|---|---|
| `--target https://AWS_HOST_REDACTED` 그대로 | **실패한다.** nip.io 는 퍼블릭 IP 를 돌려주고, AWS 는 인스턴스가 자기 퍼블릭 IP 로 붙는 헤어핀을 지원하지 않는다 |
| `--target https://localhost` | 인증서 이름 불일치로 curl 이 거부한다. `-k` 를 넣을 방법도 없고, 넣으면 다른 nginx server 블록으로 갈 수도 있다 |
| **`/etc/hosts` 에 `127.0.0.1 AWS_HOST_REDACTED`** | **SNI·인증서·nginx server 블록·헤더 설정이 commercial 과 완전히 동일하고, 네트워크 경로만 빠진다.** 이게 원하는 통제다 |

부작용: 이 항목은 호스트 전체에 적용된다. 서버 프로세스가 자기 퍼블릭 호스트명으로 내는 요청도
loopback 으로 간다. **측정이 끝나면 반드시 지운다** — 래퍼가 trap 으로 한다 (§4-3). 지우지 않으면 나중에 원인 찾기 어려운
고장을 남긴다.

---

## 4. 절차

### 4-1. 로컬 맥에서 — 파일 올리기

```bash
cd /Users/apple/Documents/OF_KOR_3D
# AWS EC2 (8/13 상용 측정 타겟과 같은 서버). KOREN VM 이 아니다.
# IP 는 AWS_HOST_REDACTED = AWS_IP_REDACTED 로 확정. 사용자명은 Ubuntu AMI 기본값 가정 — 확인 필요
HOST=ubuntu@AWS_IP_REDACTED

ssh $HOST 'mkdir -p ~/ofk-measure/scripts ~/ofk-measure/results'
scp scripts/measure.py scripts/common.py scripts/ofk_api.py scripts/_pathfix.py \
    $HOST:~/ofk-measure/scripts/
scp results/download_targets_commercial.json $HOST:~/ofk-measure/results/
```

**디렉터리 구조를 지킬 것.** `common.py` 가 `ROOT = <scripts>/..` 로 `results/` 를 찾는다.
`scripts/` 밖에 풀어놓으면 출력 파일 경로가 엉뚱한 곳으로 간다.

### 4-2. (선택) sudo 없이 서버 쪽 준비만 보기

```bash
curl -sS --resolve AWS_HOST_REDACTED:443:127.0.0.1 -o /dev/null \
  -w '%{remote_ip} %{http_code} %{size_download}\n' \
  https://AWS_HOST_REDACTED/static/assets/a_ddfbb893/site_stacked_meshopt.glb
```

기대: `127.0.0.1 200 36637416`. 이건 `/etc/hosts` 를 건드리지 않는 **사전 확인**이고, 서버 쪽에서
이미 통과했다(§0-1). `measure.py` 에는 `--resolve` 를 넘길 수 없어 측정 자체에는 쓸 수 없다.

### 4-3. 측정 — 래퍼 스크립트가 플립·검증·복구를 한다

**대화형 SSH 셸에서 한다.** `ssh $HOST '...'` 로 명령을 붙여 보내면 TTY 가 없어 sudo 가 암호를
물을 수 없고 시작하자마자 멈춘다 (그 상태에서는 아무것도 건드리지 않았으므로 안전하다).

```bash
ssh $HOST
cd /data/OF-KOR-3D-server

# (a) 준비만 확인하고 되돌린다 — 30초. 파일을 올린 뒤 한 번 돌리면 --targets 경로까지 걸러진다
./tools/loopback_measure.sh --verify-only

# (b) 측정
./tools/loopback_measure.sh -- python3 ~/ofk-measure/scripts/measure.py \
  --target https://AWS_HOST_REDACTED \
  --label loopback \
  --targets ~/ofk-measure/results/download_targets_commercial.json \
  --location other --network-type wired \
  --server-version "OF_KOR_3D Server 0.1.0 / nginx 1.24.0" \
  --ebs-type gp3 \
  --serving "ebs gp3 (/static/assets/a_*, FastAPI StaticFiles + nginx proxy_pass)" \
  --skip-probes \
  2>&1 | tee ~/loopback_run.txt
```

래퍼가 `/etc/hosts` 플립 → 검증 5항목 → 유휴 확인 → ENA 카운터 전후 대조 → **trap 으로 복구**까지
한다. 측정이 실패하든 Ctrl-C 를 누르든 SSH 가 끊기든 항목이 되돌아간다.

- `python3` 그대로. 서버 레포의 venv 를 쓸 필요 없다 (§2). 서버 python 은 3.12.3 이다
- `--label loopback` 이 매트릭스를 결정한다. `--download` 로 덮어쓰지 않는다
- **`--serving` 을 반드시 명시한다.** `choices` 가 없는 자유 문자열이고 default 가 `tmpfs` 라서,
  빼면 틀린 값이 조용히 박힌다 (§0-1 #4). 측정 경로는 `a_*`(EBS)다
- `--location other --network-type wired` — loopback 에는 위치도 회선도 없다. 선택지에 그런 값이
  없어서 `other` 를 쓴 것이고, **이 두 필드는 이 세션에서 무의미하다는 것을 기록에 남긴다**
- **`--skip-probes` 를 반드시 넣는다.** 빼면 `ping AWS_HOST_REDACTED` 가 플립된 hosts 때문에
  127.0.0.1 로 가서 **`서버 RTT avg 0.05 ms`** 같은 가짜 값이 메타데이터에 박힌다. journal §4 가
  정리한 "없는 사실을 기록에 남기는" 부류의 실수다. 대신 이 플래그는 메타데이터에
  `"--skip-probes — 하네스 검증용. 실제 세션에서는 쓰지 말 것"` 이라는 **부정확한 note** 를
  남기므로, 실행 기록에 "loopback 이라 잴 회선·RTT·경로가 없어서 끈 것" 이라고 한 줄 적는다
- `--targets` 는 절대경로로 줬다. 래퍼가 작업 디렉터리를 바꾸지 않으므로 상대경로
  (`../results/…`)도 동작하지만, 래퍼를 거치는 구조에서는 절대경로가 안전하다

### 4-4. 로컬로 회수 + 집계

```bash
scp $HOST:'~/ofk-measure/results/transfer_*_loopback.json' results/
scp $HOST:~/loopback_run.txt results/logs/06_download_loopback.txt

.venv/bin/python scripts/check_schema.py results/transfer_*_loopback.json
.venv/bin/python scripts/report.py results/transfer_*_loopback.json \
    results/transfer_20260813_0006_commercial.json
```

**두 파일을 함께 줘야** `report.py` 가 `loopback_ratio()` 를 실행해 §11 의 3배 판정을 낸다.
loopback 파일만 주면 상한 표만 나오고 비율은 안 나온다.

---

## 5. 실행 중 화면에서 확인할 것

| 출력 | 의미 |
|---|---|
| `✓ 연결 IP 127.0.0.1` 외 4항목 | 래퍼의 검증 5항목. 다 통과해야 측정이 시작된다. 하나라도 틀리면 스크립트가 스스로 멈추고 되돌린다 |
| `다운로드 매트릭스 egress 예상 5.3 GB` | **실제 egress 는 0 이다.** loopback 이라 ENI 를 나가지 않는다. 하네스는 그걸 모르고 계산한다. 60GB 가드에도 안 걸리므로 `--yes` 불필요 |
| `[워밍업] … ms — 폐기` | 조건마다 1줄. 안 보이면 매트릭스가 덮어써진 것 |
| `⚠ throttled` | **loopback 에서는 절대 나오지 않아야 한다.** 나오면 트래픽이 ENI 를 거쳤다는 뜻이다. 그 세션은 버린다 |
| `✓ ENA 스로틀 카운터 변화 없음` | 래퍼가 전후로 찍어 대조한 결과. **이 줄을 보고 세션을 채택한다** |
| `== 복구 /etc/hosts` | 마지막에 반드시 나온다. 안 보이면 `grep nip.io /etc/hosts` 로 직접 확인 |
| 소요 시간 | 총 5.3GB, 71라운드. 수 분 규모다. 30분씩 걸리면 뭔가 잘못됐다 |

---

## 6. 기록할 것

`report.py` 가 내는 `loopback 상한 대비 commercial` 표를
[`summary_20260813.md`](summary_20260813.md) 에 추가하고, journal §3.1 의
"loopback 을 재지 못해 비율 자체를 계산하지 못했다" 문단을 실측값으로 대체한다.

판정은 미리 정해둔다:

- **비율 ≥ 3** → 서버가 병목이 아니라는 §3.1 결론이 직접 증거로 확인됨
- **비율 < 3** → §11 보고 대상. commercial 측정이 서버 상한에 근접해 있었다는 뜻이고,
  9월 KOREN 개선폭 해석이 달라진다
- **비율을 개선 근거로 쓰지 않는다.** 이 값은 "서버가 얼마나 여유 있었나" 를 말할 뿐이다

---

## 7. 함정

- **`--serving` 을 빼기.** default 가 `tmpfs` 라서 틀린 값이 조용히 박힌다 (§0-1 #4).
  플래그를 빼는 것은 "기록하지 않음" 이 아니다
- **결과를 "nginx 상한" 으로 서술하기.** 정적 서빙은 FastAPI `StaticFiles` 가 한다 (§0-1 #3)
- **`/etc/hosts` 를 손으로 건드리기.** 래퍼가 trap 으로 복구한다 (§4-3). 손으로 하면 실패·중단
  시 항목이 남는다
- **2 vCPU 에서 curl 과 서버가 CPU 를 나눠 쓴다.** 그래서 이 값은 서버 상한의 **하한
  근사**다 — `measure.py` 가 loopback 을 C=1 로 강제하는 이유가 그것이다. 결과 서술도
  "상한" 이 아니라 "상한의 하한 근사" 로 쓴다. 실제 서버 상한은 이보다 높다
- **`--skip-probes` 의 note 문구를 그대로 인용하기.** §4-3 참조
- **변환 잡이 도는 중에 재기** — 래퍼가 `running` 잡을 확인하고 멈춘다
- **`report.py` 에 loopback 파일만 주고 비율이 없다고 결론 내기** (§4-4)
- **loopback 수치를 commercial 표에 같은 행으로 합치기.** `label` 이 다르므로 행을 나눈다 —
  journal §3.4 에서 `cli`/`browser` 를 합치지 않은 것과 같은 원칙

---

## 8. 미확정 (실행 전에 확인)

**남은 것은 하나다.**

| # | 항목 | 상태 |
|---|---|---|
| 1 | AWS EC2 의 SSH 접속 | **해결.** `ubuntu@AWS_IP_REDACTED`, 키 인증 전용(비밀번호 인증 불가), 키는 `~/.ssh/of-kor-3d-keypair.pem`. 호스트 `ip-172-31-33-26`, 레포 `/data/OF-KOR-3D-server` |
| 2 | nginx 가 `127.0.0.1:443` 을 듣는지 | **해결.** `curl --resolve` 로 `127.0.0.1 / 200 / 36637416 / nginx/1.24.0` 확인 |
| 3 | 서버 python3 버전 | **해결.** 3.12.3 |
| 4 | `sudo` 권한 | **해결.** 있음. 단 **TTY 필요** — 대화형 셸로 로그인 (§4-3) |
| 5 | 저장 매체 여유 | **해결.** 파일이 이미 있어 추가 소요 없음 |
| 6 | 서버 유휴 여부 | **해결.** `running` 잡 0건 (`skipped` 63건은 CPU 를 쓰지 않는다) |
| 7 | `--serving` 허용값 | **해결.** `choices` 없는 자유 문자열, default `tmpfs` (§0-1 #4) |
| 8 | 타겟 JSON 경로 | **해결.** `a_56077c0a`/`a_ddfbb893`/`a_0db8b84f` — 전부 `a_*`. nginx 로그와 일치 |

### 막히면

| 증상 | 원인·조치 |
|---|---|
| `sudo 권한이 필요합니다` + `TTY 없는 셸` | `ssh $HOST '...'` 대신 로그인해서 실행 |
| `/etc/hosts 에 … 항목이 이미 있습니다` | 이전 실행이 복구되지 않았다. `sudo sed -i '\|# ofk-loopback-measure\|d' /etc/hosts` |
| `IFC 변환 잡이 N건 진행 중입니다` | 끝날 때까지 기다린다 |
| 검증 항목 중 `연결 IP` 만 틀림 | hosts 플립이 안 먹었다. `getent hosts AWS_HOST_REDACTED` |
| curl 자체가 실패 | nginx 가 `127.0.0.1:443` 을 안 듣는 것이다. **거기서 멈추고** 담당자에게 확인 |
| 카운터가 움직였다는 경고 | 트래픽이 ENI 를 거쳤다. 그 세션은 버린다 |
