/**
 * MediaPipe HandLandmarker 결과(21개 랜드마크)에서 제스처를 판별합니다.
 * 랜드마크 인덱스: 0 손목 / 4 엄지끝 / 8 검지끝 / 12 중지끝 / 16 약지끝 / 20 새끼끝
 */

export type Landmark = { x: number; y: number; z: number };

export type GestureType = 'NONE' | 'GRAB' | 'ROTATE' | 'ZOOM_IN' | 'ZOOM_OUT';

export const GESTURE_LABEL: Record<GestureType, string> = {
  NONE: 'Waiting',
  GRAB: 'Grab / Move',
  ROTATE: 'Rotate',
  ZOOM_IN: 'Zoom in',
  ZOOM_OUT: 'Zoom out',
};

/** 손가락별 [끝마디, 중간마디] */
const FINGER_JOINTS: Array<[number, number]> = [
  [8, 6], // 검지
  [12, 10], // 중지
  [16, 14], // 약지
  [20, 18], // 새끼
];

/** 집게 판정 임계값 (손 크기로 정규화한 비율). 켜질 때와 꺼질 때를 다르게 둬 떨림을 막습니다. */
const PINCH_ON = 0.45;
const PINCH_OFF = 0.65;
/** 두 집게 후보가 비슷하게 가까울 때는 어느 쪽인지 확정하지 않습니다. */
const PINCH_MARGIN = 0.12;
/** 회전은 두 집게가 이만큼 벌어져 있을 때만 허용합니다 (확대/축소 중 회전 방지). */
const ROTATE_PINCH_CLEARANCE = 0.8;
/** 회전 각도 저역통과 계수 (0에 가까울수록 부드럽지만 느림) */
const ROTATION_SMOOTHING = 0.4;
/** 손바닥이 위/아래를 거의 정면으로 볼 때는 좌우 각도가 튀므로 무시합니다. (65도) */
const YAW_UNSTABLE_PITCH = 1.13;

