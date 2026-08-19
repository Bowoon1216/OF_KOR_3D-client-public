/**
 * 브라우저 전송 측정 하네스 (ASSET_TRANSFER_TEST_PLAN.md §5.2, §6.3).
 *
 * **보조 데이터입니다.** 집계와 발표에 쓰는 권위 데이터는 `scripts/measure.py` 의 CLI 결과입니다
 * (§9 첫 항목). 브라우저는 커넥션 재사용·호스트당 동시 요청 제한·확장 프로그램 간섭 때문에
 * 같은 회선에서도 CLI 와 다른 값이 나옵니다. 그래도 재는 이유는 두 가지입니다.
 *
 *   1. CLI 결과와의 정합성 확인 — 두 하네스가 크게 다르면 둘 중 하나가 틀렸다는 신호
 *   2. "실제 사용자가 겪는 시간" 참고값
 *
 * 출력은 CLI 와 **완전히 같은 JSON 스키마**(§7)입니다. `meta.harness` 만 `"browser"` 로 다릅니다.
 * 그래야 `scripts/report.py` 가 두 결과를 같은 표에 놓을 수 있습니다.
 *
 * 사용 (개발자 콘솔):
 *
 *   const file = await window.ofkTransferHarness.run({
 *     label: 'commercial',
 *     location: 'home',
 *     networkType: 'wifi',
 *     downloads: [
 *       { variant: 'meshopt', path: '/static/assets/…/site_stacked_meshopt.glb',
 *         sizeBytes: 36637416, concurrency: 1, rounds: 30 },
 *     ],
 *   });
 *   window.ofkTransferHarness.save(file);   // transfer_…_commercial.browser.json 내려받기
 */

import { apiUrl, getApiBaseUrl } from '../config/env';
import { downloadAsset, type DownloadTiming, type ResourceBreakdown } from '../api/assetDownload';
import { getIfcJob } from '../api/assets';
import { getToken } from '../auth/tokenStore';

/** §7 스키마의 sample. CLI 가 쓰는 필드 이름과 하나도 다르지 않아야 합니다. */
export interface TransferSample {
  direction: 'download' | 'upload';
  asset: string;
  variant: string;
  file_size_bytes: number;
  concurrency: number;
  round: number;
  stream_index: number;
  elapsed_ms: number;
  ttfb_ms: number;
  throughput_mbps: number;
  srv_store_ms: number | null;
  srv_db_ms: number | null;
  srv_recv_ms: number | null;
  throttled: boolean;
  /** 이하 브라우저 전용 추가 필드. CLI 스키마의 필수 필드는 위까지입니다. */
  http_code: number;
  error: string | null;
  /** Performance API 구간 분해. `Timing-Allow-Origin` 이 없으면 null (§5.2) */
  resource: ResourceBreakdown | null;
  /** 업로드에서: 요청 시작 → 마지막 progress 이벤트 (전송 완료 추정, §6.3) */
  upload_sent_ms?: number;
}

export interface TransferSessionFile {
  meta: Record<string, unknown>;
  samples: TransferSample[];
}

export interface DownloadCondition {
  variant: string;
  /** 서버가 내려준 에셋 경로. 하드코딩 금지 — publish 결과에서 가져옵니다 (§4-1) */
  path: string;
  sizeBytes: number;
  concurrency: number;
  rounds: number;
}

export interface UploadCondition {
  /** 기록용 이름 (hoist / boomlift / rooflight) */
  asset: string;
  file: File;
  concurrency: number;
  rounds: number;
}

export interface HarnessConfig {
  label: string;
  location: 'home' | 'campus' | 'other';
  networkType: 'wifi' | 'wired';
  isp?: string;
  assetName?: string;
  serverVersion?: string;
  downloads?: DownloadCondition[];
  uploads?: UploadCondition[];
  /** §5.3 스로틀 감시. 끄면 그 사실이 meta 에 남습니다. */
  throttleWatch?: boolean;
  /**
   * 라운드마다 IFC 변환 완료를 기다립니다 (기본 true).
   * 끄면 변환이 도는 동안 다음 라운드를 쏘게 되어 §9 위반이고, 429 가 섞입니다.
   */
  drainJobs?: boolean;
  onLog?: (line: string) => void;
}

