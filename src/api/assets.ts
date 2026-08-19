import { clearToken, getToken } from '../auth/tokenStore';
import { apiUrl } from '../config/env';
import { ApiError } from './errors';
import { request } from './http';
import type { Asset, AssetListResponse, IfcJob } from './types';

/** 서버가 받는 확장자 (`UNSUPPORTED_EXTENSION`). `.glb` 를 올리면 415 입니다. */
export const IFC_EXTENSIONS = ['.ifc', '.ifczip'] as const;

/** `OFK_MAX_IFC_UPLOAD_MB` 기본값. 넘기면 서버가 413 `ASSET_TOO_LARGE` 를 냅니다. */
export const IFC_MAX_UPLOAD_MB = 1024;

/**
 * 변환 잡 조회 경로. 업로드는 `/api/assets/ifc` 지만 조회는 `/api/assets/jobs/{id}` 입니다.
 * 업로드 응답의 `id`(`j_…`)를 붙입니다.
 */
function ifcJobPath(jobId: string): string {
  return `/api/assets/jobs/${encodeURIComponent(jobId)}`;
}

/** `GET /api/assets` — 내가 올린 에셋만 */
export function listAssets(
  params: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<AssetListResponse> {
  return request<AssetListResponse>('/api/assets', {
    auth: 'required',
    query: { limit: params.limit, offset: params.offset },
    signal,
  });
}

/** `DELETE /api/assets/{assetId}` — 소유자만 */
export function deleteAsset(assetId: string): Promise<void> {
  return request<void>(`/api/assets/${encodeURIComponent(assetId)}`, {
    method: 'DELETE',
    auth: 'required',
  });
}

export interface UploadProgress {
  loadedBytes: number;
  totalBytes: number;
  /** 0 ~ 1. 총 크기를 모를 때는 null */
  ratio: number | null;
}

export interface UploadOptions {
  /** 표시 이름. 최대 120자. 변환된 에셋의 `label` 로 이어집니다. */
  label?: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/** XHR 응답 본문에서 서버 error 형식을 꺼냅니다. */
function parseXhrError(xhr: XMLHttpRequest): ApiError {
  try {
    const payload = JSON.parse(xhr.responseText) as {
      error?: { code?: string; message?: string; detail?: Record<string, unknown> };
    };
    if (payload?.error) {
      return new ApiError(
        xhr.status,
        payload.error.code ?? 'INTERNAL',
        payload.error.message ?? `업로드가 실패했습니다. (${xhr.status})`,
        payload.error.detail ?? {},
      );
    }
  } catch {
    /* JSON 이 아니면 아래 기본 메시지를 씁니다. */
  }
  return new ApiError(xhr.status, 'INTERNAL', `업로드가 실패했습니다. (${xhr.status})`);
}

export function isIfcFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return IFC_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * `POST /api/assets/ifc` — BIM 원본 IFC 업로드 및 GLB 변환 예약.
 *
 * 건축가는 Revit·ArchiCAD 를 쓰므로 사용자가 올리는 것은 IFC 입니다. GLB 변환은
 * 서버가 합니다. **`.glb` 를 여기로 올리면 415** 입니다.
 *
 * 응답은 **202 Accepted** 이고 변환은 아직 끝나지 않았습니다. 반환값은 에셋이 아니라
 * 변환 잡이며, `asset` 은 항상 null 입니다. 뷰어를 열려면 `waitForIfcJob` 으로
 * `status === 'ready'` 까지 기다려야 합니다.
 *
 * **여기만 XHR 을 씁니다.** `fetch` 는 업로드 진행률을 알려주지 않기 때문입니다
 * (`ReadableStream` 요청 본문은 HTTP/2 + duplex 가 필요해 현실적으로 못 씁니다).
 * 수백 MB BIM 파일을 올릴 때 진행률 없는 화면은 멈춘 것과 구분되지 않습니다.
 */
export function uploadIfc(file: File, options: UploadOptions = {}): Promise<IfcJob> {
  const { label, onProgress, signal } = options;

  return new Promise<IfcJob>((resolve, reject) => {
    if (!file) {
      reject(new ApiError(400, 'NO_ENTRY_FILE', '업로드할 파일을 선택해 주세요.'));
      return;
    }
    // 서버가 415 로 거절할 파일을 수백 MB 올린 뒤에 알려주는 건 낭비입니다.
    if (!isIfcFile(file)) {
      reject(
        new ApiError(
          415,
          'UNSUPPORTED_EXTENSION',
          `IFC 파일이 아닙니다: ${file.name.slice(file.name.lastIndexOf('.')) || file.name}`,
        ),
      );
      return;
    }
    if (file.size > IFC_MAX_UPLOAD_MB * 1024 * 1024) {
      reject(
        new ApiError(413, 'ASSET_TOO_LARGE',
          `업로드 용량이 한도를 넘었습니다 (${IFC_MAX_UPLOAD_MB}MB).`),
      );
      return;
    }

    const token = getToken();
    if (!token) {
      reject(new ApiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.'));
      return;
    }

    const form = new FormData();
    // 반복 필드가 아닙니다 — `files` 가 아니라 `file`, 한 개만 보냅니다.
    form.append('file', file, file.name);
    if (label) form.append('label', label);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/assets/ifc'));
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.responseType = 'text';

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        onProgress({
          loadedBytes: event.loaded,
          totalBytes: event.total,
          ratio: event.lengthComputable && event.total > 0 ? event.loaded / event.total : null,
        });
      };
    }

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort);
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as IfcJob);
        } catch {
          reject(new ApiError(xhr.status, 'INTERNAL', '업로드 응답을 해석하지 못했습니다.'));
        }
        return;
      }
      if (xhr.status === 401) clearToken();
      reject(parseXhrError(xhr));
    };

    xhr.onerror = () => {
      cleanup();
      reject(new ApiError(0, 'NETWORK_ERROR', '업로드 중 서버 연결이 끊겼습니다.'));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Upload aborted', 'AbortError'));
    };

    xhr.send(form);
  });
}

