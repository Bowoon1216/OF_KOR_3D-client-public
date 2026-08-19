import { assetUrl } from '../config/env';
import { ApiError } from './errors';

/**
 * 에셋 다운로드는 `fetch` + `ReadableStream` 으로만 합니다.
 *
 * axios 의 `onDownloadProgress` 는 응답 전체를 메모리에 버퍼링해서 수백 MB GLB 에서는 못 씁니다.
 * `getReader()` 로 받으면 청크가 도착하는 대로 진행률을 갱신하고, 필요하면 그대로 로더에 넘길 수 있습니다.
 */

export interface DownloadProgress {
  loadedBytes: number;
  /** `content-length` 가 없으면 0 */
  totalBytes: number;
  /** 0 ~ 1. 총 크기를 모르면 null */
  ratio: number | null;
}

export interface DownloadTiming {
  /** 요청 시작 → 첫 바이트 (수동 측정, 시계 오차 없음) */
  ttfbMs: number;
  /** 첫 바이트 → 마지막 바이트 */
  downloadMs: number;
  /** 요청 시작 → 마지막 바이트 */
  totalMs: number;
  /**
   * Performance API 로 분해한 구간.
   *
   * 교차 오리진 응답에 `Timing-Allow-Origin` 이 없으면 브라우저가 세부 시각을 0 으로 가려서
   * 이 값이 `null` 이 됩니다. 그때는 위의 수동 측정값만 신뢰합니다.
   */
  resource: ResourceBreakdown | null;
  /** 압축 후 실제 전송량. Performance API 가 막혀 있으면 null */
  transferSizeBytes: number | null;
}

export interface ResourceBreakdown {
  dnsMs: number;
  tcpMs: number;
  tlsMs: number;
  /** 요청 전송 → 응답 첫 바이트. "서버 처리" 로 읽는 구간 */
  serverMs: number;
  /** 응답 첫 바이트 → 마지막 바이트. "실제 전송" 구간 */
  transferMs: number;
  totalMs: number;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** 측정용. 브라우저 캐시를 건너뜁니다. */
  noCache?: boolean;
  /**
   * 측정용. 받은 청크를 버립니다 (`data` 는 빈 배열).
   *
   * 전송 시간만 재는 조건에서는 본문을 쓸 데가 없습니다. 그런데 339MB 를 10 스트림
   * 동시로 받으면서 전부 메모리에 모으면 탭이 죽고, 죽지 않아도 GC 시간이 전송 시간에
   * 섞입니다. 뷰어 경로(`data` 를 로더에 넘기는 쪽)는 이 옵션을 켜지 않습니다.
   */
  discard?: boolean;
}

export interface DownloadResult {
  data: Uint8Array;
  bytes: number;
  timing: DownloadTiming;
  /** 실제로 요청한 절대 URL */
  url: string;
}

/**
 * `performance.getEntriesByType('resource')` 에서 이 URL 의 마지막 항목을 꺼내
 * DNS / TCP / TTFB / 전송 시간을 분리합니다.
 * 나중에 "느린 게 네트워크인지 서버인지" 를 가릴 때 이 분해가 필요합니다.
 */
function readResourceTiming(url: string): {
  breakdown: ResourceBreakdown | null;
  transferSizeBytes: number | null;
} {
  if (typeof performance?.getEntriesByName !== 'function') {
    return { breakdown: null, transferSizeBytes: null };
  }
  const entries = performance.getEntriesByName(url) as PerformanceResourceTiming[];
  const entry = entries[entries.length - 1];
  if (!entry) return { breakdown: null, transferSizeBytes: null };

  // TAO 가 없으면 requestStart·responseStart 가 0 으로 가려집니다. 0 을 0ms 로 읽으면 안 됩니다.
  if (!entry.requestStart || !entry.responseStart) {
    return { breakdown: null, transferSizeBytes: entry.transferSize || null };
  }

  return {
    breakdown: {
      dnsMs: entry.domainLookupEnd - entry.domainLookupStart,
      tcpMs: entry.connectEnd - entry.connectStart,
      tlsMs: entry.secureConnectionStart ? entry.connectEnd - entry.secureConnectionStart : 0,
      serverMs: entry.responseStart - entry.requestStart,
      transferMs: entry.responseEnd - entry.responseStart,
      totalMs: entry.responseEnd - entry.startTime,
    },
    transferSizeBytes: entry.transferSize || null,
  };
}

/** 여러 청크를 한 버퍼로 합칩니다. (`Blob` 을 거치지 않아 복사가 한 번입니다) */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function downloadAsset(
  path: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const { onProgress, signal, noCache, discard } = options;
  const url = assetUrl(path);

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(url, { signal, cache: noCache ? 'no-store' : 'default' });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'NETWORK_ERROR', '3D 에셋을 내려받지 못했습니다.', {
      url,
      cause: String(error),
    });
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      response.status === 404 ? 'ASSET_NOT_FOUND' : 'INTERNAL',
      `3D 에셋을 내려받지 못했습니다. (${response.status})`,
      { url },
    );
  }

  const totalBytes = Number(response.headers.get('content-length') ?? 0);

  // body 가 없는 구형 환경 대비 (예: 일부 프록시). 진행률만 포기하고 통째로 받습니다.
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    const totalMs = performance.now() - startedAt;
    const { breakdown, transferSizeBytes } = readResourceTiming(url);
    onProgress?.({ loadedBytes: buffer.byteLength, totalBytes, ratio: totalBytes ? 1 : null });
    return {
      data: buffer,
      bytes: buffer.byteLength,
      url,
      timing: { ttfbMs: totalMs, downloadMs: 0, totalMs, resource: breakdown, transferSizeBytes },
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  let firstByteAt: number | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (firstByteAt === null) firstByteAt = performance.now();
    if (!discard) chunks.push(value);
    loadedBytes += value.byteLength;
    onProgress?.({
      loadedBytes,
      totalBytes,
      ratio: totalBytes > 0 ? Math.min(loadedBytes / totalBytes, 1) : null,
    });
  }

  const finishedAt = performance.now();
  const { breakdown, transferSizeBytes } = readResourceTiming(url);

  return {
    data: discard ? new Uint8Array(0) : concat(chunks, loadedBytes),
    bytes: loadedBytes,
    url,
    timing: {
      ttfbMs: (firstByteAt ?? finishedAt) - startedAt,
      downloadMs: firstByteAt === null ? 0 : finishedAt - firstByteAt,
      totalMs: finishedAt - startedAt,
      resource: breakdown,
      transferSizeBytes,
    },
  };
}
