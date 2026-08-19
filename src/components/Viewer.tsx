import { Hand, Loader2, Maximize2, MousePointer2, Rotate3d, User } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { reportAssetLoad } from '../api/metrics';
import type { AssetSummary, Transform } from '../api/types';
import {
  isMeasuring,
  markAssetLoad,
  measurementContext,
  getMeasurementSettings,
  shouldReportLoad,
} from '../config/measurement';
import type { GesturePayload } from '../realtime/frames';
import type { RemoteState } from '../realtime/useRoom';
import { afterFirstRender, disposeObject, loadAsset } from '../three/assetLoader';
import { createBuilding, MODEL_FOCUS_Y } from '../three/building';
import { applyGestureToModel } from '../three/gestureTransform';
import { formatBytes } from '../utils/time';
import SoloViewer, { type SoloMode, type SoloViewerHandle } from './SoloViewer';
import VisionCamera, { GestureEvent, TrackingReason } from './VisionCamera';

/** 제스처 종류를 서버 `gesture.kind` 로 옮깁니다. 참가자 카드의 "정예원 (Rotate)" 표시용입니다. */
const GESTURE_KIND: Record<GestureEvent['type'], GesturePayload['kind'] | null> = {
  GRAB: 'PAN',
  ROTATE: 'ROTATE',
  ZOOM_IN: 'PINCH',
  ZOOM_OUT: 'PINCH',
  NONE: null,
};

/** 손 제스처가 어느 모델을 움직일지. `solo` 일 때는 서버로 아무것도 나가지 않습니다. */
type GestureTarget = 'shared' | 'solo';

type ViewerProps = {
  /** 제스처로 모델을 조작할지 여부 */
  gestureEnabled?: boolean;
  /** 방에 붙어 있는 도면. null 이면 절차적 프리뷰를 보여줍니다. */
  asset?: AssetSummary | null;
  /** 다른 참가자(또는 welcome)가 만든 최신 상태 */
  remoteState?: RemoteState | null;
  /** 30Hz 로 병합돼 전송됩니다. 여기서는 프레임마다 불러도 됩니다. */
  onTransform?: (transform: Transform, gesture?: GesturePayload) => void;
  roomCode?: string;
  participantId?: string | null;
  /** 방에 입장한 시각(performance.now 기준). joinToRender 측정의 시작점입니다. */
  joinedAtMs?: number;
  /** 도면 교체 권한(소유자)이 있으면 Load Asset 버튼이 열립니다. */
  canChangeAsset?: boolean;
  onRequestAssetChange?: () => void;
  /** 조작 권한을 쥐고 있는 사람 이름 */
  controlHolderName?: string | null;
  /** 손 인식 상태. 서버 `tracking` frame 으로 전달됩니다. */
  onTrackingChange?: (status: 'ok' | 'lost', reason?: TrackingReason) => void;
};

