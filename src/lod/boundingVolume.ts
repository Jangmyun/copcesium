import * as Cesium from 'cesium';
import { parseKey } from '../copc/key';

export type ProjectToCartesian = (x: number, y: number, z: number) => Cesium.Cartesian3;

export function getNodeBoundingSphere(
  key: string,
  rootCenter: { x: number; y: number; z: number },
  rootHalfSize: number,
  project: ProjectToCartesian,
  xyFactor = 1,
): Cesium.BoundingSphere {
  const [level, xi, yi, zi] = parseKey(key);
  const nodeHalfSize = rootHalfSize / Math.pow(2, level);

  const cx = rootCenter.x - rootHalfSize + (2 * xi + 1) * nodeHalfSize;
  const cy = rootCenter.y - rootHalfSize + (2 * yi + 1) * nodeHalfSize;
  const cz = rootCenter.z - rootHalfSize + (2 * zi + 1) * nodeHalfSize;

  const center = project(cx, cy, cz);
  const radius = nodeHalfSize * xyFactor * Math.sqrt(3);

  return new Cesium.BoundingSphere(center, radius);
}

export function getCullingVolume(camera: Cesium.Camera): Cesium.CullingVolume {
  // The `WC` variants, not `position`/`direction`/`up`: those are relative to
  // `camera.transform`, which is the identity only until something calls
  // `camera.lookAt()` — a routine way to orbit a target. Under a lookAt the
  // unqualified vectors are local to the target's frame, so a volume built
  // from them sits near the Earth's centre and culls every node, blanking the
  // point cloud until the transform is released.
  return camera.frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC);
}

export function isInFrustum(sphere: Cesium.BoundingSphere, cullingVolume: Cesium.CullingVolume): boolean {
  return cullingVolume.computeVisibility(sphere) !== Cesium.Intersect.OUTSIDE;
}
