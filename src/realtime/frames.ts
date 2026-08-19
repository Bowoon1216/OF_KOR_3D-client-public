import type {
  AssetSummary,
  NetworkProfile,
  Participant,
  RoomState,
  RoomTelemetry,
  Role,
  Transform,
} from '../api/types';

/** 모든 frame 은 `t` 필드로 종류를 구분합니다. */

/* ── Client → Server ──────────────────────────────────────────── */

export type GestureKind = 'ROTATE' | 'PAN' | 'PINCH';

export interface GesturePayload {
  kind: GestureKind;
  /** MediaPipe 정규화 손 좌표(0~1). 상대방 손 커서 표시용 */
  x?: number;
  y?: number;
  strength?: number;
}

export interface ClientStateFrame {
  t: 'state';
  /** 클라이언트 자체 카운터. 유실 진단용이며 권위는 서버의 `seq` 에 있습니다. */
  cseq: number;
  /** 생성 시각(서버 시계로 보정한 값). 지연 측정에 쓰입니다. */
  tOrigin: number;
  transform: Transform;
  gesture?: GesturePayload;
}

export interface ClientPingFrame {
  t: 'ping';
  seq: number;
  /** `performance.timeOrigin + performance.now()`. `Date.now()` 는 NTP 보정으로 튑니다. */
  t0: number;
}

export interface ClientPongFrame {
  t: 'pong';
  seq: number;
  /** 서버 ping 의 `sSend` 를 그대로 되돌려 줍니다. */
  sSend: number;
}

export interface ClientPresenceFrame {
  t: 'presence';
  mic: boolean;
  vid: boolean;
}

export type TrackingLostReason =
  | 'no_hand'
  | 'low_confidence'
  | 'occluded'
  | 'camera_off'
  | 'permission_denied';

export interface ClientTrackingFrame {
  t: 'tracking';
  status: 'ok' | 'lost';
  reason?: TrackingLostReason;
}

export interface ClientStateRequestFrame {
  t: 'stateRequest';
  sinceSeq: number;
}

export interface ClientControlReleaseFrame {
  t: 'controlRelease';
}

export interface ClientTelemetryReportFrame {
  t: 'telemetryReport';
  windowMs: number;
  e2e: { n: number; p50: number; p95: number; max: number };
  /** 원시 표본. 최대 200개. 저장·분석의 근거는 이것입니다. */
  e2eSamples: number[];
  /** 1/K 로 추출했으면 K */
  sampledWeight: number;
  clockOffsetMs: number;
  clockUncertaintyMs: number;
}

export interface ClientLeaveFrame {
  t: 'leave';
}

/**
 * WebRTC 시그널링 payload. 서버는 내용을 들여다보지 않고 상대에게 그대로 전달합니다.
 * (SDP·ICE 규격은 브라우저가 정하므로 서버가 검증할 것이 없습니다.)
 */
export type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }
  | { kind: 'bye' };

/** 참가자 한 명에게만 보내는 1:1 메시지. `to` 는 같은 방의 참가자 id 여야 합니다. */
export interface ClientSignalFrame {
  t: 'signal';
  to: string;
  data: SignalPayload;
}

export type ClientFrame =
  | ClientStateFrame
  | ClientPingFrame
  | ClientPongFrame
  | ClientPresenceFrame
  | ClientTrackingFrame
  | ClientStateRequestFrame
  | ClientControlReleaseFrame
  | ClientTelemetryReportFrame
  | ClientSignalFrame
  | ClientLeaveFrame;

/* ── Server → Client ──────────────────────────────────────────── */

export interface RoomConfig {
  /**
   * 서버가 `signal` frame 중계를 지원하는지. 내려오지 않으면 미지원으로 봅니다.
   * 지원하지 않는 서버에 `signal` 을 보내면 잘못된 frame 으로 취급돼 1008 로 끊길 수 있습니다.
   */
  signalRelay?: boolean;
  heartbeatMs: number;
  recommendedSendHz: number;
  maxStateHz: number;
  controlLeaseMs: number;
  latencyTargetMs: number;
  networkProfile: NetworkProfile;
}

export interface ControlInfo {
  holder: string | null;
  expiresAtMs: number | null;
}

export interface WelcomeFrame {
  t: 'welcome';
  serverTime: number;
  session: {
    id: string;
    code: string;
    title: string;
    category: string;
    maxParticipants: number;
  };
  you: {
    id: string;
    name: string;
    role: Role;
    isHost: boolean;
    isGuest: boolean;
    reconnected: boolean;
  };
  roster: Participant[];
  rosterVersion: number;
  state: RoomState | null;
  asset: AssetSummary | null;
  control: ControlInfo;
  config: RoomConfig;
}

