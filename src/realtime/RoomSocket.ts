import type { AssetSummary, Participant, Transform } from '../api/types';
import { resolveWsUrl } from '../config/env';
import {
  CLOSE_CODE_MESSAGE,
  isFatalClose,
  requiresRejoin,
  type ClientFrame,
  type ControlInfo,
  type GesturePayload,
  type RoomConfig,
  type ServerFrame,
  type ServerStateFrame,
  type TrackingLostReason,
  type WelcomeFrame,
} from './frames';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

export interface ClockInfo {
  /** 서버 시계 = 내 시계 + offsetMs */
  offsetMs: number;
  /** 채택한 표본의 rtt/2 */
  uncertaintyMs: number;
  rttMs: number;
  samples: number;
}

export interface LatencyInfo {
  /** 최근 1초 창의 종단 지연 */
  n: number;
  last: number;
  p50: number;
  p95: number;
  max: number;
}

/** 훅에서 구독하는 이벤트 목록 */
export interface RoomSocketEvents {
  status: { status: ConnectionStatus; closeCode?: number; message?: string };
  welcome: WelcomeFrame;
  /** 다른 참가자가 만든 상태. 자기 에코는 여기로 오지 않습니다. */
  state: { seq: number; transform: Transform; origin: string; gesture?: GesturePayload };
  roster: Participant[];
  control: ControlInfo & { holderName?: string | null; reason?: string };
  controlDenied: { holder: string | null; retryAfterMs: number };
  asset: { asset: AssetSummary | null; transform: Transform };
  telemetry: import('../api/types').RoomTelemetry;
  clock: ClockInfo;
  latency: LatencyInfo;
  sessionEnded: { reason: string };
  error: { code: string; message: string; fatal: boolean };
  /** join 을 다시 호출해 자리를 새로 받아야 합니다. */
  needsRejoin: { closeCode: number; message: string };
}

type Handler<K extends keyof RoomSocketEvents> = (payload: RoomSocketEvents[K]) => void;

export interface RoomSocketOptions {
  /** `POST /api/rooms/{code}/join` 이 내려준 `wsUrl` (pid 포함) */
  wsUrl: string;
  /** 로그인 사용자의 access token. 게스트는 생략합니다. */
  token?: string | null;
  /** 재접속 최대 시도 횟수 */
  maxReconnectAttempts?: number;
}

const DEFAULT_CONFIG: RoomConfig = {
  heartbeatMs: 2000,
  recommendedSendHz: 30,
  maxStateHz: 60,
  controlLeaseMs: 1500,
  latencyTargetMs: 100,
  networkProfile: 'local',
};

/** 시계 동기화: 접속 직후 250ms 간격 8회, 이후 10초마다 1회 */
const CLOCK_BURST_COUNT = 8;
const CLOCK_BURST_INTERVAL_MS = 250;
const CLOCK_STEADY_INTERVAL_MS = 10_000;
/** offset 은 한 번에 이만큼 이상 움직이지 않습니다. */
const MAX_OFFSET_STEP_MS = 50;
/** telemetryReport 창 크기 */
const TELEMETRY_WINDOW_MS = 1000;
const MAX_SAMPLES_PER_REPORT = 200;

