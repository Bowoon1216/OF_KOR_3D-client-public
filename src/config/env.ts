/**
 * 서버 주소 한 곳에서만 관리합니다.
 *
 * 우선순위:  localStorage 오버라이드  >  빌드 시 주입된 VITE_* 값  >  기본값
 *
 * localStorage 오버라이드는 빌드를 다시 하지 않고도 데모 현장에서 주소를 바꾸기 위한 것입니다
 * (Header → Settings). 9월 KOREN 전환 시에는 `.env.local` 쪽을 바꾸는 것이 정석입니다.
 */

const DEFAULT_API_BASE_URL = 'http://localhost:8000';

const API_OVERRIDE_KEY = 'of_kor_3d.apiBaseUrl';
const WS_OVERRIDE_KEY = 'of_kor_3d.wsBaseUrl';

/** 끝의 `/` 를 떼어 `${base}${path}` 조합이 항상 슬래시 하나가 되게 합니다. */
function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function readOverride(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? normalizeBase(raw) : null;
  } catch {
    // Safari 프라이빗 모드 등에서 localStorage 접근이 막히면 환경변수만 씁니다.
    return null;
  }
}

function envValue(key: 'VITE_API_BASE_URL' | 'VITE_WS_BASE_URL'): string | null {
  // Vite 밖(테스트 하네스 등)에서는 import.meta.env 자체가 없습니다.
  const raw = (import.meta.env as Record<string, string | undefined> | undefined)?.[key];
  return typeof raw === 'string' && raw.trim() ? normalizeBase(raw) : null;
}

/** REST · 정적 파일의 기준 주소 (예: `http://localhost:8000`) */
export function getApiBaseUrl(): string {
  return (
    readOverride(API_OVERRIDE_KEY) ??
    envValue('VITE_API_BASE_URL') ??
    DEFAULT_API_BASE_URL
  );
}

/**
 * WebSocket 기준 주소.
 *
 * 명세상 `wsUrl`은 서버가 만들어 내려주므로 보통은 이 값이 필요 없습니다.
 * 다만 리버스 프록시나 다른 노트북에서 데모할 때 서버가 내려준 host 가 접근 불가능한 경우가 있어,
 * 명시적으로 지정되면 서버 URL의 경로만 떼어 이 base 에 붙입니다.
 */
export function getWsBaseUrl(): string | null {
  return readOverride(WS_OVERRIDE_KEY) ?? envValue('VITE_WS_BASE_URL');
}

export function setApiBaseUrl(value: string | null) {
  try {
    if (value && normalizeBase(value)) {
      localStorage.setItem(API_OVERRIDE_KEY, normalizeBase(value));
    } else {
      localStorage.removeItem(API_OVERRIDE_KEY);
    }
  } catch {
    /* 저장할 수 없으면 이번 세션에만 기본값으로 동작합니다. */
  }
}

export function setWsBaseUrl(value: string | null) {
  try {
    if (value && normalizeBase(value)) {
      localStorage.setItem(WS_OVERRIDE_KEY, normalizeBase(value));
    } else {
      localStorage.removeItem(WS_OVERRIDE_KEY);
    }
  } catch {
    /* 위와 동일 */
  }
}

/** 오버라이드를 지웠을 때 어떤 값으로 돌아가는지 보여주기 위한 값 */
export function getDefaultApiBaseUrl(): string {
  return envValue('VITE_API_BASE_URL') ?? DEFAULT_API_BASE_URL;
}

/** `/api/rooms` → `http://localhost:8000/api/rooms` */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * 서버가 내려준 에셋 경로(`/static/assets/...`)를 절대 URL로 바꿉니다.
 * `GLTFLoader`와 `fetch` 모두 상대 경로를 프론트엔드 origin 기준으로 해석하기 때문에 필요합니다.
 */
export function assetUrl(path: string): string {
  return apiUrl(path);
}

/**
 * 서버가 내려준 `wsUrl`을 실제 접속 가능한 주소로 바꿉니다.
 * WS base 가 설정돼 있으면 경로·쿼리만 옮겨 붙이고, 없으면 서버 값을 그대로 씁니다.
 */
export function resolveWsUrl(serverWsUrl: string): string {
  const base = getWsBaseUrl();
  if (!base) return serverWsUrl;
  try {
    const parsed = new URL(serverWsUrl);
    return `${base}${parsed.pathname}${parsed.search}`;
  } catch {
    return `${base}${serverWsUrl.startsWith('/') ? serverWsUrl : `/${serverWsUrl}`}`;
  }
}
