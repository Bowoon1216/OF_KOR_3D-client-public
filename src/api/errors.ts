/** 명세 8장의 error code 목록. WebSocket error frame 도 같은 체계를 씁니다. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'EMAIL_TAKEN'
  | 'BAD_ROOM_CODE'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_ENDED'
  | 'ROOM_FULL'
  | 'PARTICIPANT_NOT_FOUND'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_TOO_LARGE'
  | 'UNSUPPORTED_EXTENSION'
  | 'UNSAFE_FILENAME'
  | 'NO_ENTRY_FILE'
  | 'BAD_MESSAGE'
  | 'INVALID_TRANSFORM'
  | 'NOT_CONTROLLER'
  | 'SLOW_CLIENT'
  | 'REPLACED_BY_NEW_SESSION'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  // 서버가 아니라 브라우저 쪽에서 실패한 경우
  | 'NETWORK_ERROR';

export interface ValidationIssue {
  type: string;
  loc: (string | number)[];
  msg: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

/**
 * 서버 error 형식(`{ "error": { code, message, detail } }`)을 그대로 담습니다.
 * `message`는 사용자에게 보여줘도 되는 한국어 문장이므로 가공하지 않습니다.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly detail: Record<string, unknown>;

  constructor(
    status: number,
    code: ApiErrorCode | string,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** 422 응답의 필드별 오류 */
  get validationIssues(): ValidationIssue[] {
    const errors = this.detail?.errors;
    return Array.isArray(errors) ? (errors as ValidationIssue[]) : [];
  }

  /** 422 를 `{ 필드명: 메시지 }` 로 펴서 폼에 바로 꽂을 수 있게 합니다. */
  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const issue of this.validationIssues) {
      // loc 은 ["body", "password"] 형태라 마지막 원소가 필드명입니다.
      const field = issue.loc?.[issue.loc.length - 1];
      if (typeof field === 'string' && !(field in result)) {
        result[field] = issue.msg;
      }
    }
    return result;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** 어떤 에러든 화면에 띄울 한 문장으로 만듭니다. */
export function toMessage(error: unknown, fallback = '요청을 처리하지 못했습니다.'): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
