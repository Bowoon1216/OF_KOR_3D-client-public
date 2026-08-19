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

/**
 * 웹캠 스트림을 방 화면 전체에서 한 곳만 소유합니다.
 *
 * 손 인식(VisionCamera)과 참가자 타일(Sidebar)이 같은 카메라를 봐야 하는데, getUserMedia 를
 * 두 번 부르면 브라우저가 같은 장치를 두 트랙으로 열거나(프레임 드랍) 아예 거부합니다.
 * 그래서 스트림은 여기서 한 번만 열고, 필요한 쪽이 `stream` 을 <video> 에 붙여 씁니다.
 */

export type CameraStatus = 'idle' | 'starting' | 'ready' | 'denied' | 'error';

export interface LocalCameraValue {
  /** 켜져 있으면 MediaStream, 꺼져 있으면 null */
  stream: MediaStream | null;
  status: CameraStatus;
  /** 사람에게 보여줄 현재 상태 문구 */
  message: string;
  /** 이미 켜져 있으면 그 스트림을 그대로 돌려줍니다. 실패하면 null. */
  start: () => Promise<MediaStream | null>;
  stop: () => void;
}

const CONSTRAINTS: MediaStreamConstraints = {
  video: { width: 640, height: 480, facingMode: 'user' },
  audio: false,
};

const LocalCameraContext = createContext<LocalCameraValue | null>(null);

export function LocalCameraProvider({ children }: { children: ReactNode }) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [message, setMessage] = useState('Camera is off');

  const streamRef = useRef<MediaStream | null>(null);
  /** 진행 중인 getUserMedia. 버튼 연타로 두 번 열리는 것을 막습니다. */
  const pendingRef = useRef<Promise<MediaStream | null> | null>(null);

  const stop = useCallback(() => {
    // 대기 중인 요청이 있으면 무효로 표시합니다. 뒤늦게 도착한 스트림은 아래에서 스스로 닫습니다.
    pendingRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setStatus('idle');
    setMessage('Camera is off');
  }, []);

  const start = useCallback(async () => {
    if (streamRef.current) return streamRef.current;
    if (pendingRef.current) return pendingRef.current;

    setStatus('starting');
    setMessage('Requesting camera...');

    const pending: Promise<MediaStream | null> = navigator.mediaDevices
      .getUserMedia(CONSTRAINTS)
      .then((granted) => {
        // 권한 대화상자가 떠 있는 동안 stop() 이 불렸으면 이 스트림은 버립니다.
        if (pendingRef.current !== pending) {
          granted.getTracks().forEach((track) => track.stop());
          return null;
        }
        pendingRef.current = null;
        streamRef.current = granted;
        // 장치를 뽑거나 브라우저가 권한을 회수하면 트랙이 먼저 끝납니다.
        granted.getVideoTracks().forEach((track) => {
          track.addEventListener('ended', () => {
            if (streamRef.current === granted) stop();
          });
        });
        setStream(granted);
        setStatus('ready');
        setMessage('Camera on');
        return granted;
      })
      .catch((error: unknown) => {
        if (pendingRef.current === pending) pendingRef.current = null;
        const denied = error instanceof DOMException && error.name === 'NotAllowedError';
        setStatus(denied ? 'denied' : 'error');
        setMessage(
          denied
            ? 'Camera permission is required'
            : error instanceof Error
              ? error.message
              : 'Camera unavailable',
        );
        return null;
      });

    pendingRef.current = pending;
    return pending;
  }, [stop]);

  // 방을 떠날 때 카메라 표시등이 켜진 채로 남지 않게 합니다.
  useEffect(
    () => () => {
      pendingRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  const value = useMemo<LocalCameraValue>(
    () => ({ stream, status, message, start, stop }),
    [stream, status, message, start, stop],
  );

  return <LocalCameraContext.Provider value={value}>{children}</LocalCameraContext.Provider>;
}

export function useLocalCamera(): LocalCameraValue {
  const value = useContext(LocalCameraContext);
  if (!value) throw new Error('useLocalCamera 는 LocalCameraProvider 안에서만 쓸 수 있습니다.');
  return value;
}

/** MediaStream 을 <video> 에 붙여 주는 것뿐인 얇은 래퍼. srcObject 는 속성으로 못 넘깁니다. */
export function StreamVideo({
  stream,
  className,
}: {
  stream: MediaStream | null;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) video.play().catch(() => { /* 자동재생이 막히면 muted 상태라 곧 재시도됩니다. */ });
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return <video ref={videoRef} muted playsInline autoPlay className={className} />;
}
