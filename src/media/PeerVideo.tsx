import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getIceServers } from '../config/env';
import type { SignalPayload } from '../realtime/frames';
import { useLocalCamera } from './LocalCamera';

/**
 * 참가자끼리 카메라 영상을 직접 주고받습니다 (WebRTC P2P 메시).
 *
 * 서버는 `signal` frame 을 상대에게 그대로 전달하는 우체국 역할만 합니다. 영상은 서버를 거치지
 * 않으므로 SFU 없이도 소규모 회의(4~5명)가 가능하고, 도면 동기화용 WS 대역폭을 잡아먹지 않습니다.
 *
 * 협상은 W3C 의 "perfect negotiation" 을 그대로 씁니다. 양쪽이 동시에 offer 를 내도(글레어)
 * 한쪽만 양보하면 연결이 깨지지 않습니다. 양보하는 쪽(polite)은 참가자 id 가 큰 쪽입니다.
 */

interface Peer {
  pc: RTCPeerConnection;
  /** 내 카메라를 실어 보내는 자리. 카메라가 꺼져 있으면 recvonly 로 잡아 둡니다. */
  transceiver: RTCRtpTransceiver | null;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

export interface PeerVideoValue {
  /** 참가자 id → 그 사람의 카메라 스트림 */
  streams: Record<string, MediaStream>;
  /** 참가자 id → 연결 상태. 'failed' 면 NAT 을 못 넘은 경우입니다. */
  states: Record<string, RTCPeerConnectionState>;
}

const PeerVideoContext = createContext<PeerVideoValue>({ streams: {}, states: {} });

export function usePeerVideo(): PeerVideoValue {
  return useContext(PeerVideoContext);
}

export function PeerVideoProvider({
  enabled,
  myId,
  peerIds,
  sendSignal,
  onSignal,
  children,
}: {
  /** 서버가 signal 중계를 지원할 때만 켭니다. 끄면 연결을 아예 만들지 않습니다. */
  enabled: boolean;
  /** 내 참가자 id. 없으면(welcome 전) 아무것도 하지 않습니다. */
  myId: string | null | undefined;
  /** 나를 제외한 같은 방 참가자 id 목록 */
  peerIds: string[];
  sendSignal: (to: string, data: SignalPayload) => void;
  onSignal: (handler: (message: { from: string; data: SignalPayload }) => void) => () => void;
  children: ReactNode;
}) {
  const { stream: localStream } = useLocalCamera();
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [states, setStates] = useState<Record<string, RTCPeerConnectionState>>({});

  const peersRef = useRef(new Map<string, Peer>());
  // 콜백 안에서 항상 최신 값을 읽되, 값이 바뀔 때마다 연결을 다시 만들지는 않습니다.
  const localStreamRef = useRef<MediaStream | null>(null);
  localStreamRef.current = localStream;
  const sendRef = useRef(sendSignal);
  sendRef.current = sendSignal;
  const myIdRef = useRef<string | null>(myId ?? null);
  myIdRef.current = myId ?? null;

  const dropPeer = useCallback((peerId: string, notify: boolean) => {
    const peer = peersRef.current.get(peerId);
    if (!peer) return;
    peersRef.current.delete(peerId);
    // onconnectionstatechange 가 close 이후에도 불려 상태를 되살리지 않도록 먼저 떼어냅니다.
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    if (notify) sendRef.current(peerId, { kind: 'bye' });
    setStreams((prev) => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
    setStates((prev) => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  const ensurePeer = useCallback(
    (peerId: string): Peer | null => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;
      const me = myIdRef.current;
      if (!me) return null;

      const pc = new RTCPeerConnection({ iceServers: getIceServers() });
      const peer: Peer = {
        pc,
        transceiver: null,
        // id 가 큰 쪽이 양보합니다. 양쪽이 같은 규칙으로 계산하므로 합의가 필요 없습니다.
        polite: me > peerId,
        makingOffer: false,
        ignoreOffer: false,
      };
      peersRef.current.set(peerId, peer);

      const track = localStreamRef.current?.getVideoTracks()[0] ?? null;
      peer.transceiver = track
        ? pc.addTransceiver(track, { direction: 'sendrecv', streams: [localStreamRef.current!] })
        : // 카메라가 꺼져 있어도 받을 자리는 만들어 둡니다. 켜는 순간 방향만 바꾸면 됩니다.
          pc.addTransceiver('video', { direction: 'recvonly' });

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          const description = pc.localDescription;
          if (description?.type === 'offer') {
            sendRef.current(peerId, { kind: 'offer', sdp: description.sdp });
          }
        } catch {
          /* 협상이 어긋나면 상대의 다음 offer 로 복구됩니다. */
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) sendRef.current(peerId, { kind: 'ice', candidate: candidate.toJSON() });
      };

      pc.ontrack = ({ track, streams: incoming }) => {
        const stream = incoming[0] ?? new MediaStream([track]);
        setStreams((prev) => (prev[peerId] === stream ? prev : { ...prev, [peerId]: stream }));
      };

      pc.onconnectionstatechange = () => {
        setStates((prev) => ({ ...prev, [peerId]: pc.connectionState }));
        // 끊긴 연결은 그대로 두면 되살아나지 않습니다. 지우면 아래 동기화 effect 가 다시 만듭니다.
        if (pc.connectionState === 'failed') pc.restartIce();
      };

      return peer;
    },
    [],
  );

  /** offer / answer / ICE 처리. 규격의 perfect negotiation 예시와 같은 흐름입니다. */
  const handleSignal = useCallback(
    async (from: string, data: SignalPayload) => {
      if (!myIdRef.current) return;
      if (data.kind === 'bye') {
        dropPeer(from, false);
        return;
      }

      const peer = ensurePeer(from);
      if (!peer) return;
      const { pc } = peer;

      try {
        if (data.kind === 'ice') {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (error) {
            // 무시한 offer 에 딸린 candidate 는 버려도 정상입니다.
            if (!peer.ignoreOffer) throw error;
          }
          return;
        }

        const collision =
          data.kind === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription({ type: data.kind, sdp: data.sdp });
        if (data.kind === 'offer') {
          await pc.setLocalDescription();
          const description = pc.localDescription;
          if (description) sendRef.current(from, { kind: 'answer', sdp: description.sdp });
        }
      } catch {
        /* 한쪽 협상이 깨져도 방 전체를 흔들지는 않습니다. 다음 offer 에서 복구됩니다. */
      }
    },
    [dropPeer, ensurePeer],
  );

  useEffect(() => {
    if (!enabled || !myId) return;
    return onSignal(({ from, data }) => {
      void handleSignal(from, data);
    });
  }, [enabled, myId, onSignal, handleSignal]);

  /* 명단과 연결을 맞춥니다. 들어온 사람에게는 연결을 열고, 나간 사람은 정리합니다. */
  const peerKey = useMemo(() => [...peerIds].sort().join(','), [peerIds]);
  useEffect(() => {
    if (!enabled || !myId) {
      // 껐으면 열려 있던 연결도 정리합니다. (bye 는 못 갈 수도 있지만 상대도 곧 정리합니다)
      for (const peerId of [...peersRef.current.keys()]) dropPeer(peerId, false);
      return;
    }
    const wanted = new Set(peerKey ? peerKey.split(',') : []);
    for (const peerId of peersRef.current.keys()) {
      if (!wanted.has(peerId)) dropPeer(peerId, false);
    }
    // 연결을 만들면 transceiver 추가 때문에 negotiationneeded 가 알아서 뜹니다.
    // 여기서 직접 setLocalDescription 을 부르면 그 이벤트가 (stable 이 아니라서) 취소돼
    // offer 가 영원히 안 나갑니다.
    for (const peerId of wanted) ensurePeer(peerId);
  }, [enabled, myId, peerKey, dropPeer, ensurePeer]);

  /* 카메라를 켜고 끄면 이미 열려 있는 연결에 트랙만 갈아 끼웁니다. (재협상은 브라우저가 알아서) */
  useEffect(() => {
    const track = localStream?.getVideoTracks()[0] ?? null;
    for (const peer of peersRef.current.values()) {
      const transceiver = peer.transceiver;
      if (!transceiver) continue;
      void transceiver.sender.replaceTrack(track).catch(() => {});
      const direction = track ? 'sendrecv' : 'recvonly';
      if (transceiver.direction !== direction) transceiver.direction = direction;
    }
  }, [localStream]);

  /* 방을 떠날 때는 상대가 30초를 기다리지 않도록 bye 를 보내고 닫습니다. */
  useEffect(
    () => () => {
      for (const peerId of [...peersRef.current.keys()]) dropPeer(peerId, true);
    },
    [dropPeer],
  );

  const value = useMemo<PeerVideoValue>(() => ({ streams, states }), [streams, states]);

  return <PeerVideoContext.Provider value={value}>{children}</PeerVideoContext.Provider>;
}
