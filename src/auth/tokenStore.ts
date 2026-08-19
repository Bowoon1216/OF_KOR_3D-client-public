/**
 * access token 보관소.
 *
 * 유효기간 12시간에 refresh token 이 없으므로, 만료 시각을 함께 저장해 두고
 * 만료된 토큰은 요청을 보내기 전에 스스로 버립니다. (서버 401 을 기다릴 필요가 없습니다)
 */

const TOKEN_KEY = 'of_kor_3d.accessToken';
const EXPIRES_KEY = 'of_kor_3d.accessTokenExpiresAt';

type Listener = (token: string | null) => void;

const listeners = new Set<Listener>();
let cached: string | null | undefined;

function notify(token: string | null) {
  for (const listener of listeners) listener(token);
}

export function getToken(): string | null {
  if (cached !== undefined) return cached;
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const expiresAt = Number(localStorage.getItem(EXPIRES_KEY) ?? 0);
    if (!token) {
      cached = null;
    } else if (expiresAt && Date.now() >= expiresAt) {
      clearToken();
      cached = null;
    } else {
      cached = token;
    }
  } catch {
    cached = null;
  }
  return cached;
}

/** @param expiresInSeconds 로그인 응답의 `expiresIn` */
export function setToken(token: string, expiresInSeconds?: number) {
  cached = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
    if (expiresInSeconds && expiresInSeconds > 0) {
      // 시계 오차와 왕복 시간을 감안해 30초 일찍 만료된 것으로 봅니다.
      const expiresAt = Date.now() + (expiresInSeconds - 30) * 1000;
      localStorage.setItem(EXPIRES_KEY, String(expiresAt));
    } else {
      localStorage.removeItem(EXPIRES_KEY);
    }
  } catch {
    /* 저장 실패해도 이번 탭에서는 메모리 캐시로 동작합니다. */
  }
  notify(token);
}

export function clearToken() {
  cached = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRES_KEY);
  } catch {
    /* 무시 */
  }
  notify(null);
}

/** 401 을 받았을 때 AuthProvider 가 사용자 상태를 정리하도록 알립니다. */
export function subscribeToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
