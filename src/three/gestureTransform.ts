import * as THREE from 'three';
import type { GestureEvent } from '../components/VisionCamera';

/**
 * 손 제스처를 모델 transform 으로 옮기는 계산.
 *
 * 공유 모델(`Viewer`)과 내 개인 모델(`SoloViewer`)이 같은 손 동작에 똑같이 반응해야 하므로
 * 두 뷰가 이 함수 하나를 나눠 씁니다. 카메라가 뷰마다 다르기 때문에 인자로 받습니다.
 */

/** 손 이동량(정규화 좌표) → 씬 단위 이동량 */
const PAN_SPEED = 12;
/**
 * 손 각도 → 모델 회전 각도 (1 = 손을 돌린 만큼 그대로).
 * 방향이 반대로 느껴지면 부호를 뒤집으면 됩니다.
 */
const YAW_GAIN = 1.4;
const PITCH_GAIN = 1.4;
/** 집게를 유지하는 동안 한 프레임당 확대/축소 비율 */
const ZOOM_STEP = 0.012;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

/** 좌우 회전은 (카메라를 어디로 돌렸든) 화면에서 수직으로 보이는 축을 기준으로 합니다. */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
// 매 프레임 새 객체를 만들지 않도록 재사용하는 임시 값들 (적용은 항상 동기적입니다)
const scratchForward = new THREE.Vector3();
const scratchRight = new THREE.Vector3();
const scratchUp = new THREE.Vector3();
const spin = new THREE.Quaternion();

/**
 * 제스처 하나를 모델에 즉시 반영합니다. 제스처는 **로컬에서 먼저 적용**하고(명세 6.7)
 * 그 결과 절대 transform 을 나중에 보냅니다.
 *
 * @returns 모델이 실제로 움직였으면 true. 호출자는 이때만 송신하면 됩니다.
 */
export function applyGestureToModel(
  model: THREE.Object3D,
  camera: THREE.Camera,
  event: GestureEvent,
): boolean {
  if (event.type === 'GRAB') {
    // 카메라를 어느 방향으로 돌려놨든 화면에서 손이 움직인 방향으로 평행이동합니다.
    const forward = camera.getWorldDirection(scratchForward);
    const right = scratchRight.crossVectors(forward, camera.up).normalize();
    const up = scratchUp.crossVectors(right, forward).normalize();
    model.position.addScaledVector(right, event.deltaX * PAN_SPEED);
    model.position.addScaledVector(up, -event.deltaY * PAN_SPEED);
    return true;
  }

  if (event.type === 'ROTATE') {
    // 오일러 각(rotation.x/y)에 더하면 축이 모델을 따라 돌아가 버립니다.
    // 항상 화면 기준으로 돌도록 월드 축 회전을 앞에 곱합니다.
    // 좌우: 수직축 기준 / 상하: 카메라의 가로축 기준 (손바닥을 아래로 눕히면 윗면이 보임)
    if (event.deltaYaw) {
      model.quaternion.premultiply(spin.setFromAxisAngle(WORLD_UP, event.deltaYaw * YAW_GAIN));
    }
    if (event.deltaPitch) {
      const forward = camera.getWorldDirection(scratchForward);
      const right = scratchRight.crossVectors(forward, camera.up).normalize();
      model.quaternion.premultiply(spin.setFromAxisAngle(right, event.deltaPitch * PITCH_GAIN));
    }
    model.quaternion.normalize();
    return true;
  }

  if (event.type === 'ZOOM_IN' || event.type === 'ZOOM_OUT') {
    const factor = event.type === 'ZOOM_IN' ? 1 + ZOOM_STEP : 1 - ZOOM_STEP;
    const next = THREE.MathUtils.clamp(model.scale.x * factor, MIN_SCALE, MAX_SCALE);
    model.scale.setScalar(next);
    return true;
  }

  return false;
}
