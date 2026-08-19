import { ApiError } from './errors';
import { request } from './http';
import type {
  CreateRoomRequest,
  JoinRoomRequest,
  JoinRoomResponse,
  Room,
  RoomListResponse,
  RoomStatus,
  UpdateRoomRequest,
} from './types';

/**
 * `1234-5678` 과 `12345678` 을 모두 받아 서버에 보낼 형태로 다듬습니다.
 * 형식이 틀리면 왕복 한 번을 아끼려고 여기서 먼저 걸러 냅니다.
 */
export function normalizeRoomCode(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length !== 8) {
    throw new ApiError(400, 'BAD_ROOM_CODE', '방 코드는 8자리 숫자입니다. (예: 1234-5678)');
  }
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

export function isValidRoomCode(input: string): boolean {
  return input.replace(/\D/g, '').length === 8;
}

/**
 * `POST /api/rooms` — 인증 필수. 요청한 사용자가 방 소유자가 됩니다.
 *
 * `codeExpiresInHours` 는 명세 4.1 의 필드 표에 없는 확장 필드입니다. 서버가 모르는 필드를
 * 거부(422)하면 그 값만 빼고 한 번 더 시도합니다. 아직 구현되지 않은 옵션 하나 때문에
 * 세션 생성 자체가 막히는 편이 훨씬 나쁘기 때문입니다.
 */
export async function createRoom(body: CreateRoomRequest = {}): Promise<Room> {
  try {
    return await request<Room>('/api/rooms', { method: 'POST', body, auth: 'required' });
  } catch (error) {
    if (
      body.codeExpiresInHours === undefined ||
      !(error instanceof ApiError) ||
      error.status !== 422
    ) {
      throw error;
    }
    const { codeExpiresInHours: _unsupported, ...supported } = body;
    return request<Room>('/api/rooms', { method: 'POST', body: supported, auth: 'required' });
  }
}

/** `GET /api/rooms/mine` — Dashboard 의 Recent Activity */
export function listMyRooms(
  params: { status?: RoomStatus | 'all'; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<RoomListResponse> {
  return request<RoomListResponse>('/api/rooms/mine', {
    auth: 'required',
    query: { status: params.status, limit: params.limit, offset: params.offset },
    signal,
  });
}

/** `GET /api/rooms/{code}` — 소켓을 열기 전에 코드가 맞는지 먼저 확인합니다. */
export function getRoom(code: string, signal?: AbortSignal): Promise<Room> {
  return request<Room>(`/api/rooms/${normalizeRoomCode(code)}`, { auth: 'optional', signal });
}

/** `POST /api/rooms/{code}/join` — 토큰이 없으면 게스트로 등록됩니다. */
export function joinRoom(code: string, body: JoinRoomRequest = {}): Promise<JoinRoomResponse> {
  return request<JoinRoomResponse>(`/api/rooms/${normalizeRoomCode(code)}/join`, {
    method: 'POST',
    body,
    auth: 'optional',
  });
}

/** `PATCH /api/rooms/{code}` — 소유자만 */
export function updateRoom(code: string, body: UpdateRoomRequest): Promise<Room> {
  return request<Room>(`/api/rooms/${normalizeRoomCode(code)}`, {
    method: 'PATCH',
    body,
    auth: 'required',
  });
}

/** `DELETE /api/rooms/{code}` — 소유자만. 이미 종료된 방에 다시 호출해도 204 입니다. */
export function endRoom(code: string): Promise<void> {
  return request<void>(`/api/rooms/${normalizeRoomCode(code)}`, {
    method: 'DELETE',
    auth: 'required',
  });
}
