import { clearToken, getToken } from '../auth/tokenStore';
import { apiUrl } from '../config/env';
import { ApiError } from './errors';

export type AuthMode =
  /** 토큰이 없으면 요청을 보내지 않고 바로 실패시킵니다. */
  | 'required'
  /** 토큰이 있으면 싣고, 없으면 그냥 보냅니다. (게스트 입장 등) */
  | 'optional'
  /** 토큰을 절대 싣지 않습니다. (로그인 / 회원가입) */
  | 'none';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON 으로 직렬화해 보낼 본문 */
  body?: unknown;
  /** `undefined` / `null` 인 값은 자동으로 빠집니다. */
  query?: Record<string, string | number | boolean | undefined | null>;
  auth?: AuthMode;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = apiUrl(path);
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** 서버가 낸 error 인지, 프록시/네트워크가 낸 오류인지 구분해 ApiError 로 통일합니다. */
async function toApiError(response: Response): Promise<ApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const envelope = (payload as { error?: unknown } | null)?.error;
  if (envelope && typeof envelope === 'object') {
    const { code, message, detail } = envelope as {
      code?: string;
      message?: string;
      detail?: Record<string, unknown>;
    };
    return new ApiError(
      response.status,
      code ?? 'INTERNAL',
      message ?? `요청이 실패했습니다. (${response.status})`,
      detail ?? {},
    );
  }

  return new ApiError(
    response.status,
    response.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL',
    `요청이 실패했습니다. (${response.status})`,
  );
}

/**
 * 모든 REST 호출의 단일 통로.
 *
 * 업로드(진행률 필요)와 에셋 다운로드(스트리밍 필요)만 이 함수를 쓰지 않고
 * 각각 `assets.ts`의 XHR, `assetDownload.ts`의 ReadableStream 을 씁니다.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, auth = 'optional', signal, headers = {} } = options;

  const token = auth === 'none' ? null : getToken();
  if (auth === 'required' && !token) {
    throw new ApiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
  }

  const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      '서버에 연결할 수 없습니다. 서버 주소와 실행 상태를 확인해 주세요.',
      { cause: String(error) },
    );
  }

  if (!response.ok) {
    const error = await toApiError(response);
    // 만료·위조 토큰은 여기서 버려야 이후 요청이 계속 401 을 맞지 않습니다.
    if (response.status === 401 && token) clearToken();
    throw error;
  }

  // 204 No Content 와 202 Accepted(본문 없음)
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return (await response.text()) as T;
  }
  return (await response.json()) as T;
}