export interface ServerStateFrame {
  t: 'state';
  /** 방 단위 단조 증가 번호. 이전보다 작거나 같으면 무시합니다. */
  seq: number;
  origin: string;
  objectId: string;
  transform: Transform;
  tOrigin?: number;
  /** 서버 수신·송신 시각. 차이가 서버 내부 처리 시간 */
  sRecv?: number;
  sSend?: number;
  gesture?: GesturePayload;
}

export interface ServerPingFrame {
  t: 'ping';
  seq: number;
  sSend: number;
}

export interface ServerPongFrame {
  t: 'pong';
  seq: number;
  t0: number;
  t1: number;
  t2: number;
  peers: number;
}

export interface PresenceJoinFrame {
  t: 'presenceJoin';
  rosterVersion: number;
  participant: Participant;
}

export interface PresenceLeaveFrame {
  t: 'presenceLeave';
  rosterVersion: number;
  participantId: string;
  reason: 'client_close' | 'timeout' | 'slow_client' | 'replaced' | 'server_shutdown' | 'room_ended';
}

export interface PresenceUpdateFrame {
  t: 'presenceUpdate';
  rosterVersion: number;
  participant: Participant;
  event?: string;
}

export interface RosterFrame {
  t: 'roster';
  rosterVersion: number;
  roster: Participant[];
}

export interface ControlChangedFrame {
  t: 'controlChanged';
  holder: string | null;
  holderName: string | null;
  reason: 'acquired' | 'released' | 'expired' | 'disconnected' | 'tracking_lost';
}

export interface ControlDeniedFrame {
  t: 'controlDenied';
  holder: string | null;
  retryAfterMs: number;
}

export interface StateSnapshotFrame {
  t: 'stateSnapshot';
  seq: number;
  objectId: string;
  transform: Transform;
  updatedBy: string | null;
  control: ControlInfo;
}

export interface HostChangedFrame {
  t: 'hostChanged';
  rosterVersion: number;
  hostId: string;
  hostName: string;
}

export interface AssetChangedFrame {
  t: 'assetChanged';
  seq: number;
  changedBy: string;
  asset: AssetSummary | null;
  /** 모델이 바뀌면 이전 transform 은 의미가 없어 항등 변환으로 초기화됩니다. */
  transform: Transform;
}

export interface TelemetryFrame extends RoomTelemetry {
  t: 'telemetry';
  ts: number;
}

export interface SessionEndedFrame {
  t: 'sessionEnded';
  reason: string;
}

/** 서버가 `to` 참가자에게 중계해 준 시그널. `from` 은 보낸 참가자 id 입니다. */
export interface ServerSignalFrame {
  t: 'signal';
  from: string;
  data: SignalPayload;
}

export interface ServerErrorFrame {
  t: 'error';
  code: string;
  message: string;
  fatal: boolean;
}

export type ServerFrame =
  | WelcomeFrame
  | ServerStateFrame
  | ServerPingFrame
  | ServerPongFrame
  | PresenceJoinFrame
  | PresenceLeaveFrame
  | PresenceUpdateFrame
  | RosterFrame
  | ControlChangedFrame
  | ControlDeniedFrame
  | StateSnapshotFrame
  | HostChangedFrame
  | AssetChangedFrame
  | TelemetryFrame
  | SessionEndedFrame
  | ServerSignalFrame
  | ServerErrorFrame;

/** 명세 6.2 의 종료 코드 */
export const CLOSE_CODE_MESSAGE: Record<number, string> = {
  1000: '연결이 정상 종료되었습니다.',
  1001: '서버가 종료되었거나 응답이 없습니다.',
  1008: '잘못된 frame 을 반복 전송해 연결이 종료되었습니다.',
  1013: '클라이언트가 메시지를 따라가지 못해 연결이 종료되었습니다.',
  4400: '방 코드 형식이 올바르지 않습니다.',
  4401: '참가자 정보(pid)가 없습니다.',
  4404: '방 또는 참가자를 찾을 수 없습니다.',
  4409: '이미 종료된 방입니다.',
  4410: '방 정원이 가득 찼습니다.',
  4411: '같은 참가자로 새 연결이 열려 이 연결이 대체되었습니다.',
};

/** 자리를 다시 잡아야(= `join` 을 다시 호출해야) 하는 종료 코드 */
export function requiresRejoin(code: number): boolean {
  return code === 4401 || code === 4404;
}

/** 재접속을 시도해도 소용없는 종료 코드 */
export function isFatalClose(code: number): boolean {
  return code === 1000 || code === 4400 || code === 4409 || code === 4410 || code === 4411;
}