const THROTTLE_COUNTERS = [
  'bw_out_allowance_exceeded',
  'bw_in_allowance_exceeded',
  'pps_allowance_exceeded',
] as const;

function throughputMbps(bytes: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || bytes <= 0) return 0;
  return Number(((bytes * 8) / (elapsedMs / 1000) / 1e6).toFixed(4));
}

/** 매 요청마다 캐시를 무력화합니다 (§4-5). 나노초가 없으니 ms + 난수로 대신합니다. */
function cacheBust(path: string): string {
  const token = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  return `${path}${path.includes('?') ? '&' : '?'}t=${token}`;
}

// --------------------------------------------------------------------------
// 스로틀 감시 (§5.3) — SSH ethtool 대신 서버가 노출하는 ENA 카운터를 씁니다.
// --------------------------------------------------------------------------

type Counters = Record<string, number>;

async function readAllowance(): Promise<{ iface: string; counters: Counters } | null> {
  try {
    const res = await fetch(apiUrl('/api/metrics/net-allowance'), { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { interface?: string; counters?: Counters };
    if (!body.counters) return null;
    return { iface: body.interface ?? '', counters: body.counters };
  } catch {
    return null;
  }
}

class ThrottleWatch {
  interface: string | null = null;
  unavailableRounds = 0;
  private before: Counters | null = null;

  constructor(readonly enabled: boolean) {}

  async beforeRound(): Promise<void> {
    if (!this.enabled) return;
    const snap = await readAllowance();
    this.before = snap?.counters ?? null;
    if (snap) this.interface = snap.iface;
  }

  async afterRound(): Promise<boolean> {
    if (!this.enabled) return false;
    const snap = await readAllowance();
    if (!this.before || !snap) {
      this.unavailableRounds += 1;
      return false;
    }
    return THROTTLE_COUNTERS.some((k) => (snap.counters[k] ?? 0) - (this.before![k] ?? 0) > 0);
  }
}

// --------------------------------------------------------------------------
// 업로드 (§6.3) — `fetch` 는 업로드 진행률을 주지 않으므로 XHR 을 유지합니다.
// --------------------------------------------------------------------------

interface UploadTiming {
  totalMs: number;
  /** 요청 시작 → 마지막 progress 이벤트. 바이트를 다 보낸 시점의 추정치 */
  sentMs: number;
  /** 요청 시작 → 응답 첫 신호 */
  ttfbMs: number;
  status: number;
  serverTiming: Record<string, number>;
  /** 202 응답의 변환 잡 id (`j_…`). 에셋 id 가 아닙니다. */
  jobId: string | null;
  error: string | null;
}

/**
 * `Server-Timing: recv;dur=1.5, store;dur=2.5` → `{recv: 1.5, store: 2.5}`.
 *
 * CORS 응답에서는 `expose_headers` 에 `Server-Timing` 이 들어 있어야 읽힙니다.
 * 없으면 빈 객체가 나오고, 그 사실이 리포트의 "서버 헤더 없음" 경고로 이어집니다 (§11).
 */
export function parseServerTiming(raw: string | null): Record<string, number> {
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const segments = part.split(';').map((s) => s.trim());
    const name = segments[0];
    if (!name) continue;
    for (const kv of segments.slice(1)) {
      const [key, value] = kv.split('=');
      if (key?.trim().toLowerCase() === 'dur') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) out[name] = parsed;
      }
    }
  }
  return out;
}

/**
 * IFC 한 건을 올립니다 (`POST /api/assets/ifc`).
 *
 * 반복 필드가 아니라 `file` 하나입니다. 성공은 **202** 이고 응답 본문은 변환 잡입니다.
 * 변환이 응답 밖으로 빠져 있어 이 시간에는 변환 시간이 섞이지 않습니다 (§6.1).
 */