/** `Date.now()` 대신 쓰는 단조 시계. NTP 보정으로 계단식으로 튀지 않습니다. */
function monotonicNow(): number {
  return performance.timeOrigin + performance.now();
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function isFiniteTransform(transform: Transform): boolean {
  return [...transform.p, ...transform.q, ...transform.s].every(Number.isFinite);
}

/**
 * 방 하나의 WebSocket 연결을 관리합니다.
 *
 * 담당하는 것:
 *  - `welcome` 수신 → 초기 동기화
 *  - 서버 `ping` 에 `pong` 응답 (안 하면 6초 후 끊깁니다)
 *  - 자체 `ping`/`pong` 으로 시계 오프셋 추정
 *  - 30Hz 로 **병합된** 절대 transform 송신 (rAF 마다 보내지 않습니다)
 *  - 수신 `seq` 역전 폐기, 자기 에코 제외
 *  - 1초마다 `telemetryReport`
 *  - 끊기면 지수 백오프 재접속 + `stateRequest` 재동기화
 */
export class RoomSocket {
  private socket: WebSocket | null = null;
  private readonly options: RoomSocketOptions;
  private readonly listeners = new Map<keyof RoomSocketEvents, Set<Handler<never>>>();

  private status: ConnectionStatus = 'idle';
  private closedByUser = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;

  private myId: string | null = null;
  private config: RoomConfig = DEFAULT_CONFIG;
  private rosterVersion = -1;
  private roster: Participant[] = [];

  /** 서버가 매긴 마지막 seq. 이보다 작거나 같은 frame 은 버립니다. */
  private lastSeq = 0;
  private cseq = 0;

  /* 송신 병합 */
  private pendingTransform: Transform | null = null;
  private pendingGesture: GesturePayload | undefined;
  private sendTimer: number | null = null;

  /* 시계 */
  private clockOffsetMs = 0;
  private clockUncertaintyMs = Number.POSITIVE_INFINITY;
  private bestRttMs = Number.POSITIVE_INFINITY;
  private clockSamples = 0;
  private clockSeq = 0;
  private pendingPings = new Map<number, number>();
  private clockTimer: number | null = null;
  private clockBurstLeft = 0;

  /* 지연 표본 */
  private e2eSamples: number[] = [];
  private telemetryTimer: number | null = null;

  /* 서버 무응답 감시 */
  private lastMessageAt = 0;
  private watchdogTimer: number | null = null;

  constructor(options: RoomSocketOptions) {
    this.options = options;
  }

  /* ── 구독 ───────────────────────────────────────────────── */

  on<K extends keyof RoomSocketEvents>(type: K, handler: Handler<K>): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler as Handler<never>);
    this.listeners.set(type, set);
    return () => set.delete(handler as Handler<never>);
  }

  private emit<K extends keyof RoomSocketEvents>(type: K, payload: RoomSocketEvents[K]) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of set) (handler as Handler<K>)(payload);
  }

  private setStatus(status: ConnectionStatus, extra: { closeCode?: number; message?: string } = {}) {
    this.status = status;
    this.emit('status', { status, ...extra });
  }

  /* ── 연결 ───────────────────────────────────────────────── */

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUser = false;
    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const url = new URL(resolveWsUrl(this.options.wsUrl));
    // WebSocket 은 헤더를 붙일 수 없어 토큰을 query 로 넘깁니다.
    if (this.options.token) url.searchParams.set('token', this.options.token);

    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = monotonicNow();
      this.setStatus('connected');
      this.startWatchdog();
      // welcome 을 기다렸다가 시계 동기화를 시작합니다.
    };

    socket.onmessage = (event) => {
      this.lastMessageAt = monotonicNow();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data as string) as ServerFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    };

    socket.onerror = () => {
      // onclose 가 이어서 오므로 여기서는 상태만 남깁니다.
    };

    socket.onclose = (event) => {
      this.teardownTimers();
      this.socket = null;

      const message = CLOSE_CODE_MESSAGE[event.code] ?? event.reason ?? '연결이 종료되었습니다.';

      if (this.closedByUser) {
        this.setStatus('closed', { closeCode: event.code, message });
        return;
      }

      if (requiresRejoin(event.code)) {
        this.setStatus('closed', { closeCode: event.code, message });
        this.emit('needsRejoin', { closeCode: event.code, message });
        return;
      }

      if (isFatalClose(event.code)) {
        this.setStatus('closed', { closeCode: event.code, message });
        return;
      }

      this.scheduleReconnect(message);
    };
  }

  private scheduleReconnect(message: string) {
    const max = this.options.maxReconnectAttempts ?? 8;
    if (this.reconnectAttempts >= max) {
      this.setStatus('closed', { message: '재접속에 실패했습니다. 새로고침해 주세요.' });
      return;
    }
    this.reconnectAttempts += 1;
    // 지수 백오프 + 지터. 여러 클라이언트가 동시에 되돌아와 서버를 때리는 것을 피합니다.
    const base = Math.min(8000, 500 * 2 ** (this.reconnectAttempts - 1));
    const delay = base * (0.7 + Math.random() * 0.6);
    this.setStatus('reconnecting', { message });
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  /** 자리를 즉시 비우고 나갑니다. 소켓만 끊으면 30초간 자리가 유지됩니다. */
  close() {
    this.closedByUser = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ t: 'leave' });
    }
    this.teardownTimers();
    this.socket?.close(1000, 'client leave');
    this.socket = null;
    this.setStatus('closed');
  }

  private teardownTimers() {
    for (const timer of [this.sendTimer, this.clockTimer, this.telemetryTimer, this.watchdogTimer]) {
      if (timer !== null) window.clearInterval(timer);
    }
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.sendTimer = null;
    this.clockTimer = null;
    this.telemetryTimer = null;
    this.watchdogTimer = null;
    this.reconnectTimer = null;
    this.pendingPings.clear();
  }

  /* ── 수신 ───────────────────────────────────────────────── */

  private handleFrame(frame: ServerFrame) {
    switch (frame.t) {
      case 'welcome':
        this.onWelcome(frame);
        return;

      case 'state':
        this.onServerState(frame);
        return;

      case 'ping':
        // 응답하지 않으면 6초 후 끊깁니다. 받은 sSend 를 그대로 되돌려 줍니다.
        this.send({ t: 'pong', seq: frame.seq, sSend: frame.sSend });
        return;

      case 'pong':
        this.onClockPong(frame.t0, frame.t1, frame.t2);
        return;

      case 'presenceJoin':
        this.applyRoster(frame.rosterVersion, (roster) => {
          const next = roster.filter((p) => p.id !== frame.participant.id);
          next.push(frame.participant);
          return next;
        });
        return;

      case 'presenceLeave':
        this.applyRoster(frame.rosterVersion, (roster) =>
          roster.filter((p) => p.id !== frame.participantId),
        );
        return;

      case 'presenceUpdate':
        this.applyRoster(frame.rosterVersion, (roster) =>
          roster.map((p) => (p.id === frame.participant.id ? { ...p, ...frame.participant } : p)),
        );
        return;

      case 'roster':
        this.applyRoster(frame.rosterVersion, () => frame.roster);
        return;

      case 'hostChanged':
        this.applyRoster(frame.rosterVersion, (roster) =>
          roster.map((p) => ({ ...p, isHost: p.id === frame.hostId })),
        );
        return;

      case 'controlChanged':
        this.emit('control', {
          holder: frame.holder,
          holderName: frame.holderName,
          expiresAtMs: null,
          reason: frame.reason,
        });
        return;

      case 'controlDenied':
        this.emit('controlDenied', { holder: frame.holder, retryAfterMs: frame.retryAfterMs });
        return;

      case 'stateSnapshot':
        if (frame.seq >= this.lastSeq) {
          this.lastSeq = frame.seq;
          this.emit('state', {
            seq: frame.seq,
            transform: frame.transform,
            origin: frame.updatedBy ?? '',
          });
        }
        this.emit('control', { ...frame.control });
        return;

      case 'assetChanged':
        // 모델이 바뀌면 이전 transform 은 의미가 없습니다. 서버가 항등 변환을 함께 보냅니다.
        this.lastSeq = frame.seq;
        this.pendingTransform = null;
        this.emit('asset', { asset: frame.asset, transform: frame.transform });
        return;

      case 'telemetry': {
        const { t: _t, ts: _ts, ...telemetry } = frame;
        this.emit('telemetry', telemetry);
        return;
      }

      case 'sessionEnded':
        this.closedByUser = true; // 재접속하지 않습니다.
        this.emit('sessionEnded', { reason: frame.reason });
        return;

      case 'error':
        this.emit('error', { code: frame.code, message: frame.message, fatal: frame.fatal });
        return;

      default:
        // 서버가 새 frame 을 추가해도 조용히 무시합니다.
        return;
    }
  }

  private onWelcome(frame: WelcomeFrame) {
    this.myId = frame.you.id;
    this.config = { ...DEFAULT_CONFIG, ...frame.config };
    this.lastSeq = frame.state?.seq ?? 0;
    this.rosterVersion = frame.rosterVersion;
    this.roster = frame.roster;

    this.emit('welcome', frame);
    this.emit('roster', frame.roster);
    this.emit('control', { ...frame.control });

    // welcome 의 serverTime 으로 offset 을 대충 맞춰 두고, ping 으로 정밀하게 좁힙니다.
    if (Number.isFinite(frame.serverTime)) {
      this.clockOffsetMs = frame.serverTime - monotonicNow();
    }

    this.startSendLoop();
    this.startClockSync();
    this.startTelemetryLoop();

    // 재접속이면 놓친 상태를 다시 받아옵니다.
    if (frame.you.reconnected) {
      this.requestState();
    }
  }

  private onServerState(frame: ServerStateFrame) {
    // seq 역전은 버립니다. UDP 가 아니어도 재접속 전후로 순서가 꼬일 수 있습니다.
    if (frame.seq <= this.lastSeq) return;
    this.lastSeq = frame.seq;

    const isEcho = frame.origin === this.myId;

    // 종단 지연 표본: 다른 참가자가 만든 frame 만 셉니다.
    if (!isEcho && typeof frame.tOrigin === 'number' && Number.isFinite(frame.tOrigin)) {
      const arrivedOnServerClock = monotonicNow() + this.clockOffsetMs;
      const e2e = arrivedOnServerClock - frame.tOrigin;
      // 시계가 아직 안 맞은 초반에는 음수가 나옵니다. 그런 표본은 버립니다.
      if (e2e >= 0 && e2e < 60_000) this.e2eSamples.push(e2e);
    }

    // 자기 에코는 기하에 적용하지 않습니다. 적용하면 화면이 떱니다.
    if (isEcho) return;
    if (!isFiniteTransform(frame.transform)) return;

    this.emit('state', {
      seq: frame.seq,
      transform: frame.transform,
      origin: frame.origin,
      gesture: frame.gesture,
    });
  }

  private applyRoster(version: number, update: (roster: Participant[]) => Participant[]) {
    // 순서가 뒤바뀐 presence frame 이 최신 명단을 되돌리지 않도록 버전을 봅니다.
    if (version < this.rosterVersion) return;
    this.rosterVersion = version;
    this.roster = update(this.roster);
    this.emit('roster', this.roster);
  }

  /* ── 송신 ───────────────────────────────────────────────── */

  private send(frame: ClientFrame) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  /**
   * 조작 결과(절대 transform)를 예약합니다. 실제 전송은 30Hz 타이머가 합니다.
   * `requestAnimationFrame` 마다 보내면 120Hz 맥북에서 서버 상한(90/s)을 넘겨 조용히 버려집니다.
   */
  queueTransform(transform: Transform, gesture?: GesturePayload) {
    if (!isFiniteTransform(transform)) return; // NaN 하나가 모든 참가자의 화면을 날립니다.
    this.pendingTransform = transform;
    if (gesture) this.pendingGesture = gesture;
  }

  private startSendLoop() {
    if (this.sendTimer !== null) return;
    const hz = Math.min(this.config.recommendedSendHz || 30, this.config.maxStateHz || 60);
    this.sendTimer = window.setInterval(() => {
      const transform = this.pendingTransform;
      if (!transform) return;
      this.pendingTransform = null;
      const gesture = this.pendingGesture;
      this.pendingGesture = undefined;
      this.cseq += 1;
      this.send({
        t: 'state',
        cseq: this.cseq,
        tOrigin: monotonicNow() + this.clockOffsetMs,
        transform,
        ...(gesture ? { gesture } : {}),
      });
    }, 1000 / hz);
  }

  sendPresence(mic: boolean, vid: boolean) {
    this.send({ t: 'presence', mic, vid });
  }

  sendTracking(status: 'ok' | 'lost', reason?: TrackingLostReason) {
    this.send({ t: 'tracking', status, ...(reason ? { reason } : {}) });
  }

  releaseControl() {
    this.send({ t: 'controlRelease' });
  }

  /** 재접속 직후와 탭이 다시 보일 때 호출합니다. */
  requestState() {
    this.send({ t: 'stateRequest', sinceSeq: this.lastSeq });
  }

  /* ── 시계 동기화 ─────────────────────────────────────────── */

  private startClockSync() {
    if (this.clockTimer !== null) return;
    this.clockBurstLeft = CLOCK_BURST_COUNT;
    this.sendClockPing();
    this.clockTimer = window.setInterval(() => this.sendClockPing(), CLOCK_BURST_INTERVAL_MS);
  }

  private sendClockPing() {
    this.clockSeq += 1;
    const t0 = monotonicNow();
    this.pendingPings.set(this.clockSeq, t0);
    // 응답이 오지 않은 표본이 쌓이지 않게 오래된 것은 버립니다.
    if (this.pendingPings.size > 32) {
      const oldest = this.pendingPings.keys().next().value;
      if (oldest !== undefined) this.pendingPings.delete(oldest);
    }
    this.send({ t: 'ping', seq: this.clockSeq, t0 });

    if (this.clockBurstLeft > 0) {
      this.clockBurstLeft -= 1;
      if (this.clockBurstLeft === 0 && this.clockTimer !== null) {
        // 초반 버스트가 끝나면 10초 간격으로 늘립니다.
        window.clearInterval(this.clockTimer);
        this.clockTimer = window.setInterval(() => this.sendClockPing(), CLOCK_STEADY_INTERVAL_MS);
      }
    }
  }

  private onClockPong(t0: number, t1: number, t2: number) {
    const t3 = monotonicNow();
    const rtt = t3 - t0 - (t2 - t1);
    const offset = (t1 - t0 + (t2 - t3)) / 2;
    if (!Number.isFinite(rtt) || !Number.isFinite(offset) || rtt < 0) return;

    this.clockSamples += 1;

    // RTT 가 가장 작은 표본의 offset 만 채택합니다. 큐잉 지연이 섞인 표본은 offset 을 왜곡합니다.
    if (rtt <= this.bestRttMs) {
      this.bestRttMs = rtt;
      const delta = offset - this.clockOffsetMs;
      // 한 번에 50ms 이상 움직이지 않습니다. 갑작스러운 점프는 가짜 지연 절벽을 만듭니다.
      const step = Math.max(-MAX_OFFSET_STEP_MS, Math.min(MAX_OFFSET_STEP_MS, delta));
      this.clockOffsetMs += step;
      this.clockUncertaintyMs = rtt / 2;
    } else {
      // 최소 RTT 는 서서히 잊습니다. 네트워크가 좋아지면 다시 잡히도록.
      this.bestRttMs = Math.min(this.bestRttMs * 1.02, rtt);
    }

    this.emit('clock', {
      offsetMs: this.clockOffsetMs,
      uncertaintyMs: this.clockUncertaintyMs,
      rttMs: rtt,
      samples: this.clockSamples,
    });
  }

  /* ── 지연 보고 ───────────────────────────────────────────── */

  private startTelemetryLoop() {
    if (this.telemetryTimer !== null) return;
    this.telemetryTimer = window.setInterval(() => this.flushTelemetry(), TELEMETRY_WINDOW_MS);
  }

  private flushTelemetry() {
    const samples = this.e2eSamples;
    this.e2eSamples = [];
    if (samples.length === 0) return;

    const sorted = [...samples].sort((a, b) => a - b);
    const summary = {
      n: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1],
    };

    // 원시 표본이 200개를 넘으면 균등 간격으로 솎고, 그 비율을 sampledWeight 로 알립니다.
    let raw = samples;
    let sampledWeight = 1;
    if (samples.length > MAX_SAMPLES_PER_REPORT) {
      const stride = Math.ceil(samples.length / MAX_SAMPLES_PER_REPORT);
      raw = samples.filter((_, index) => index % stride === 0);
      sampledWeight = stride;
    }

    this.send({
      t: 'telemetryReport',
      windowMs: TELEMETRY_WINDOW_MS,
      e2e: summary,
      e2eSamples: raw.map((value) => Number(value.toFixed(2))),
      sampledWeight,
      clockOffsetMs: Number(this.clockOffsetMs.toFixed(2)),
      clockUncertaintyMs: Number.isFinite(this.clockUncertaintyMs)
        ? Number(this.clockUncertaintyMs.toFixed(2))
        : 0,
    });

    this.emit('latency', { ...summary, last: samples[samples.length - 1] });
  }

  /* ── 무응답 감시 ─────────────────────────────────────────── */

  private startWatchdog() {
    if (this.watchdogTimer !== null) return;
    this.watchdogTimer = window.setInterval(() => {
      const silentFor = monotonicNow() - this.lastMessageAt;
      // 서버 ping 은 2초마다 옵니다. 그 3배 동안 조용하면 죽은 연결로 봅니다.
      if (silentFor > this.config.heartbeatMs * 3) {
        this.socket?.close(1001, 'server silent');
      }
    }, this.config.heartbeatMs);
  }

  /* ── 조회 ───────────────────────────────────────────────── */

  get participantId(): string | null {
    return this.myId;
  }

  get roomConfig(): RoomConfig {
    return this.config;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  /** 서버 시계 기준 현재 시각 */
  serverNow(): number {
    return monotonicNow() + this.clockOffsetMs;
  }
}
