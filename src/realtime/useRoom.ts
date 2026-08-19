import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toMessage } from '../api/errors';
import { joinRoom } from '../api/rooms';
import type { AssetSummary, Participant, Role, RoomTelemetry, Transform } from '../api/types';
import { getToken } from '../auth/tokenStore';
import type { GesturePayload, TrackingLostReason, WelcomeFrame } from './frames';
import { RoomSocket, type ClockInfo, type ConnectionStatus, type LatencyInfo } from './RoomSocket';

/** 새로고침해도 원래 자리로 돌아가기 위해 sessionStorage 에 보관합니다. */
interface StoredSeat {
  participantId: string;
  resumeToken: string;
  wsUrl: string;
}

function seatKey(code: string) {
  return `of_kor_3d.seat.${code}`;
}

function readSeat(code: string): StoredSeat | null {
  try {
    const raw = sessionStorage.getItem(seatKey(code));
    return raw ? (JSON.parse(raw) as StoredSeat) : null;
  } catch {
    return null;
  }
}

function writeSeat(code: string, seat: StoredSeat) {
  try {
    sessionStorage.setItem(seatKey(code), JSON.stringify(seat));
  } catch {
    /* 저장 못 해도 접속 자체는 됩니다. 새로고침 시 자리를 새로 받을 뿐입니다. */
  }
}

function clearSeat(code: string) {
  try {
    sessionStorage.removeItem(seatKey(code));
  } catch {
    /* 무시 */
  }
}

export interface RemoteState {
  seq: number;
  transform: Transform;
  origin: string;
}

export interface UseRoomOptions {
  code: string;
  /** 게스트 표시 이름. 로그인 사용자는 서버가 계정 이름을 우선합니다. */
  name?: string;
  role?: Role;
  /** false 면 아무것도 하지 않습니다. (이름 입력을 기다리는 동안) */
  enabled?: boolean;
}

export interface RoomConnection {
  status: ConnectionStatus;
  statusMessage: string | null;
  error: string | null;
  me: WelcomeFrame['you'] | null;
  session: WelcomeFrame['session'] | null;
  roster: Participant[];
  asset: AssetSummary | null;
  /** 다른 참가자가 만든 최신 상태. `welcome` 의 초기 상태도 여기로 들어옵니다. */
  remoteState: RemoteState | null;
  telemetry: RoomTelemetry | null;
  latency: LatencyInfo | null;
  clock: ClockInfo | null;
  control: { holder: string | null; holderName: string | null };
  hasControl: boolean;
  endedReason: string | null;
  sendTransform: (transform: Transform, gesture?: GesturePayload) => void;
  setPresence: (mic: boolean, vid: boolean) => void;
  setTracking: (status: 'ok' | 'lost', reason?: TrackingLostReason) => void;
  releaseControl: () => void;
  leave: () => void;
}

/**
 * 방 하나에 대한 REST join + WebSocket 연결을 통째로 관리합니다.
 *
 * 접속 절차(명세 6.1): join 으로 자리를 받고 → 그 `wsUrl` 로 소켓을 열면
 * 서버가 `welcome` 을 첫 frame 으로 보냅니다. 별도 join 왕복이 없어 RTT 한 번을 아낍니다.
 */
