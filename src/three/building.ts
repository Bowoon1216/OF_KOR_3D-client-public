import * as THREE from 'three';

/**
 * 도면이 붙기 전에 보여 주는 절차적 프리뷰.
 *
 * 공유 뷰와 "나 혼자 보기" 뷰가 모두 쓰기 때문에 호출할 때마다 새로 만듭니다.
 * 하나를 두 씬에 넣으면 뒤에 넣은 씬으로 옮겨져 앞의 씬에서 사라집니다.
 */
export function createBuilding(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.78, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.35, metalness: 0.2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.72, roughness: 0.12, metalness: 0.3 });
  const addBox = (size: [number, number, number], position: [number, number, number], surface = material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), surface);
    mesh.position.set(...position);
    group.add(mesh);
  };
  addBox([4.8, 0.35, 3.2], [0, 0.18, 0]);
  addBox([3.6, 2.2, 2.5], [0, 1.35, 0], dark);
  addBox([2.8, 1.7, 2.55], [0, 3.3, 0], material);
  addBox([2.3, 0.95, 2.65], [0, 4.63, 0], glass);
  addBox([0.3, 2.2, 0.2], [-1.75, 1.35, -1.32], glass);
  addBox([0.3, 2.2, 0.2], [1.75, 1.35, -1.32], glass);
  addBox([0.25, 1.7, 0.2], [-1.38, 3.3, -1.35], glass);
  addBox([0.25, 1.7, 0.2], [1.38, 3.3, -1.35], glass);
  return group;
}

/** 건물 높이(약 5.1)의 세로 중앙. 카메라가 바라보는 지점입니다. */
export const MODEL_FOCUS_Y = 2.55;
