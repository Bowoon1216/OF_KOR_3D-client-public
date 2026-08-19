import { apiUrl } from '../config/env';
import { normalizeRoomCode } from './rooms';
import { request } from './http';
import type {
  AssetLoadReport,
  CompareResponse,
  CreateRunRequest,
  MetricsRun,
  RoomTelemetry,
  RunSummary,
} from './types';

/** `POST /api/metrics/runs` — run 이 활성인 동안에만 측정값이 DB 에 저장됩니다. */
export function startRun(body: CreateRunRequest): Promise<MetricsRun> {
  return request<MetricsRun>('/api/metrics/runs', { method: 'POST', body, auth: 'optional' });
}

/** `POST /api/metrics/runs/{runId}/stop` */
export function stopRun(runId: string): Promise<MetricsRun> {
  return request<MetricsRun>(`/api/metrics/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
    auth: 'optional',
  });
}

/** `GET /api/metrics/runs/{runId}/summary` — 보고서의 검증 지표 표에 그대로 들어가는 값 */
export function getRunSummary(runId: string, signal?: AbortSignal): Promise<RunSummary> {
  return request<RunSummary>(`/api/metrics/runs/${encodeURIComponent(runId)}/summary`, {
    auth: 'optional',
    signal,
  });
}

/** `GET /api/metrics/compare` — 시나리오가 다르면 서버가 400 을 냅니다. */
export function compareRuns(
  baseline: string,
  target: string,
  options: { force?: boolean } = {},
  signal?: AbortSignal,
): Promise<CompareResponse> {
  return request<CompareResponse>('/api/metrics/compare', {
    auth: 'optional',
    query: { baseline, target, force: options.force ? 'true' : undefined },
    signal,
  });
}

/** `GET /api/metrics/runs/{runId}/export` — CSV 원문 */
export function exportRun(
  runId: string,
  table: 'samples' | 'agg' = 'samples',
  signal?: AbortSignal,
): Promise<string> {
  return request<string>(`/api/metrics/runs/${encodeURIComponent(runId)}/export`, {
    auth: 'optional',
    query: { table },
    headers: { Accept: 'text/csv' },
    signal,
  });
}

/** 브라우저에서 바로 내려받을 수 있는 링크 (스트리밍 응답을 메모리에 담지 않습니다) */
export function exportRunUrl(runId: string, table: 'samples' | 'agg' = 'samples'): string {
  return `${apiUrl(`/api/metrics/runs/${encodeURIComponent(runId)}/export`)}?table=${table}`;
}

/**
 * `POST /api/metrics/asset-load` — "방 입장 ~ 렌더링 완료" 시간 보고 (202, 본문 없음).
 * 모든 마크가 한 클라이언트 시계 위에 있어 시계 오차와 무관합니다.
 */
export function reportAssetLoad(body: AssetLoadReport): Promise<void> {
  return request<void>('/api/metrics/asset-load', { method: 'POST', body, auth: 'optional' });
}

/** `GET /api/metrics/rooms/{code}` — WebSocket `telemetry` 와 같은 값의 폴링용 창구 */
export function getRoomMetrics(code: string, signal?: AbortSignal): Promise<RoomTelemetry> {
  return request<RoomTelemetry>(`/api/metrics/rooms/${normalizeRoomCode(code)}`, {
    auth: 'optional',
    signal,
  });
}
