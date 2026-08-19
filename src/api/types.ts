/** 명세서의 응답 형태를 그대로 옮긴 타입들입니다. 모든 시각은 ISO 8601 UTC 문자열입니다. */

export type Role = 'host' | 'engineer' | 'viewer';
export type RoomStatus = 'live' | 'ended';
export type NetworkProfile = 'local' | 'commercial' | 'koren' | 'netem';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** 서버가 만든 표시 문자열. 프론트에 매핑 테이블을 두지 않습니다. */
  roleLabel: string;
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  tokenType: string;
  /** 만료까지 남은 초 (43200 = 12시간) */
  expiresIn: number;
  user: User;
}

export interface SignupRequest {
  email: string;
  password: string;
  name: string;
  role?: Role;
}

export interface AssetSummary {
  id: string;
  entryFilename: string;
  /** `/static/assets/{id}/{filename}` — 절대 URL 로 바꾸려면 `assetUrl()` 을 씁니다. */
  url: string;
  sizeBytes: number;
}

export interface AssetFile {
  filename: string;
  sizeBytes: number;
  contentType: string;
}

export interface Asset extends AssetSummary {
  label: string | null;
  contentType: string;
  fileCount: number;
  /** 엔트리 파일 해시. 벤치마크에서 같은 바이트를 쟀는지 증명하는 근거 */
  sha256: string;
  uploadedAt: string;
  files: AssetFile[];
}

export interface AssetListResponse {
  items: Asset[];
  total: number;
}

export type IfcJobStatus = 'queued' | 'converting' | 'ready' | 'failed';

/**
 * `POST /api/assets/ifc` 의 변환 잡.
 *
 * 업로드 응답은 202 이고 그 시점의 `status` 는 `queued` 또는 `converting` 이라
 * `asset` 은 항상 null 입니다. **이 응답으로는 뷰어를 열 수 없습니다** —
 * `status === 'ready'` 가 될 때까지 폴링해서 `asset` 을 받아야 합니다.
 *
 * 변환된 GLB 만 에셋 목록에 들어갑니다. 변환 중인 잡을 에셋으로 노출하지 않기 때문에
 * 방 생성·도면 교체·목록 쪽은 "준비 안 된 에셋" 을 방어할 필요가 없습니다.
 */
