import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { downloadAsset, type DownloadProgress, type ResourceBreakdown } from '../api/assetDownload';
import { getMeasurementSettings } from '../config/measurement';

/**
 * 에셋 로딩 + 구간별 시간 측정.
 *
 * 명세 7.7 이 요구하는 세 가지를 지킵니다.
 *  1. `GLTFLoader.load()` 가 아니라 `fetch()` 로 직접 받아야 TTFB 를 잴 수 있다
 *  2. `renderer.compile()` 을 씬에 넣기 **전에** 호출해야 셰이더 컴파일이 측정 구간에 들어온다
 *  3. `first_render_complete` 는 첫 `render()` 이후 **이중 rAF** 로 잡는다 (호출자 쪽에서 수행)
 *
 * 파이프라인이 draco / meshopt / KTX2 변형본을 만들기 때문에 디코더를 모두 붙여 둡니다.
 * 붙이지 않으면 압축 변형본이 "Unsupported extension" 으로 조용히 실패합니다.
 */

export interface AssetLoadTimings {
  /** 요청 시작 → 첫 바이트 */
  ttfbMs: number;
  /** 첫 바이트 → 마지막 바이트 */
  downloadMs: number;
  /** glTF 파싱 (지오메트리·텍스처 디코드 포함) */
  parseMs: number;
  /** 셰이더 컴파일 + GPU 업로드 */
  gpuMs: number;
  /** 위 구간의 합 */
  totalMs: number;
  bytes: number;
  /** 실제로 요청한 절대 URL (캐시 무력화 쿼리 포함) */
  url: string;
  /** Performance API 로 분해한 네트워크 구간. 교차 오리진 TAO 가 없으면 null */
  resource: ResourceBreakdown | null;
  transferSizeBytes: number | null;
}

export interface LoadAssetOptions {
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

let dracoLoader: DRACOLoader | null = null;
let ktx2Loader: KTX2Loader | null = null;

/** 디코더는 무겁기 때문에 한 번만 만들어 재사용합니다. */
function createLoader(renderer: THREE.WebGLRenderer): GLTFLoader {
  const loader = new GLTFLoader();

  // 경로를 비워 두면 three 가 번들에 포함된 디코더를 씁니다(Vite 가 `import.meta.url` 로 내보냄).
  // CDN 을 지정하면 측정에 외부망 변수가 섞이므로 그대로 둡니다.
  if (!dracoLoader) dracoLoader = new DRACOLoader();
  loader.setDRACOLoader(dracoLoader);

  if (!ktx2Loader) ktx2Loader = new KTX2Loader();
  // detectSupport 는 렌더러가 바뀌면 다시 불러야 합니다.
  ktx2Loader.detectSupport(renderer);
  loader.setKTX2Loader(ktx2Loader);

  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** `.gltf` 는 `.bin`·텍스처를 상대 URI 로 참조하므로 폴더 경로를 넘겨야 합니다. */
function resourcePathOf(url: string): string {
  const withoutQuery = url.split('?')[0];
  return withoutQuery.slice(0, withoutQuery.lastIndexOf('/') + 1);
}

export async function loadAsset(
  path: string,
  options: LoadAssetOptions,
): Promise<{ gltf: GLTF; timings: AssetLoadTimings }> {
  const { renderer, camera, onProgress, signal } = options;
  const { cacheBust } = getMeasurementSettings();

  // 측정 중에는 매 요청에 ?t= 를 붙여 캐시를 무력화합니다 (Phase 1 하네스와 같은 규칙).
  const requestPath = cacheBust
    ? `${path}${path.includes('?') ? '&' : '?'}t=${Math.floor(performance.timeOrigin + performance.now())}`
    : path;

  const download = await downloadAsset(requestPath, {
    onProgress,
    signal,
    noCache: cacheBust,
  });

  const parseStart = performance.now();
  const loader = createLoader(renderer);
  const gltf = await loader.parseAsync(
    download.data.buffer as ArrayBuffer,
    resourcePathOf(download.url),
  );
  const parseMs = performance.now() - parseStart;

  // 씬에 넣기 전에 컴파일해야 셰이더 컴파일 비용이 이 구간 안에 들어옵니다.
  // 씬에 먼저 넣으면 첫 render() 안에서 컴파일이 일어나 parse/gpu 구분이 무너집니다.
  const gpuStart = performance.now();
  const stage = new THREE.Scene();
  stage.add(gltf.scene);
  await renderer.compileAsync(gltf.scene, camera, stage);
  stage.remove(gltf.scene);
  const gpuMs = performance.now() - gpuStart;

  return {
    gltf,
    timings: {
      ttfbMs: download.timing.ttfbMs,
      downloadMs: download.timing.downloadMs,
      parseMs,
      gpuMs,
      totalMs: download.timing.totalMs + parseMs + gpuMs,
      bytes: download.bytes,
      url: download.url,
      resource: download.timing.resource,
      transferSizeBytes: download.timing.transferSizeBytes,
    },
  };
}

/**
 * 첫 `render()` 가 실제로 화면에 반영된 시점.
 * rAF 한 번은 "다음 프레임 준비"까지고, 합성이 끝난 시점은 두 번째 rAF 에서 잡힙니다.
 */
export function afterFirstRender(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve(performance.now()));
    });
  });
}

/** 씬에서 뺀 모델의 GPU 자원을 정리합니다. 도면을 교체할 때마다 부르지 않으면 메모리가 샙니다. */
export function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}
