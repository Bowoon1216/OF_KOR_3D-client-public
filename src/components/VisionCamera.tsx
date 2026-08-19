import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { Camera, Hand, LoaderCircle, VideoOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalCamera } from '../media/LocalCamera';
import {
  classifyGesture,
  createRotationTracker,
  GESTURE_LABEL,
  GestureType,
  Landmark,
} from '../mediapipe/gestures';

export type { GestureType } from '../mediapipe/gestures';

export type GestureEvent = {
  type: GestureType;
  /** 손 이동량 (정규화 좌표, 화면에서 보이는 방향에 맞춰 좌우 반전 보정됨) */
  deltaX: number;
  deltaY: number;
  /** 좌우 회전량 - 손바닥/손등 뒤집기 (라디안) */
  deltaYaw: number;
  /** 상하 회전량 - 손바닥을 아래/위로 눕히기 (라디안) */
  deltaPitch: number;
};

export type TrackingReason =
  | 'no_hand'
  | 'low_confidence'
  | 'occluded'
  | 'camera_off'
  | 'permission_denied';

type VisionCameraProps = {
  onGesture?: (event: GestureEvent) => void;
  /** 꺼져 있으면 손은 계속 추적하되 제스처 이벤트를 보내지 않습니다. */
  enabled?: boolean;
  /** 손 인식 상태 변화. 서버 `tracking` frame 으로 그대로 전달됩니다. */
  onTrackingChange?: (status: 'ok' | 'lost', reason?: TrackingReason) => void;
};

/**
 * MediaPipe 는 단일 프레임을 수시로 놓칩니다. 그대로 보내면 참가자 명단이 초당 수십 번 깜빡이므로
 * `lost` 는 400ms 디바운스 후에 보냅니다. 복귀(`ok`)는 디바운스 없이 즉시 보냅니다.
 */
