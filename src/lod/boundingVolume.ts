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

// Camera.frustum has no settable near-plane fov once it's a plain
// PerspectiveFrustum built without one (unusual, but the type allows it) —
// matches selectNodes.ts's own fallback for the same reason.
const DEFAULT_FOVY = Cesium.Math.toRadians(60);

/**
 * Builds the culling volume for a frustum widened by `factor`, for
 * prefetching nodes just outside the actual display frustum (#212).
 *
 * `factor` scales the frustum's near-plane projected width and height, not
 * its raw field-of-view angle: a `PerspectiveFrustum`'s `fov` is remapped
 * through `2*atan(factor*tan(fov/2))`, which grows both dimensions by
 * exactly `factor` regardless of aspect ratio (a plain multiply on the angle
 * itself would widen a narrow FOV less than a wide one, for the same
 * on-screen margin). The two off-center frustum types already store their
 * near-plane extents directly (`left`/`right`/`top`/`bottom`, or `width`), so
 * those are scaled as-is.
 */
export function getExpandedCullingVolume(
  camera: Cesium.Camera,
  factor: number,
): Cesium.CullingVolume {
  const frustum = camera.frustum;
  let expanded:
    Cesium.PerspectiveFrustum | Cesium.PerspectiveOffCenterFrustum | Cesium.OrthographicFrustum;

  if (frustum instanceof Cesium.PerspectiveFrustum) {
    expanded = frustum.clone();
    const fov = frustum.fov ?? DEFAULT_FOVY;
    expanded.fov = 2 * Math.atan(factor * Math.tan(fov / 2));
  } else if (frustum instanceof Cesium.PerspectiveOffCenterFrustum) {
    expanded = frustum.clone();
    expanded.left = (frustum.left ?? 0) * factor;
    expanded.right = (frustum.right ?? 0) * factor;
    expanded.top = (frustum.top ?? 0) * factor;
    expanded.bottom = (frustum.bottom ?? 0) * factor;
  } else {
    expanded = frustum.clone();
    expanded.width = (frustum.width ?? 0) * factor;
  }

  // See getCullingVolume() above for why these are the `WC` variants.
  return expanded.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC);
}
