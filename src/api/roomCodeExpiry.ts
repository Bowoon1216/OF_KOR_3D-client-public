/**
 * 방 코드의 만료 시각을 브라우저에 기억해 둡니다.
 *
 * 명세 4.1 에는 코드 유효기간 필드가 없어 서버가 만료 시각을 돌려주지 않습니다.
 * 서버가 `codeExpiresInHours` 를 받아들이게 되면 응답 값으로 갈아타면 되고,
 * 그때까지는 세션을 만든 사람에게 "언제까지 쓸 수 있는 코드인지"를 보여 주는 용도입니다.
 * 다른 참가자의 브라우저에는 없는 값이므로 **입장 차단에는 쓰지 않습니다.**
 */

const STORAGE_KEY = 'of_kor_3d.codeExpiry';

/** 명세에 없는 값이라 클라이언트가 범위를 정합니다. 최소 1시간, 기본이자 최대 24시간. */
export const MIN_CODE_TTL_HOURS = 1;
export const MAX_CODE_TTL_HOURS = 24;
export const DEFAULT_CODE_TTL_HOURS = 24;

type ExpiryMap = Record<string, number>;

function readAll(): ExpiryMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as ExpiryMap) : {};
  } catch {
    return {};
  }
}

function writeAll(map: ExpiryMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 저장하지 못해도 세션 자체는 동작합니다. 만료 표시만 사라집니다. */
  }
}

/** 만료 시각(epoch ms)을 기록하고 그 값을 돌려줍니다. */
export function rememberCodeExpiry(code: string, hours: number): number {
  const expiresAt = Date.now() + hours * 60 * 60 * 1000;
  const map = readAll();
  // 이미 지난 항목은 이 참에 같이 치웁니다. 코드 하나당 몇 바이트라도 계속 쌓이면 곤란합니다.
  const now = Date.now();
  const pruned: ExpiryMap = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === 'number' && value > now) pruned[key] = value;
  }
  pruned[code] = expiresAt;
  writeAll(pruned);
  return expiresAt;
}

export function readCodeExpiry(code: string): number | null {
  const value = readAll()[code];
  return typeof value === 'number' ? value : null;
}