export function useRoom({ code, name, role, enabled = true }: UseRoomOptions): RoomConnection {
  const socketRef = useRef<RoomSocket | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<WelcomeFrame['you'] | null>(null);
  const [session, setSession] = useState<WelcomeFrame['session'] | null>(null);
  const [roster, setRoster] = useState<Participant[]>([]);
  const [asset, setAsset] = useState<AssetSummary | null>(null);
  const [remoteState, setRemoteState] = useState<RemoteState | null>(null);
  const [telemetry, setTelemetry] = useState<RoomTelemetry | null>(null);
  const [latency, setLatency] = useState<LatencyInfo | null>(null);
  const [clock, setClock] = useState<ClockInfo | null>(null);
  const [control, setControl] = useState<{ holder: string | null; holderName: string | null }>({
    holder: null,
    holderName: null,
  });
  const [endedReason, setEndedReason] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !code) return;
    // StrictMode 의 이중 마운트에서 첫 번째 실행이 두 번째 소켓을 덮어쓰지 않도록
    // ref 가 아니라 이 실행에만 속한 플래그를 씁니다.
    let disposed = false;

    /** 자리를 받고(또는 저장된 자리를 재사용하고) 소켓을 엽니다. */
    const start = async (forceRejoin: boolean) => {
      if (disposed) return;
      try {
        let seat = forceRejoin ? null : readSeat(code);
        if (!seat) {
          const joined = await joinRoom(code, { name, role });
          seat = {
            participantId: joined.participantId,
            resumeToken: joined.resumeToken,
            wsUrl: joined.wsUrl,
          };
          writeSeat(code, seat);
        }
        if (disposed) return;

        const socket = new RoomSocket({ wsUrl: seat.wsUrl, token: getToken() });
        socketRef.current = socket;

        socket.on('status', (payload) => {
          setStatus(payload.status);
          setStatusMessage(payload.message ?? null);
        });
        socket.on('welcome', (frame) => {
          setMe(frame.you);
          setSession(frame.session);
          setAsset(frame.asset);
          setError(null);
          if (frame.state) {
            setRemoteState({
              seq: frame.state.seq,
              transform: frame.state.transform,
              origin: frame.state.updatedBy ?? '',
            });
          }
        });
        socket.on('roster', setRoster);
        socket.on('state', (payload) =>
          setRemoteState({ seq: payload.seq, transform: payload.transform, origin: payload.origin }),
        );
        socket.on('asset', (payload) => {
          setAsset(payload.asset);
          // 도면이 바뀌면 transform 은 항등으로 초기화됩니다. seq 는 서버가 새로 매깁니다.
          setRemoteState({ seq: 0, transform: payload.transform, origin: '' });
        });
        socket.on('telemetry', setTelemetry);
        socket.on('latency', setLatency);
        socket.on('clock', setClock);
        socket.on('control', (payload) =>
          setControl({ holder: payload.holder, holderName: payload.holderName ?? null }),
        );
        socket.on('sessionEnded', (payload) => setEndedReason(payload.reason));
        socket.on('error', (payload) => {
          // fatal 이 아니면 연결이 유지되므로 배너만 띄우고 지나갑니다.
          setError(payload.message);
        });
        socket.on('needsRejoin', () => {
          // 예약이 풀렸거나 참가자가 사라진 경우. 자리를 새로 받아 다시 붙습니다.
          clearSeat(code);
          socketRef.current = null;
          void start(true);
        });

        socket.connect();
      } catch (cause) {
        if (disposed) return;
        setStatus('closed');
        setError(toMessage(cause, '방에 입장하지 못했습니다.'));
      }
    };

    void start(false);

    // 탭이 다시 보이면 놓친 상태를 받아옵니다. 백그라운드에서는 rAF 가 멈춰 화면이 뒤처집니다.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') socketRef.current?.requestState();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      // 명시적으로 나가야 자리가 즉시 비워집니다. 소켓만 끊으면 30초간 유지됩니다.
      socketRef.current?.close();
      socketRef.current = null;
    };
    // name/role 은 최초 join 에만 쓰이므로 재연결 트리거로 넣지 않습니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, enabled]);

  const sendTransform = useCallback((transform: Transform, gesture?: GesturePayload) => {
    socketRef.current?.queueTransform(transform, gesture);
  }, []);

  const setPresence = useCallback((mic: boolean, vid: boolean) => {
    socketRef.current?.sendPresence(mic, vid);
  }, []);

  const setTracking = useCallback((next: 'ok' | 'lost', reason?: TrackingLostReason) => {
    socketRef.current?.sendTracking(next, reason);
  }, []);

  const releaseControl = useCallback(() => {
    socketRef.current?.releaseControl();
  }, []);

  const leave = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    clearSeat(code);
  }, [code]);

  const hasControl = useMemo(
    () => Boolean(me && control.holder && control.holder === me.id),
    [me, control.holder],
  );

  return {
    status,
    statusMessage,
    error,
    me,
    session,
    roster,
    asset,
    remoteState,
    telemetry,
    latency,
    clock,
    control,
    hasControl,
    endedReason,
    sendTransform,
    setPresence,
    setTracking,
    releaseControl,
    leave,
  };
}