function uploadOnce(file: File, asset: string): Promise<UploadTiming> {
  return new Promise((resolve) => {
    const token = getToken();
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('label', `transfer-measure ${asset}`);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl(cacheBust('/api/assets/ifc')));
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.responseType = 'text';

    const startedAt = performance.now();
    let lastProgressAt = startedAt;
    let firstResponseAt: number | null = null;

    xhr.upload.onprogress = () => {
      lastProgressAt = performance.now();
    };
    // 응답 헤더가 도착한 시점. 업로드에서는 recv+store+db 가 끝난 시각입니다.
    xhr.onreadystatechange = () => {
      if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED && firstResponseAt === null) {
        firstResponseAt = performance.now();
      }
    };

    const finish = (error: string | null) => {
      const now = performance.now();
      let jobId: string | null = null;
      try {
        jobId = (JSON.parse(xhr.responseText || '{}') as { id?: string }).id ?? null;
      } catch {
        /* 에러 응답이면 잡 id 가 없습니다. */
      }
      resolve({
        totalMs: now - startedAt,
        sentMs: lastProgressAt - startedAt,
        ttfbMs: (firstResponseAt ?? now) - startedAt,
        status: xhr.status,
        serverTiming: parseServerTiming(xhr.getResponseHeader('Server-Timing')),
        jobId: jobId?.startsWith('j_') ? jobId : null,
        error,
      });
    };

    xhr.onload = () =>
      finish(
        xhr.status >= 400
          ? // 429 는 동시 변환 2건 제한입니다. 전송 시간이 아니라 거절 시간이라 집계에서 빠집니다.
            xhr.status === 429
            ? 'CONVERSION_BUSY'
            : `HTTP ${xhr.status}`
          : null,
      );
    xhr.onerror = () => finish('NETWORK_ERROR');
    xhr.onabort = () => finish('ABORTED');
    xhr.send(form);
  });
}

/**
 * 잡이 전부 ready/failed 가 될 때까지 기다리고, 변환 결과 에셋 id 를 모읍니다.
 *
 * 기다리는 이유는 두 가지입니다.
 *   1. 사용자당 동시 변환이 2건이라, 안 기다리면 세 번째 요청부터 429 가 오고
 *      그 값은 전송 시간이 아닙니다
 *   2. 변환이 도는 동안 다음 라운드를 쏘면 2 vCPU 를 변환과 나눠 씁니다 (§9)
 */
async function drainJobs(
  jobIds: string[],
  onLog: (line: string) => void,
): Promise<{ assetIds: string[]; failed: number }> {
  const pending = new Set(jobIds);
  const assetIds: string[] = [];
  let failed = 0;
  const deadline = Date.now() + 20 * 60 * 1000;

  while (pending.size > 0 && Date.now() < deadline) {
    for (const jobId of [...pending]) {
      try {
        const job = await getIfcJob(jobId);
        // 완료 판정은 status 로만 합니다. progress 는 완료 전까지 99 를 넘지 않습니다.
        if (job.status === 'ready') {
          pending.delete(jobId);
          if (job.asset?.id) assetIds.push(job.asset.id);
        } else if (job.status === 'failed') {
          pending.delete(jobId);
          failed += 1;
          // SERVER_RESTART 면 워커가 사라진 것이라 기다려도 끝나지 않습니다.
          onLog(`  변환 실패 ${jobId}: ${job.errorCode ?? ''}`);
        }
      } catch (error) {
        // 403(남의 잡)·404(없는 잡)는 폴링을 이어갈 이유가 없습니다.
        const status = (error as { status?: number }).status;
        if (status === 403 || status === 404) {
          pending.delete(jobId);
          failed += 1;
          onLog(`  잡 조회 거절 ${jobId}: HTTP ${status}`);
        }
        // 그 외는 일시적 장애로 보고 재시도합니다.
      }
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, 1000));
  }
  if (pending.size > 0) onLog(`  변환 대기 시간 초과: ${pending.size}건`);
  return { assetIds, failed };
}