const TRACKING_LOST_DEBOUNCE_MS = 400;

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15],
  [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

/** 카메라 영상은 좌우 반전해 보여주므로, 이동 방향도 화면 기준으로 뒤집어 줍니다. */
const MIRROR = -1;
/** 손 떨림 무시 (정규화 좌표 / 라디안) */
const MOVE_DEADZONE = 0.002;
const ROTATION_DEADZONE = 0.006;
/** 인식이 튀었을 때 물체가 순간이동하지 않도록 한 프레임 변화량을 제한합니다. */
const MAX_MOVE_PER_FRAME = 0.08;
const MAX_ROTATION_PER_FRAME = 0.25;
/**
 * 새 제스처가 이만큼 연속으로 잡혀야 실제로 바뀝니다.
 * 집게를 쥐는 도중 한두 프레임 다른 제스처로 새면서 모델이 흔들리는 것을 막습니다.
 */
const GESTURE_SWITCH_FRAMES = 4;

function applyDeadzone(value: number, deadzone: number, limit: number): number {
  if (Math.abs(value) < deadzone) return 0;
  return Math.max(-limit, Math.min(limit, value));
}

export default function VisionCamera({
  onGesture,
  enabled = true,
  onTrackingChange,
}: VisionCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const frameRef = useRef<number | null>(null);

  // 프레임 루프에서 항상 최신 값을 보도록 ref 로 들고 있습니다.
  const onGestureRef = useRef(onGesture);
  const enabledRef = useRef(enabled);
  const gestureRef = useRef<GestureType>('NONE');
  const candidateRef = useRef<GestureType>('NONE');
  const candidateFrames = useRef(0);
  const lastPalm = useRef<{ x: number; y: number } | null>(null);
  const rotationRef = useRef(createRotationTracker());

  // 카메라 자체는 방 전체가 공유합니다. 여기서는 손 인식 모델의 상태만 들고 있습니다.
  const camera = useLocalCamera();
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const [gesture, setGesture] = useState<GestureType>('NONE');

  const onTrackingRef = useRef(onTrackingChange);
  const trackingRef = useRef<'ok' | 'lost'>('lost');
  const lostTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onGestureRef.current = onGesture;
  }, [onGesture]);

  useEffect(() => {
    onTrackingRef.current = onTrackingChange;
  }, [onTrackingChange]);

  /** 손을 다시 잡았을 때. 디바운스 없이 즉시 알립니다. */
  const markTrackingOk = useCallback(() => {
    if (lostTimerRef.current !== null) {
      window.clearTimeout(lostTimerRef.current);
      lostTimerRef.current = null;
    }
    if (trackingRef.current === 'ok') return;
    trackingRef.current = 'ok';
    onTrackingRef.current?.('ok');
  }, []);

  /** 손을 놓쳤을 때. 400ms 동안 계속 놓친 상태여야 알립니다. */
  const markTrackingLost = useCallback((reason: TrackingReason, immediate = false) => {
    if (trackingRef.current === 'lost' || lostTimerRef.current !== null) {
      if (!immediate) return;
    }
    if (immediate) {
      if (lostTimerRef.current !== null) {
        window.clearTimeout(lostTimerRef.current);
        lostTimerRef.current = null;
      }
      if (trackingRef.current === 'lost') return;
      trackingRef.current = 'lost';
      onTrackingRef.current?.('lost', reason);
      return;
    }
    lostTimerRef.current = window.setTimeout(() => {
      lostTimerRef.current = null;
      trackingRef.current = 'lost';
      onTrackingRef.current?.('lost', reason);
    }, TRACKING_LOST_DEBOUNCE_MS);
  }, []);

  /** 제스처가 바뀌거나 손을 놓쳤을 때, 그동안의 변화가 한꺼번에 반영되지 않도록 기준점을 버립니다. */
  const resetTracking = useCallback(() => {
    lastPalm.current = null;
    rotationRef.current.reset();
    candidateRef.current = 'NONE';
    candidateFrames.current = 0;
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      gestureRef.current = 'NONE';
      resetTracking();
      setGesture('NONE');
    }
  }, [enabled, resetTracking]);

  const draw = useCallback((landmarks: Array<{ x: number; y: number }>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#2563eb';
    context.fillStyle = '#0f172a';
    context.lineWidth = 2;
    CONNECTIONS.forEach(([start, end]) => {
      const a = landmarks[start];
      const b = landmarks[end];
      if (!a || !b) return;
      context.beginPath();
      context.moveTo(a.x * canvas.width, a.y * canvas.height);
      context.lineTo(b.x * canvas.width, b.y * canvas.height);
      context.stroke();
    });
    landmarks.forEach(({ x, y }) => {
      context.beginPath();
      context.arc(x * canvas.width, y * canvas.height, 3, 0, Math.PI * 2);
      context.fill();
    });
  }, []);

  /** 손 인식 루프만 멈춥니다. 카메라 스트림은 LocalCameraProvider 가 소유합니다. */
  const stopTracking = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    gestureRef.current = 'NONE';
    resetTracking();
    setGesture('NONE');
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }, [resetTracking]);

  /* 스트림이 생기면 손 인식을 붙이고, 사라지면 뗍니다. */
  useEffect(() => {
    const video = videoRef.current;
    const stream = camera.stream;
    if (!video) return;

    if (!stream) {
      stopTracking();
      video.srcObject = null;
      setModelStatus('idle');
      setModelMessage(null);
      // 카메라를 끈 것은 "놓친" 게 아니라 확정된 상태이므로 디바운스 없이 알립니다.
      markTrackingLost('camera_off', true);
      return;
    }

    let cancelled = false;
    video.srcObject = stream;
    video.play().catch(() => { /* muted 상태라 자동재생이 막히지는 않습니다. */ });
    setModelStatus('loading');
    setModelMessage('Loading MediaPipe model...');

    (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm', false);
        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          },
          runningMode: 'VIDEO',
          // 제스처는 한 손 기준입니다. 한 손만 추론해 오인식과 부하를 줄입니다.
          numHands: 1,
          minHandDetectionConfidence: 0.55,
          minHandPresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
        });
        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setModelStatus('ready');
        setModelMessage('Hand tracking active');

        const processFrame = () => {
          if (!videoRef.current || !landmarkerRef.current || videoRef.current.readyState < 2) {
            frameRef.current = requestAnimationFrame(processFrame);
            return;
          }

          const hands = landmarkerRef.current.detectForVideo(videoRef.current, performance.now()).landmarks;
          const hand = hands[0] as Landmark[] | undefined;

          const canvas = canvasRef.current;
          if (canvas && video.videoWidth) {
            if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
            }
            draw(hand ?? []);
          }

          // 손 인식 여부는 제스처 사용 여부와 별개입니다. 카메라가 손을 보고 있으면 ok 입니다.
          if (hand) markTrackingOk();
          else markTrackingLost('no_hand');

          if (!hand || !enabledRef.current) {
            if (gestureRef.current !== 'NONE') {
              gestureRef.current = 'NONE';
              setGesture('NONE');
            }
            resetTracking();
            frameRef.current = requestAnimationFrame(processFrame);
            return;
          }

          const detected = classifyGesture(hand, gestureRef.current);

          // 새 제스처가 몇 프레임 연속으로 잡혀야 실제로 전환합니다.
          // 집게를 쥐는 도중 잠깐 다른 제스처로 새면서 모델이 흔들리는 것을 막습니다.
          if (detected === candidateRef.current) candidateFrames.current += 1;
          else {
            candidateRef.current = detected;
            candidateFrames.current = 1;
          }

          const type = gestureRef.current;
          if (detected !== type && candidateFrames.current >= GESTURE_SWITCH_FRAMES) {
            gestureRef.current = detected;
            setGesture(detected);
            // 전환 순간에는 기준점을 다시 잡아 물체가 튀지 않게 합니다.
            lastPalm.current = null;
            rotationRef.current.reset();
            frameRef.current = requestAnimationFrame(processFrame);
            return;
          }

          const palm = hand[9];
          const movedX = lastPalm.current ? palm.x - lastPalm.current.x : 0;
          const movedY = lastPalm.current ? palm.y - lastPalm.current.y : 0;
          lastPalm.current = { x: palm.x, y: palm.y };

          // 회전은 회전 제스처일 때만 계산합니다. 확대/축소·이동 중에는 각도 변화를 아예 보지 않습니다.
          const rotation =
            type === 'ROTATE'
              ? rotationRef.current.update(hand)
              : { deltaYaw: 0, deltaPitch: 0 };

          onGestureRef.current?.({
            type,
            deltaX: MIRROR * applyDeadzone(movedX, MOVE_DEADZONE, MAX_MOVE_PER_FRAME),
            deltaY: applyDeadzone(movedY, MOVE_DEADZONE, MAX_MOVE_PER_FRAME),
            deltaYaw: applyDeadzone(rotation.deltaYaw, ROTATION_DEADZONE, MAX_ROTATION_PER_FRAME),
            deltaPitch: applyDeadzone(rotation.deltaPitch, ROTATION_DEADZONE, MAX_ROTATION_PER_FRAME),
          });

          frameRef.current = requestAnimationFrame(processFrame);
        };

        frameRef.current = requestAnimationFrame(processFrame);
      } catch (error) {
        if (cancelled) return;
        setModelStatus('error');
        setModelMessage(error instanceof Error ? error.message : 'Hand tracking unavailable');
        markTrackingLost('camera_off', true);
      }
    })();

    return () => {
      cancelled = true;
      stopTracking();
    };
  }, [camera.stream, draw, markTrackingLost, markTrackingOk, resetTracking, stopTracking]);

  /* 권한을 거부당했으면 손 인식이 아니라 권한 문제임을 명단에도 알립니다. */
  useEffect(() => {
    if (camera.status === 'denied') markTrackingLost('permission_denied', true);
  }, [camera.status, markTrackingLost]);

  const cameraOn = Boolean(camera.stream);
  const trackingReady = cameraOn && modelStatus === 'ready';
  const busy = camera.status === 'starting' || modelStatus === 'loading';
  // 카메라가 아직 안 켜졌으면 카메라 쪽 문구를, 켜졌으면 손 인식 쪽 문구를 보여줍니다.
  const message = cameraOn ? modelMessage ?? camera.message : camera.message;

  return (
    <div className="absolute bottom-6 right-6 z-30 w-64 border border-slate-900 bg-white shadow-xl">
      <div className="relative aspect-video overflow-hidden bg-slate-950">
        <video ref={videoRef} muted playsInline className="h-full w-full scale-x-[-1] object-cover" />
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full scale-x-[-1]" />
        {!cameraOn && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80"><VideoOff className="h-5 w-5" /><span className="text-[9px] uppercase tracking-widest">{message}</span></div>}
        {trackingReady && (
          <div className={`absolute left-3 top-3 flex items-center gap-2 px-2 py-1 text-[9px] font-bold uppercase tracking-widest ${enabled ? 'bg-white/90 text-slate-900' : 'bg-slate-900/80 text-white/70'}`}>
            <Hand className="h-3 w-3" />
            {enabled ? GESTURE_LABEL[gesture] : 'Gesture off'}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 p-3">
        <div><div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Vision Input</div><div className="mt-1 text-xs font-semibold text-slate-900">{busy ? <span className="flex items-center gap-1"><LoaderCircle className="h-3 w-3 animate-spin" /> Initializing</span> : message}</div></div>
        <button type="button" onClick={() => (cameraOn ? camera.stop() : void camera.start())} className="flex h-9 w-9 items-center justify-center border border-slate-900 text-slate-900 hover:bg-slate-900 hover:text-white cursor-pointer" title={cameraOn ? 'Stop camera' : 'Start camera'}><Camera className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
