/**
 * 서버는 `"2 hours ago"` 같은 상대 시간 문자열을 만들지 않습니다(명세 1.1).
 * 로케일·타임존에 종속되므로 브라우저의 `Intl.RelativeTimeFormat` 이 처리합니다.
 */

const relative = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '-';

  const diff = timestamp - Date.now();
  const absolute = Math.abs(diff);

  for (const [unit, ms] of UNITS) {
    if (absolute >= ms) {
      return relative.format(Math.round(diff / ms), unit);
    }
  }
  return '방금 전';
}

const dateTime = new Intl.DateTimeFormat('ko', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? '-' : dateTime.format(timestamp);
}

/** 12.6 MB 처럼 사람이 읽는 크기 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
