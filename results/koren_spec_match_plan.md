# KOREN VM 을 t3.medium 사양으로 맞추기 — 실행 계획

**목적**: AWS loopback 핸드셰이크가 33.60 ms, KOREN 이 5.78 ms 로 **5.8배** 차이 난다.
네트워크가 0인 loopback 조건이므로 이 차이는 순수 CPU 다. KOREN 을 2 vCPU / 4 GiB 로
묶었을 때 33 ms 에 가까워지면 **"CPU 탓" 이 확정**되고, 그러면 이 격차는 AWS 에서
상위 인스턴스로 구매 가능한 것이므로 KOREN 의 고유 논거가 아니게 된다.

**측정 대상 지표는 처리량이 아니라 `connect_ms`(= curl `time_pretransfer`) 다.**
대량 전송은 `sendfile` 이라 CPU 를 안 쓴다 — 733MB 서빙에 uvicorn 0 ticks 로 확인됨.

---

## 0. 현재 상태

| 항목 | KOREN VM | AWS t3.medium |
|---|---|---|
| vCPU | **4** | 2 |
| RAM | **16 GiB** | 4 GiB |
| CPU | Intel Xeon Skylake (IBRS) | Xeon Platinum (Skylake/Cascade) |
| nginx | `nginx.service` (systemd), :8000 TLS + :80 | systemd, :443 TLS |
| uvicorn | **tmux 세션 `api`** — systemd 아님. `127.0.0.1:8080`, `--workers 1` | 미확인 |
| systemd | 255, cgroup v2 | — |
| sudo | 암호 없이 동작 (TTY 불필요) | SSH 없음 |

---

## 1. 반드시 맞출 것 — CPU 2코어

### 1-1. nginx (systemd 이므로 set-property)

```bash
sudo systemctl set-property --runtime nginx.service AllowedCPUs=0-1
systemctl show nginx.service -p AllowedCPUs --value      # 확인
```

`--runtime` 은 **재부팅 시 자동 소멸**한다. 설정 파일을 만들지 않으므로 되돌리기 쉽다.

### 1-2. uvicorn (tmux 라 systemd 가 안 닿음 → taskset)

```bash
for p in $(pgrep -f "uvicorn main:app"); do sudo taskset -cp 0-1 $p; done
taskset -cp $(pgrep -f "uvicorn main:app" | head -1)     # 확인
```

프로세스가 2개다(부모 + 워커). **둘 다** 잡아야 한다.
재시작하면 풀리므로 측정 중에 서버를 재시작하지 말 것.

### 1-3. ⚠️ 부하 생성기(curl)도 같은 2코어에 묶을 것

**이걸 빠뜨리면 비교가 반대로 불공평해진다.** AWS loopback 에서는 curl·nginx·uvicorn 이
전부 2 vCPU 를 나눠 썼다. KOREN 에서 서버만 2코어로 묶고 curl 을 3·4번 코어에서 돌리면
KOREN 이 부당하게 유리해진다.

```bash
taskset -c 0-1 python3 measure.py …      # 측정 명령 전체를 감싼다
```

---

## 2. 맞춰도 되고 안 맞춰도 되는 것 — RAM 4 GiB

**우선순위 낮음.** 페이지 캐시가 제약이 아니라는 근거가 이미 있다: 두 서버 모두
가장 큰 파일(raw 339MB)이 가장 빨랐다. 4GiB 인 AWS 에서 339MB 가 가장 불리해야 하는데
반대다 (339MB ≪ 4GiB 라 반복 읽기 내내 캐시에 남는다).

그래도 맞추려면 — cgroup 으로 uvicorn 을 묶기 어려우므로 **시스템 가용 메모리를 줄이는**
쪽이 현실적이다:

```bash
# 12GiB 를 점유해 가용 메모리를 ~4GiB 로 만든다
sudo fallocate -l 12G /dev/shm/ballast     # /dev/shm 은 tmpfs = RAM
free -m                                     # available 확인
# 되돌리기
sudo rm /dev/shm/ballast
```

`nginx.service` 에만 `MemoryMax=4G` 를 걸면 **uvicorn 과 페이지 캐시는 안 잡히므로
반쪽짜리다.** 위 방식이 낫다.

---

## 3. 맞출 수 없는 것 (한계로 기록)

| 항목 | 이유 |
|---|---|
| **t3 CPU 크레딧 스로틀** | AWS 정책이라 재현 불가. `CPUQuota=40%` 로 흉내낼 수는 있으나 베이스라인 실제값을 모른다 |
| **t3 버스터블 네트워크** | 정책. 단 loopback 은 NIC 를 안 타므로 이 실험에는 무관 |
| **CPU 모델·클럭** | 세대는 비슷(둘 다 Skylake 계열)하나 정확히 같지 않다 |

**AWS 쪽에서 확인해야 할 것**: CloudWatch 의 `CPUCreditBalance` / `CPUSurplusCreditBalance`.
측정 시각에 크레딧이 말라 있었다면 33.60 ms 는 사양이 아니라 스로틀을 잰 것이다.
이건 서버 담당자만 볼 수 있다.

---

## 4. 맞출 필요 **없는** 것

- **GPU** — 전송 경로에 전혀 관여하지 않는다. `sendfile` 은 커널이 처리하고,
  GPU 는 렌더링·GI 베이킹 축의 이야기다
- **디스크** — 양쪽 다 ext4 블록 스토리지이고, 파일이 페이지 캐시에 상주해 I/O 가 안 난다

---

## 5. 적용 후 측정

전송 계층은 이미 양쪽 TLS+nginx 로 맞춰져 있다. 사양만 맞추고 같은 명령을 돌린다.

```bash
ssh -i ~/.ssh/id_ed25519 -p 26022 ubuntu@KOREN_IP_REDACTED
cd ~/ofk-measure/scripts
taskset -c 0-1 python3 measure.py \
  --target https://ofkor3d:8000 --label koren-loopback-2cpu \
  --targets ../results/download_targets_koren.json --cacert ~/ca/rootCA.crt \
  --download raw:1:10 meshopt:1:30 draco:1:30 \
  --location other --network-type wired --skip-probes --no-throttle-watch
```

회수:
```bash
scp -i ~/.ssh/id_ed25519 -P 26022 \
  'ubuntu@KOREN_IP_REDACTED:~/ofk-measure/results/transfer_*_koren-loopback-2cpu.json' results/
```

### 판정 기준

비교 대상은 `connect_ms` 중앙값(meshopt, C=1)이다.

| 결과 | 의미 |
|---|---|
| 5.78 → **30 ms 대** | CPU 확정. 격차는 AWS 상위 인스턴스로 구매 가능 → **KOREN 고유 논거 아님** |
| 5.78 → **10 ms 미만** | CPU 아님. t3 크레딧 스로틀이나 다른 원인 → CloudWatch 확인 필요 |
| 중간값 | 부분 설명. 남는 몫을 별도 규명 |

단위비(`ms/MB`)도 함께 본다. 현재 AWS 4.581 vs KOREN 3.466 (1.32배)인데,
이건 `sendfile` 경로라 2코어로 줄여도 안 변할 것으로 예상한다. 변하면 예상이 틀린 것이다.

---

## 6. 원복

```bash
sudo systemctl revert --runtime nginx.service       # 또는 AllowedCPUs=0-3
for p in $(pgrep -f "uvicorn main:app"); do sudo taskset -cp 0-3 $p; done
sudo rm -f /dev/shm/ballast
```

`--runtime` 과 `taskset` 은 재부팅하면 저절로 풀린다. 설정 파일을 만들지 않았으므로
영구 변경은 없다.
