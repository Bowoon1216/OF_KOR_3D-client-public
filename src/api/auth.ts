import { request } from './http';
import type { LoginResponse, SignupRequest, User } from './types';

/** `POST /api/auth/signup` */
export function signup(body: SignupRequest): Promise<User> {
  return request<User>('/api/auth/signup', { method: 'POST', body, auth: 'none' });
}

/** `POST /api/auth/login` */
export function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: 'none',
  });
}

/** `GET /api/auth/me` — 저장된 토큰이 아직 유효한지 확인하는 용도로도 씁니다. */
export function me(signal?: AbortSignal): Promise<User> {
  return request<User>('/api/auth/me', { auth: 'required', signal });
}

/** `GET /healthz` — 서버 주소 설정 화면에서 연결 확인용 */
export function healthz(signal?: AbortSignal): Promise<{ status: string }> {
  return request<{ status: string }>('/healthz', { auth: 'none', signal });
}
