import { HandLandmarker } from '@mediapipe/tasks-vision';
import wasmBinaryPath from '../mediapipe/wasm/vision_wasm_internal.wasm?url';
import wasmLoaderPath from '../mediapipe/wasm/vision_wasm_internal.js?url';

let landmarker: HandLandmarker | null = null;

self.onmessage = async (event: MessageEvent) => {
  const { type, image, timestamp } = event.data;

  if (type === 'init') {
    try {
      const vision = { wasmLoaderPath, wasmBinaryPath };
      landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
      });
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'MediaPipe 초기화 실패' });
    }
    return;
  }

  if (type === 'frame' && landmarker && image) {
    try {
      const result = landmarker.detectForVideo(image, timestamp);
      self.postMessage({
        type: 'result',
        timestamp,
        landmarks: result.landmarks,
      });
    } catch (error) {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '손 추론 실패' });
    } finally {
      image.close();
    }
  }
};