export default function Viewer({
  gestureEnabled = false,
  asset = null,
  remoteState = null,
  onTransform,
  roomCode,
  participantId,
  joinedAtMs,
  canChangeAsset = false,
  onRequestAssetChange,
  controlHolderName = null,
  onTrackingChange,
}: ViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const soloRef = useRef<SoloViewerHandle | null>(null);
  /** 마지막으로 적용한 원격 seq. 같은 상태를 두 번 적용하지 않습니다. */
  const appliedSeqRef = useRef(-1);

  const [assetStatus, setAssetStatus] = useState('Procedural preview');
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [soloMode, setSoloMode] = useState<SoloMode>('off');
  const [gestureTarget, setGestureTarget] = useState<GestureTarget>('shared');

  // 콜백 안에서 최신 값을 읽되, 값이 바뀔 때마다 VisionCamera 를 다시 만들지는 않습니다.
  const gestureTargetRef = useRef<GestureTarget>('shared');
  gestureTargetRef.current = soloMode === 'off' ? 'shared' : gestureTarget;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8fafc);
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    // 건물 높이(약 5.1)가 위아래 여백을 두고 들어오도록 잡은 거리입니다.
    camera.position.set(9.5, 7.5, 11);
    cameraRef.current = camera;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);
    // OrbitControls 는 완전히 로컬입니다. 카메라는 각자의 것이고, 공유 대상은 모델 transform 하나뿐입니다.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // 모델의 세로 중앙(0 ~ 5.1)을 화면 중앙에 둡니다.
    controls.target.set(0, MODEL_FOCUS_Y, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xcbd5e1, 2.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(5, 10, 7);
    scene.add(keyLight);
    scene.add(new THREE.GridHelper(18, 18, 0xcbd5e1, 0xe2e8f0));
    const model = createBuilding();
    modelRef.current = model;
    scene.add(model);
    const resize = () => {
      const { width, height } = mount.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      // updateStyle 을 끄면 캔버스가 픽셀 비율만큼 커진 채로 배치돼 화면 일부만 보입니다.
      renderer.setSize(width, height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    let frame = 0;
    const render = () => { controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(render); };
    render();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      cameraRef.current = null;
      rendererRef.current = null;
      sceneRef.current = null;
      if (modelRef.current) disposeObject(modelRef.current);
      modelRef.current = null;
    };
  }, []);

  /* 도면 로딩 + 구간별 측정 */
  useEffect(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!asset?.url || !renderer || !camera || !scene) return;

    const controller = new AbortController();
    const loadIndex = markAssetLoad();
    setAssetStatus('Loading...');
    setLoadProgress(0);

    (async () => {
      try {
        const { gltf, timings } = await loadAsset(asset.url, {
          renderer,
          camera,
          signal: controller.signal,
          onProgress: (progress) => setLoadProgress(progress.ratio),
        });
        if (controller.signal.aborted) return;

        // 이전 모델의 GPU 자원을 반납하고 새 도면으로 교체합니다.
        const previous = modelRef.current;
        if (previous) {
          scene.remove(previous);
          disposeObject(previous);
        }
        const group = new THREE.Group();
        group.add(gltf.scene);
        scene.add(group);
        modelRef.current = group;
        appliedSeqRef.current = -1; // 새 모델에는 서버가 항등 변환을 내려줍니다.

        // 첫 render() 이후 이중 rAF 로 "실제로 화면에 나온 시점"을 잡습니다.
        const renderedAt = await afterFirstRender();
        setAssetStatus(`Loaded / ${formatBytes(timings.bytes)}`);
        setLoadProgress(null);

        const joinToRenderMs = Math.round(renderedAt - (joinedAtMs ?? renderedAt - timings.totalMs));
        const settings = getMeasurementSettings();

        // 워밍업 1회는 버립니다. 첫 요청에는 연결 수립 비용이 섞입니다.
        if (!shouldReportLoad(loadIndex)) return;

        await reportAssetLoad({
          ...(settings.runId ? { runId: settings.runId } : {}),
          ...(roomCode ? { roomCode } : {}),
          ...(participantId ? { clientId: participantId } : {}),
          assetPath: asset.url,
          assetBytes: timings.bytes,
          joinToRenderMs,
          ttfbMs: Math.round(timings.ttfbMs),
          downloadMs: Math.round(timings.downloadMs),
          parseMs: Math.round(timings.parseMs),
          gpuMs: Math.round(timings.gpuMs),
          raw: {
            ...measurementContext(),
            load_index: loadIndex,
            measuring: isMeasuring(),
            asset_id: asset.id,
            request_url: timings.url,
            transfer_size_bytes: timings.transferSizeBytes,
            // Performance API 분해. TAO 헤더가 없으면 null 입니다.
            resource_timing: timings.resource,
          },
        }).catch(() => {
          // 계측 보고 실패로 회의를 막지 않습니다.
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadProgress(null);
        setAssetStatus(error instanceof Error ? `Load failed: ${error.message}` : 'Load failed');
      }
    })();

    return () => controller.abort();
  }, [asset?.url, asset?.id, joinedAtMs, participantId, roomCode]);

  /* 원격 상태 적용: `fromArray` 이지 `+=` 가 아닙니다. */
  useEffect(() => {
    const model = modelRef.current;
    if (!model || !remoteState) return;
    if (remoteState.seq <= appliedSeqRef.current) return;
    appliedSeqRef.current = remoteState.seq;

    const { p, q, s } = remoteState.transform;
    model.position.fromArray(p);
    model.quaternion.fromArray(q);
    model.scale.fromArray(s);
  }, [remoteState]);

  /** 조작 결과(절대 transform)를 상위로 올립니다. 델타는 보내지 않습니다. */
  const publish = useCallback(
    (model: THREE.Group, event: GestureEvent) => {
      if (!onTransform) return;
      const kind = GESTURE_KIND[event.type];
      onTransform(
        {
          p: model.position.toArray() as [number, number, number],
          q: model.quaternion.toArray() as [number, number, number, number],
          s: model.scale.toArray() as [number, number, number],
        },
        kind ? { kind } : undefined,
      );
    },
    [onTransform],
  );

  const applyGesture = useCallback(
    (event: GestureEvent) => {
      // 내 모델을 조작하는 중이면 공유 모델은 건드리지도, 서버로 보내지도 않습니다.
      if (gestureTargetRef.current === 'solo') {
        soloRef.current?.applyGesture(event);
        return;
      }

      const model = modelRef.current;
      const camera = cameraRef.current;
      if (!model || !camera) return;
      if (applyGestureToModel(model, camera, event)) publish(model, event);
    },
    [publish],
  );

  /** 개인 뷰의 "Sync" 가 읽어 가는 공유 모델의 현재 상태 */
  const getSharedTransform = useCallback((): Transform | null => {
    const model = modelRef.current;
    if (!model) return null;
    return {
      p: model.position.toArray() as [number, number, number],
      q: model.quaternion.toArray() as [number, number, number, number],
      s: model.scale.toArray() as [number, number, number],
    };
  }, []);

  const closeSolo = useCallback(() => {
    setSoloMode('off');
    setGestureTarget('shared');
  }, []);

  const soloOpen = soloMode !== 'off';

  return <main className="relative flex min-w-0 flex-1 flex-col border-r border-slate-100 bg-white">
    <div className="relative z-20 flex items-center justify-between border-b border-slate-100 bg-white p-8">
      <div><span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-400">Live View</span><h2 className="font-serif text-2xl italic text-slate-900">{asset?.entryFilename ?? 'Active Render'}</h2></div>
      <div className="flex items-center gap-5">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-blue-600">
          {loadProgress !== null && <Loader2 className="h-3 w-3 animate-spin" />}
          {loadProgress !== null ? `${Math.round(loadProgress * 100)}%` : assetStatus}
        </span>
        <button
          type="button"
          onClick={() => (soloOpen ? closeSolo() : setSoloMode('pip'))}
          aria-pressed={soloOpen}
          title="공유 모델과 별개로, 나만 보고 조작하는 사본을 띄웁니다"
          className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer ${soloOpen ? 'text-blue-600' : 'text-slate-500 hover:text-slate-900'}`}
        >
          <User className="h-4 w-4" /> 나 혼자 보기
        </button>
        {canChangeAsset && (
          <button type="button" onClick={onRequestAssetChange} className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-900 cursor-pointer"><Rotate3d className="h-4 w-4" /> Load Asset</button>
        )}
        <button type="button" onClick={() => stageRef.current?.requestFullscreen?.()} className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-900 cursor-pointer"><Maximize2 className="h-4 w-4" /> Expand</button>
      </div>
    </div>

    {/* 공유 뷰와 개인 뷰가 함께 사는 무대. 전체화면도 이 단위로 걸어야 둘 다 보입니다. */}
    <div ref={stageRef} className="relative flex min-h-0 flex-1 bg-slate-50">
      <div ref={mountRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-slate-50">
        <div className="pointer-events-none absolute inset-0 z-10 opacity-30" style={{ backgroundImage: 'radial-gradient(#94a3b8 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
        <div className={`pointer-events-none absolute bottom-6 left-6 z-20 flex items-center gap-3 border px-5 py-3 text-[10px] font-bold uppercase tracking-widest shadow-lg ${gestureEnabled ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-900 bg-white text-slate-900'}`}>
          {gestureEnabled ? <Hand className="h-4 w-4" /> : <MousePointer2 className="h-4 w-4" />}
          {gestureEnabled ? 'Gesture control on' : 'Orbit controls enabled'}
        </div>

        {/* 손이 어느 모델을 움직일지. 개인 뷰를 열었을 때만 의미가 있습니다. */}
        {soloOpen && (
          <div className="absolute bottom-24 left-6 z-20 flex border border-slate-900 bg-white text-[10px] font-bold uppercase tracking-widest shadow-lg">
            {(['shared', 'solo'] as const).map((target) => (
              <button
                key={target}
                type="button"
                onClick={() => setGestureTarget(target)}
                className={`cursor-pointer px-4 py-2 transition-colors ${
                  gestureTarget === target
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-500 hover:text-slate-900'
                }`}
              >
                {target === 'shared' ? '공유 모델' : '내 모델'}
              </button>
            ))}
          </div>
        )}

        {controlHolderName && (
          <div className="pointer-events-none absolute bottom-6 right-6 z-20 border border-slate-900 bg-white px-5 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-900 shadow-lg">
            {controlHolderName} 조작 중
          </div>
        )}
        <VisionCamera onGesture={applyGesture} enabled={gestureEnabled} onTrackingChange={onTrackingChange} />
      </div>

      {/*
        pip 와 split 이 같은 DOM 자리를 쓰기 때문에 배치를 바꿔도 SoloViewer 가 다시 마운트되지
        않습니다. 다시 마운트되면 WebGL 컨텍스트와 도면을 매번 새로 만들게 됩니다.
      */}
      {soloMode !== 'off' && (
        <div
          className={
            soloMode === 'pip'
              ? 'absolute right-6 top-6 z-30 flex h-[46%] w-[38%] min-w-70 flex-col border border-slate-900 bg-white shadow-xl'
              : 'relative flex w-1/2 min-w-0 flex-col border-l border-slate-200 bg-white'
          }
        >
          <SoloViewer
            ref={soloRef}
            mode={soloMode}
            asset={asset}
            getSharedTransform={getSharedTransform}
            onModeChange={setSoloMode}
            onClose={closeSolo}
          />
        </div>
      )}
    </div>
  </main>;
}