/** 변환 잡 1회 조회. */
export function getIfcJob(jobId: string, signal?: AbortSignal): Promise<IfcJob> {
  return request<IfcJob>(ifcJobPath(jobId), { auth: 'required', signal });
}

export interface WaitForIfcJobOptions {
  onProgress?: (job: IfcJob) => void;
  signal?: AbortSignal;
  /** 서버 권장 간격은 1초입니다. 더 짧게 물어봐도 얻는 것이 없습니다. */
  intervalMs?: number;
  /** 이 시간을 넘기면 포기합니다. 서버 변환 제한은 기본 900초입니다. */
  timeoutMs?: number;
}

/**
 * `status` 가 `ready` 가 될 때까지 폴링합니다.
 *
 * 변환은 별도 프로세스에서 돌고 32.9MB IFC 가 약 196초 걸리는 것이 측정돼 있습니다.
 * 진행률을 보여주지 않으면 사용자는 멈춘 화면을 봅니다.
 *
 * `ready` 응답에는 에셋 전체가 중첩되어 오므로 두 번째 요청 없이 바로 씁니다.
 * `progress` 는 완료 전까지 99 를 넘지 않으니 100 을 완료 신호로 쓰면 안 됩니다 —
 * 완료 판정은 `status` 로만 합니다.
 *
 * 상태 전이는 `queued → converting → (ready | failed)` 한 방향이고 되돌아오지 않습니다.
 */
export async function waitForIfcJob(
  jobId: string,
  options: WaitForIfcJobOptions = {},
): Promise<Asset> {
  const { onProgress, signal, intervalMs = 1000, timeoutMs = 20 * 60 * 1000 } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const job = await getIfcJob(jobId, signal);
    onProgress?.(job);

    if (job.status === 'ready') {
      if (!job.asset) {
        throw new ApiError(500, 'INTERNAL', '변환은 끝났지만 에셋 정보가 없습니다.');
      }
      return job.asset;
    }
    if (job.status === 'failed') {
      throw new ApiError(
        422,
        job.errorCode ?? 'IFC_CONVERT_FAILED',
        job.errorMessage ?? 'IFC 변환에 실패했습니다.',
      );
    }
    if (Date.now() > deadline) {
      throw new ApiError(504, 'IFC_CONVERT_TIMEOUT',
        'IFC 변환이 제한 시간 안에 끝나지 않았습니다.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}