export interface IfcJob {
  /** `j_` 접두사. 폴링 대상 식별자 (에셋 id 가 아닙니다) */
  id: string;
  status: IfcJobStatus;
  sourceFilename: string;
  sourceSizeBytes: number;
  label: string | null;
  /** 0 ~ 100 */
  progress: number;
  /** `ready` 일 때만 채워집니다 */
  asset: Asset | null;
  errorCode: string | null;
  /** 사용자에게 그대로 보여줘도 되는 한국어 문장 */
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Participant {
  id: string;
  name: string;
  role: Role;
  roleLabel: string;
  /** WebSocket 에 실제로 붙어 있는지. 자리만 예약한 상태면 false */
  active: boolean;
  mic: boolean;
  vid: boolean;
  /** 손 인식 여부. false 면 웹캠 인식 이탈 */
  tracking: boolean;
  isHost: boolean;
  isGuest: boolean;
  /** presenceUpdate 로만 실려 오는 부가 상태 */
  status?: 'reconnecting' | string;
}

export interface Transform {
  /** position (x, y, z) — 서버가 ±1000 으로 클램프 */
  p: [number, number, number];
  /** quaternion (x, y, z, w) — 서버가 크기 1 로 정규화 */
  q: [number, number, number, number];
  /** scale (x, y, z) — 서버가 0.05~20 으로 클램프 */
  s: [number, number, number];
}

export interface RoomState {
  seq: number;
  objectId: string;
  transform: Transform;
  updatedBy: string | null;
}

export interface Room {
  id: string;
  code: string;
  title: string;
  category: string;
  status: RoomStatus;
  maxParticipants: number;
  participants: number;
  joinable: boolean;
  createdAt: string;
  endedAt: string | null;
  asset: AssetSummary | null;
  roster: Participant[];
  /** REST 에서는 항상 null 입니다. 실시간 상태는 WebSocket `welcome` 에만 실립니다. */
  state: RoomState | null;
  wsUrl: string;
}

export interface RoomSummary {
  id: string;
  code: string;
  title: string;
  category: string;
  status: RoomStatus;
  /** 진행 중이면 현재 접속자 수, 종료됐으면 최대 인원 */
  participants: number;
  peakParticipants: number;
  createdAt: string;
  endedAt: string | null;
  relation: 'owner' | 'participant';
}

export interface RoomListResponse {
  items: RoomSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateRoomRequest {
  title?: string;
  category?: string;
  assetId?: string;
  maxParticipants?: number;
  /**
   * 방 코드가 살아 있는 시간(1~24시간).
   *
   * 명세 4.1 의 필드 표에는 없는 **확장 필드**입니다. 서버가 아직 모르는 필드라면
   * `createRoom()` 이 이 값만 빼고 한 번 더 시도하므로 세션 생성 자체는 막히지 않습니다.
   * 그동안 만료 시각은 클라이언트가 `roomCodeExpiry.ts` 에 기억해 두고 보여 줍니다.
   */
  codeExpiresInHours?: number;
}

export interface UpdateRoomRequest {
  title?: string;
  category?: string;
  assetId?: string;
}

export interface JoinRoomRequest {
  name?: string;
  role?: Role;
}

export interface JoinRoomResponse {
  participantId: string;
  /** 재접속 시 원래 자리로 돌아가기 위한 토큰. sessionStorage 에 보관합니다. */
  resumeToken: string;
  name: string;
  role: Role;
  roleLabel: string;
  isHost: boolean;
  isGuest: boolean;
  /** `pid` 까지 포함된 완성된 접속 주소 */
  wsUrl: string;
  /** 이때까지 WebSocket 을 열지 않으면 자리가 풀립니다. (기본 60초) */
  reservedUntil: string;
}

/* ── 계측 ─────────────────────────────────────────────────────── */

export interface MetricWindow {
  n: number;
  last?: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  jitterMs?: number;
  /** 목표치(100ms)를 넘은 표본 비율. 대표 수치로 이것을 씁니다. */
  overTargetPct: number;
  targetMs: number;
  /** 최근 표본이 없음. true 면 0 으로 표시하지 말고 회색 처리합니다. */
  stale: boolean;
}

export interface RoomTelemetry {
  ts?: number;
  roomCode: string;
  peers: number;
  networkProfile: NetworkProfile;
  /** 종단 지연. 검증 지표 100ms 는 이 값 */
  sync: MetricWindow;
  rtt: MetricWindow;
  relay: MetricWindow;
  /** 병합되어 전송되지 않은 frame 비율 */
  coalescedPct: number;
  droppedRateLimited: number;
}

export interface MetricSummary {
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  overTargetPct: number | null;
  spreadP99P50Ms: number | null;
}

export interface RunScenario {
  clients?: number;
  rateHz?: number;
  durationS?: number;
  [key: string]: unknown;
}

export interface MetricsRun {
  id: string;
  label: string | null;
  networkProfile: NetworkProfile;
  scenario: RunScenario | null;
  assetSha256: string | null;
  status: 'running' | 'completed';
  startedAt: string;
  endedAt: string | null;
}

export interface CreateRunRequest {
  id: string;
  networkProfile: NetworkProfile;
  label?: string;
  scenario?: RunScenario;
  assetSha256?: string;
  operator?: string;
  notes?: string;
}

export interface RunSummary {
  runId: string;
  networkProfile: NetworkProfile;
  scenario: RunScenario | null;
  durationS: number;
  targetMs: number;
  metrics: { e2e: MetricSummary; rtt: MetricSummary; relay: MetricSummary };
  assetLoad: { n: number; joinToRenderP50Ms: number | null; joinToRenderP95Ms: number | null };
  reliability: Record<string, unknown>;
  integrity: { metricsDropped: number };
}

export interface CompareResponse {
  baseline: RunSummary;
  target: RunSummary;
  comparable: boolean;
  comparabilityNote: string | null;
  deltas: Record<
    string,
    {
      p50_ms_delta: number;
      p50_ms_delta_pct: number;
      p95_ms_delta: number;
      p95_ms_delta_pct: number;
      over_target_pct_delta: number;
    }
  >;
}

export interface AssetLoadReport {
  runId?: string;
  roomCode?: string;
  clientId?: string;
  requestId?: string;
  assetPath: string;
  assetBytes: number;
  /** 검증 지표 "초기 도면 로딩" */
  joinToRenderMs: number;
  ttfbMs?: number;
  downloadMs?: number;
  parseMs?: number;
  gpuMs?: number;
  raw?: Record<string, unknown>;
}