function distance2D(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 손목 ~ 중지 밑마디 길이. 카메라와의 거리에 따른 크기 차이를 정규화하는 기준입니다. */
export function handSpan(hand: Landmark[]): number {
  return Math.max(distance2D(hand[0], hand[9]), 1e-4);
}

/** 손끝이 중간마디보다 손목에 가까우면 접힌 것으로 봅니다. 손 방향이 바뀌어도 안정적입니다. */
function isCurled(hand: Landmark[], tip: number, joint: number): boolean {
  return distance2D(hand[0], hand[tip]) < distance2D(hand[0], hand[joint]);
}

function curledCount(hand: Landmark[]): number {
  return FINGER_JOINTS.filter(([tip, joint]) => isCurled(hand, tip, joint)).length;
}

/** 엄지끝과 지정한 손끝 사이 거리 (손 크기 대비 비율) */
export function pinchRatio(hand: Landmark[], tip: number): number {
  return distance2D(hand[4], hand[tip]) / handSpan(hand);
}

export type PalmAngles = {
  /** 손바닥 법선의 좌우 방향각 (손등/손바닥 뒤집기) */
  yaw: number;
  /** 손바닥 법선이 위/아래를 보는 정도. 손바닥을 아래로 눕히면 커집니다. */
  pitch: number;
  /** yaw 를 신뢰할 수 있는 자세인지 */
  yawStable: boolean;
};

/**
 * 손바닥 법선(= (검지밑마디 - 손목) × (새끼밑마디 - 손목))으로 손의 자세를 구합니다.
 * 오른손이 카메라를 향한 상태를 기준으로 맞춰져 있습니다.
 */
export function palmAngles(hand: Landmark[]): PalmAngles {
  const wrist = hand[0];
  const ax = hand[5].x - wrist.x;
  const ay = hand[5].y - wrist.y;
  const az = hand[5].z - wrist.z;
  const bx = hand[17].x - wrist.x;
  const by = hand[17].y - wrist.y;
  const bz = hand[17].z - wrist.z;

  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;

  const horizontal = Math.hypot(nx, nz);
  const pitch = Math.atan2(ny, horizontal);

  return {
    yaw: Math.atan2(nx, nz),
    pitch,
    yawStable: horizontal > 1e-4 && Math.abs(pitch) < YAW_UNSTABLE_PITCH,
  };
}

/** 각도 차이를 -π ~ π 로 접습니다. */
export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * 제스처 판별. 직전 제스처를 넘기면 임계값에 히스테리시스를 적용해 경계에서 덜 흔들립니다.
 *
 * 우선순위: 주먹(잡기) > 집게(확대/축소) > 편 손(회전)
 * 주먹을 먼저 보는 이유는 주먹 쥔 손에서도 엄지와 손끝 거리가 가까워 집게로 오인될 수 있어서입니다.
 */
export function classifyGesture(hand: Landmark[], previous: GestureType): GestureType {
  const curled = curledCount(hand);

  // 1. 주먹 - 네 손가락이 모두 접힘 (풀 때는 3개까지 허용해 잡은 상태가 쉽게 끊기지 않게)
  const fistThreshold = previous === 'GRAB' ? 3 : 4;
  if (curled >= fistThreshold) return 'GRAB';

  // 2. 집게 - 엄지 + 검지(확대) / 엄지 + 중지(축소)
  const indexPinch = pinchRatio(hand, 8);
  const middlePinch = pinchRatio(hand, 12);
  const zoomInLimit = previous === 'ZOOM_IN' ? PINCH_OFF : PINCH_ON;
  const zoomOutLimit = previous === 'ZOOM_OUT' ? PINCH_OFF : PINCH_ON;
  const indexClosed = indexPinch < zoomInLimit;
  const middleClosed = middlePinch < zoomOutLimit;

  if (indexClosed || middleClosed) {
    const difference = Math.abs(indexPinch - middlePinch);
    // 두 손끝이 붙어 있어 구분이 안 되면 직전 제스처를 유지합니다.
    if (indexClosed && middleClosed && difference < PINCH_MARGIN) {
      return previous === 'ZOOM_IN' || previous === 'ZOOM_OUT' ? previous : 'NONE';
    }
    return indexPinch < middlePinch ? 'ZOOM_IN' : 'ZOOM_OUT';
  }

  // 3. 편 손 - 손바닥을 뒤집는 동작으로 회전.
  //    집는 중에 회전이 섞이지 않도록 두 집게가 확실히 벌어져 있을 때만 인정합니다.
  const pinchClear = indexPinch > ROTATE_PINCH_CLEARANCE && middlePinch > ROTATE_PINCH_CLEARANCE;
  const openThreshold = previous === 'ROTATE' ? 2 : 3;
  if (pinchClear && 4 - curled >= openThreshold) return 'ROTATE';

  return 'NONE';
}

export type RotationDelta = { deltaYaw: number; deltaPitch: number };

/**
 * 회전 제스처가 유지되는 동안의 각도 변화를 누적/평활화해 돌려줍니다.
 * 좌우(yaw)는 한 바퀴를 넘겨도 이어지도록 펴서 누적하고,
 * 상하(pitch)는 손바닥이 향한 각도를 그대로 따라갑니다.
 */
export function createRotationTracker() {
  let previous: PalmAngles | null = null;
  let target = { yaw: 0, pitch: 0 };
  let smoothed = { yaw: 0, pitch: 0 };

  return {
    /** 제스처가 바뀌거나 손을 놓쳤을 때 기준을 다시 잡습니다. */
    reset() {
      previous = null;
    },
    update(hand: Landmark[]): RotationDelta {
      const angles = palmAngles(hand);

      if (!previous) {
        previous = angles;
        target = { yaw: 0, pitch: angles.pitch };
        smoothed = { ...target };
        return { deltaYaw: 0, deltaPitch: 0 };
      }

      if (angles.yawStable && previous.yawStable) {
        target.yaw += wrapAngle(angles.yaw - previous.yaw);
      }
      target.pitch = angles.pitch;
      previous = angles;

      const yaw = smoothed.yaw + (target.yaw - smoothed.yaw) * ROTATION_SMOOTHING;
      const pitch = smoothed.pitch + (target.pitch - smoothed.pitch) * ROTATION_SMOOTHING;
      const delta = { deltaYaw: yaw - smoothed.yaw, deltaPitch: pitch - smoothed.pitch };
      smoothed = { yaw, pitch };
      return delta;
    },
  };
}
