/**
 * 측정 세션 설정.
 *
 * Phase 1 베이스라인(`scripts/measure.py`)과 **같은 규율**을 뷰어 쪽 표본에도 적용하기 위한 값들입니다.
 * 필드 이름은 `results/session_*.json` 과 맞춰 두었습니다. 나중에 CSV 와 조인할 때
 * 이름이 다르면 손으로 맞춰야 하기 때문입니다.
 *
 * 주의: **Phase 1 의 전송 시간 베이스라인은 여기서 재지 않습니다.** 브라우저는 캐시·커넥션 재사용·
 * 동시 요청 제한 때문에 변수가 많아, 그 숫자는 `scripts/measure.py` 가 만든 값을 씁니다.
 * 여기서 재는 것은 브라우저에서만 알 수 있는 "방 입장 ~ 렌더링 완료"(`joinToRenderMs`)입니다.
 */

const KEY = 'of_kor_3d.measurement';

export type MeasurementLocation = 'campus' | 'home' | 'mobile' | 'unknown';
export type NetworkType = 'wired' | 'wifi' | 'lte' | '5g' | 'unknown';

export interface MeasurementSettings {
  /** 활성 벤치마크 run id. 비어 있으면 서버가 표본을 DB 에 저장하지 않습니다. */
  runId: string;
  location: MeasurementLocation;
  networkType: NetworkType;
  /**
   * 매 요청 URL 에 `?t={timestamp}` 를 붙여 캐시를 무력화합니다.
   * 두 번째 요청이 갑자기 10배 빨라지면 캐시를 의심하라 — 명세 §9.
   */
  cacheBust: boolean;
  /** 첫 로드(연결 수립 비용이 섞인 워밍업)를 보고에서 제외합니다. */
  discardWarmup: boolean;
}

const DEFAULTS: MeasurementSettings = {
  runId: '',
  location: 'unknown',
  networkType: 'unknown',
  cacheBust: false,
  discardWarmup: true,
};

export function getMeasurementSettings(): MeasurementSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<MeasurementSettings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function setMeasurementSettings(patch: Partial<MeasurementSettings>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...getMeasurementSettings(), ...patch }));
  } catch {
    /* 저장할 수 없으면 이번 세션 동안 기본값으로 동작합니다. */
  }
}

/** 측정 중인지 여부. run id 가 있어야 서버가 표본을 남깁니다. */
export function isMeasuring(): boolean {
  return getMeasurementSettings().runId.trim().length > 0;
}

let assetLoadCount = 0;

/**
 * 이 탭에서 몇 번째 에셋 로드인지 돌려줍니다(0부터).
 * 첫 요청은 연결 수립 비용이 섞이므로 워밍업으로 버립니다 — Phase 1 하네스와 같은 규칙입니다.
 */
export function markAssetLoad(): number {
  return assetLoadCount++;
}

/** 이 표본을 보고할지 여부 */
export function shouldReportLoad(loadIndex: number): boolean {
  const { discardWarmup } = getMeasurementSettings();
  return !(discardWarmup && loadIndex === 0);
}

/**
 * asset-load 보고의 `raw` 에 함께 실을 맥락 정보.
 * 측정값만 있고 맥락이 없으면 9월 비교에서 쓸 수 없습니다.
 */
export function measurementContext(): Record<string, unknown> {
  const settings = getMeasurementSettings();
  const connection = (
    navigator as Navigator & {
      connection?: { effectiveType?: string; downlink?: number; rtt?: number };
    }
  ).connection;

  return {
    location: settings.location,
    network_type: settings.networkType,
    cache_bust: settings.cacheBust,
    user_agent: navigator.userAgent,
    device_pixel_ratio: window.devicePixelRatio,
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    // NetworkInformation 은 크로미움 계열에만 있습니다. 없으면 null 로 남깁니다.
    effective_type: connection?.effectiveType ?? null,
    downlink_mbps: connection?.downlink ?? null,
    connection_rtt_ms: connection?.rtt ?? null,
  };
}