/** 업로드 측정으로 서버에 쌓인 에셋을 치웁니다. 실패해도 측정 결과는 유지합니다. */
async function cleanupUploads(ids: string[]): Promise<number> {
  const token = getToken();
  let removed = 0;
  for (const id of ids) {
    try {
      const res = await fetch(apiUrl(`/api/assets/${encodeURIComponent(id)}`), {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) removed += 1;
    } catch {
      /* 남은 건 리포트에 개수로만 남습니다. */
    }
  }
  return removed;
}

// --------------------------------------------------------------------------
// 세션
// --------------------------------------------------------------------------

export async function run(config: HarnessConfig): Promise<TransferSessionFile> {
  const log = config.onLog ?? ((line: string) => console.log(`[transfer] ${line}`));
  const asset = config.assetName ?? 'site_stacked';
  const watch = new ThrottleWatch(config.throttleWatch !== false);
  const samples: TransferSample[] = [];
  const uploadedIds: string[] = [];
  let conversionFailures = 0;
  const startedAt = new Date();

  for (const condition of config.downloads ?? []) {
    const { variant, path, sizeBytes, concurrency, rounds } = condition;
    log(`다운로드 ${variant} ${(sizeBytes / 1e6).toFixed(1)}MB C=${concurrency} R=${rounds}`);

    // round -1 = 워밍업. DNS·TCP·TLS 수립 비용이 섞이므로 기록하지 않습니다 (§4-4).
    for (let round = -1; round < rounds; round += 1) {
      await watch.beforeRound();
      const results = await Promise.all(
        Array.from({ length: concurrency }, async () => {
          try {
            const r = await downloadAsset(cacheBust(path), { noCache: true, discard: true });
            return { bytes: r.bytes, timing: r.timing as DownloadTiming | null, error: null };
          } catch (error) {
            // 실패도 샘플로 남깁니다. 조용히 빠지면 n 이 줄어든 이유를 나중에 알 수 없습니다.
            return { bytes: 0, timing: null, error: String(error) };
          }
        }),
      );
      const throttled = await watch.afterRound();
      if (round < 0) {
        log('  워밍업 폐기');
        continue;
      }

      results.forEach((result, streamIndex) => {
        const base = {
          direction: 'download' as const,
          asset,
          variant,
          file_size_bytes: sizeBytes,
          concurrency,
          round,
          stream_index: streamIndex,
          srv_store_ms: null,
          srv_db_ms: null,
          srv_recv_ms: null,
          throttled,
        };
        const { timing, bytes, error } = result;
        if (!timing) {
          samples.push({
            ...base,
            elapsed_ms: 0,
            ttfb_ms: 0,
            throughput_mbps: 0,
            http_code: 0,
            error,
            resource: null,
          });
          return;
        }
        samples.push({
          ...base,
          elapsed_ms: Number(timing.totalMs.toFixed(3)),
          ttfb_ms: Number(timing.ttfbMs.toFixed(3)),
          throughput_mbps: throughputMbps(bytes || sizeBytes, timing.totalMs),
          http_code: 200,
          error: null,
          resource: timing.resource,
        });
      });
      log(`  [${round + 1}/${rounds}]${throttled ? ' ⚠ throttled' : ''}`);
    }
  }

  for (const condition of config.uploads ?? []) {
    const { asset: name, file, concurrency, rounds } = condition;
    log(`업로드 ${name} ${(file.size / 1e6).toFixed(2)}MB C=${concurrency} R=${rounds}`);

    for (let round = -1; round < rounds; round += 1) {
      await watch.beforeRound();
      const results = await Promise.all(
        Array.from({ length: concurrency }, () => uploadOnce(file, name)),
      );
      const throttled = await watch.afterRound();

      // 다음 라운드를 쏘기 전에 변환을 비웁니다 (§9). 변환된 에셋 id 는 정리에 씁니다.
      const jobIds = results.map((t) => t.jobId).filter((id): id is string => Boolean(id));
      if (config.drainJobs !== false && jobIds.length > 0) {
        const drained = await drainJobs(jobIds, log);
        uploadedIds.push(...drained.assetIds);
        conversionFailures += drained.failed;
      }

      if (round < 0) {
        log('  워밍업 폐기');
        continue;
      }

      results.forEach((t, streamIndex) => {
        samples.push({
          direction: 'upload',
          asset: name,
          variant: file.name.toLowerCase().endsWith('.ifc') ? 'ifc' : 'glb',
          file_size_bytes: file.size,
          concurrency,
          round,
          stream_index: streamIndex,
          elapsed_ms: Number(t.totalMs.toFixed(3)),
          ttfb_ms: Number(t.ttfbMs.toFixed(3)),
          throughput_mbps: throughputMbps(file.size, t.totalMs),
          // §6.2 — 서버가 실제로 일한 시간은 store + db. recv 는 네트워크 시간입니다.
          srv_store_ms: t.serverTiming.store ?? null,
          srv_db_ms: t.serverTiming.db ?? null,
          srv_recv_ms: t.serverTiming.recv ?? null,
          throttled,
          http_code: t.status,
          error: t.error,
          resource: null,
          upload_sent_ms: Number(t.sentMs.toFixed(3)),
        });
      });
      log(`  [${round + 1}/${rounds}]${throttled ? ' ⚠ throttled' : ''}`);
    }
  }

  const removed = uploadedIds.length ? await cleanupUploads(uploadedIds) : 0;
  if (uploadedIds.length) log(`업로드 정리: ${removed}/${uploadedIds.length} 삭제`);

  const withResource = samples.filter((s) => s.direction === 'download' && s.resource).length;
  const downloads = samples.filter((s) => s.direction === 'download').length;

  const meta: Record<string, unknown> = {
    session_id: `${stamp(startedAt)}_${config.location}`,
    // CLI 는 오프셋이 붙은 현지 시각을 쓴다. 여기서 UTC(`toISOString`)를 쓰면 session_id
    // (현지 시각 기준)와 날짜·시각이 어긋나 §8.3 의 "측정 시간대" 가 헷갈린다.
    started_at: localIso(startedAt),
    target_url: getApiBaseUrl(),
    label: config.label,
    location: config.location,
    network_type: config.networkType,
    isp: config.isp ?? '',
    harness: 'browser',
    server: {
      instance_type: 't3.medium',
      region: 'ap-northeast-2',
      ebs_type: 'gp3',
      serving: 'tmpfs',
      software_version: config.serverVersion ?? '',
    },
    // 브라우저에서는 speedtest·ping·traceroute 를 돌릴 수 없습니다. CLI 세션의 진단을
    // 그대로 인용해야 하며, 0 을 "측정값 0" 으로 읽으면 안 됩니다.
    diagnostics: {
      speedtest_down_mbps: 0,
      speedtest_up_mbps: 0,
      server_rtt_avg_ms: 0,
      server_rtt_mdev_ms: 0,
      router_rtt_avg_ms: 0,
      router_rtt_mdev_ms: 0,
      traceroute_hops: 0,
    },
    diagnostics_note:
      '브라우저에서는 §5.4 진단(speedtest/ping/traceroute)을 실행할 수 없다. ' +
      '같은 시각 CLI 세션의 diagnostics 를 인용할 것.',
    warmup_rounds_discarded_per_condition: 1,
    throttle_watch: {
      enabled: watch.enabled,
      source: 'GET /api/metrics/net-allowance',
      interface: watch.interface,
      counters: THROTTLE_COUNTERS,
      rounds_counter_unavailable: watch.unavailableRounds,
    },
    // TAO 가 없으면 구간 분해가 전부 null 입니다. 그 사실을 세면 리포트에서 근거로 쓸 수 있습니다.
    resource_timing_available: `${withResource}/${downloads}`,
    upload_endpoint: '/api/assets/ifc',
    drained_between_rounds: config.drainJobs !== false,
    conversion_failures: conversionFailures,
    timing_allow_origin_note:
      withResource === 0 && downloads > 0
        ? 'Timing-Allow-Origin 이 없어 브라우저가 requestStart·responseStart 를 가렸다. ' +
          'DNS/TCP/TTFB 분해 없이 수동 측정값만 기록했다 (§5.2).'
        : null,
    user_agent: navigator.userAgent,
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    note: '보조 데이터. 권위 데이터는 scripts/measure.py 의 CLI 결과 (§9).',
    finished_at: localIso(new Date()),
  };

  return { meta, samples };
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** `2026-08-13T00:41:12+09:00` — CLI 의 `now_iso()` 와 같은 형식 */
function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 결과를 CLI 와 같은 파일명 규칙으로 내려받습니다 (§7). */
export function save(file: TransferSessionFile): void {
  const label = String(file.meta.label ?? 'browser');
  const sessionId = String(file.meta.session_id ?? 'session');
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `transfer_${sessionId.split('_').slice(0, 2).join('_')}_${label}.browser.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 콘솔에서 바로 쓰기 위한 창구. 측정 담당자가 UI 없이 실행합니다. */
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ofkTransferHarness = { run, save };
}
