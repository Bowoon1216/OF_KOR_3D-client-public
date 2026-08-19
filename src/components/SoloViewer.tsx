import { Loader2, Maximize2, Minimize2, RotateCcw, X } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AssetSummary, Transform } from '../api/types';
import { createBuilding, MODEL_FOCUS_Y } from '../three/building';
import { disposeObject, loadAsset } from '../three/assetLoader';
import { applyGestureToModel } from '../three/gestureTransform';
import type { GestureEvent } from './VisionCamera';

/** 개인 뷰의 배치. `pip` 는 공유 화면 위에 겹치고, `split` 은 오른쪽 절반을 차지합니다. */
export type SoloMode = 'off' | 'pip' | 'split';

export interface SoloViewerHandle {
  /** 손 제스처를 내 모델에만 적용합니다. 서버로는 아무것도 나가지 않습니다. */
  applyGesture: (event: GestureEvent) => void;
}

type SoloViewerProps = {
  mode: Exclude<SoloMode, 'off'>;
  /** 방에 붙어 있는 도면. 같은 파일을 각자 한 벌씩 들고 봅니다. */
  asset: AssetSummary | null;
  /** 공유 모델의 현재 transform. "공유 상태 복사" 버튼이 씁니다. */
  getSharedTransform: () => Transform | null;
  onModeChange: (mode: Exclude<SoloMode, 'off'>) => void;
  onClose: () => void;
};

const CAMERA_START = new THREE.Vector3(9.5, 7.5, 11);

/**
 * 나 혼자 보는 3D 모델.
 *
 * 공유 뷰와 **완전히 분리된** 씬·카메라·모델을 갖습니다. 여기서 무엇을 하든
 * `state` frame 이 나가지 않으므로 다른 참가자의 화면은 그대로입니다. 회의 중에
 * "잠깐 뒤쪽을 혼자 돌려 보고 싶다"를 조작 권한 다툼 없이 할 수 있게 하는 것이 목적입니다.
 *
 * 도면은 공유 뷰가 이미 받은 URL 을 다시 요청합니다. 브라우저 캐시가 받아 주므로
 * 보통은 네트워크가 아니라 디스크에서 옵니다. 공유 뷰의 모델을 `clone()` 하지 않는 이유는
 * 스킨드 메시·애니메이션이 있는 glTF 가 얕은 복제에서 조용히 깨지기 때문입니다.
 */
const SoloViewer = forwardRef<SoloViewerHandle, SoloViewerProps>(function SoloViewer(
  { mode, asset, getSharedTransform, onModeChange, onClose },
  ref,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRef = useRef<THREE.Object3D | null>(null);

  const [status, setStatus] = useState<'preview' | 'loading' | 'ready' | 'error'>('preview');
  const [message, setMessage] = useState('Procedural preview');

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    // 공유 뷰(밝은 회색)와 한눈에 구분되도록 개인 뷰는 조금 더 어둡게 둡니다.
    scene.background = new THREE.Color(0xeef2f7);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    camera.position.copy(CAMERA_START);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);

    // 카메라는 공유 대상이 아닙니다(명세 6.7). 개인 뷰는 더더욱 각자의 것입니다.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, MODEL_FOCUS_Y, 0);
    controlsRef.current = controls;

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
      renderer.setSize(width, height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    let frame = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      if (modelRef.current) disposeObject(modelRef.current);
      modelRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  /* 도면 로딩. 여기서는 계측을 보고하지 않습니다 — 개인 뷰의 로딩 시간이
     검증 지표("방 입장~렌더링 완료") 표본에 섞이면 안 됩니다. */
  useEffect(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!asset?.url || !renderer || !camera || !scene) return;

    const controller = new AbortController();
    setStatus('loading');
    setMessage('Loading...');

    (async () => {
      try {
        const { gltf } = await loadAsset(asset.url, {
          renderer,
          camera,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        const previous = modelRef.current;
        if (previous) {
          scene.remove(previous);
          disposeObject(previous);
        }
        const group = new THREE.Group();
        group.add(gltf.scene);
        scene.add(group);
        modelRef.current = group;
        setStatus('ready');
        setMessage(asset.entryFilename);
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus('error');
        setMessage(error instanceof Error ? error.message : 'Load failed');
      }
    })();

    return () => controller.abort();
  }, [asset?.url, asset?.entryFilename]);

  useImperativeHandle(
    ref,
    () => ({
      applyGesture: (event) => {
        const model = modelRef.current;
        const camera = cameraRef.current;
        if (!model || !camera) return;
        applyGestureToModel(model, camera, event);
      },
    }),
    [],
  );

  const resetView = () => {
    const model = modelRef.current;
    model?.position.set(0, 0, 0);
    model?.quaternion.identity();
    model?.scale.setScalar(1);
    cameraRef.current?.position.copy(CAMERA_START);
    controlsRef.current?.target.set(0, MODEL_FOCUS_Y, 0);
  };

  const copyShared = () => {
    const model = modelRef.current;
    const shared = getSharedTransform();
    if (!model || !shared) return;
    model.position.fromArray(shared.p);
    model.quaternion.fromArray(shared.q);
    model.scale.fromArray(shared.s);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-blue-600">
            My view · 나만 보임
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] uppercase tracking-widest text-slate-400">
            {status === 'loading' && <Loader2 className="h-3 w-3 animate-spin" />}
            {message}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={copyShared}
            title="공유 모델의 현재 위치·각도를 내 모델에 복사"
            className="cursor-pointer text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-900"
          >
            Sync
          </button>
          <button
            type="button"
            onClick={resetView}
            title="내 모델을 처음 상태로"
            aria-label="내 모델 초기화"
            className="cursor-pointer text-slate-400 hover:text-slate-900"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onModeChange(mode === 'pip' ? 'split' : 'pip')}
            title={mode === 'pip' ? '반으로 나눠 보기' : '작게 겹쳐 보기'}
            aria-label={mode === 'pip' ? '반으로 나눠 보기' : '작게 겹쳐 보기'}
            className="cursor-pointer text-slate-400 hover:text-slate-900"
          >
            {mode === 'pip' ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="나 혼자 보기 닫기"
            className="cursor-pointer text-slate-400 hover:text-slate-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div ref={mountRef} className="relative min-h-0 flex-1 overflow-hidden bg-slate-100" />
    </div>
  );
});

export default SoloViewer;
