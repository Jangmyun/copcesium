/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Request ordering for one LoD pass: decides which of the nodes already
 * selected for loading go out first. It never changes what gets loaded.
 */
import type * as Cesium from 'cesium';
import { getDepth } from '../copc/node';

/**
 * Cosine of the angle between `point` and the camera's forward vector: 1 on the
 * view axis, falling off toward the edges of the screen.
 */
export function viewAlignment(
  point: Cesium.Cartesian3,
  eye: Cesium.Cartesian3,
  forward: Cesium.Cartesian3,
): number {
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // A camera sitting on the point is as central as it gets.
  return distance > 0 ? (dx * forward.x + dy * forward.y + dz * forward.z) / distance : 1;
}

/**
 * Orders nodes for requesting: shallowest first, then closest to the view axis.
 *
 * Depth comes first because a shallower node covers more of the screen, so the
 * view fills in coarsely and then sharpens rather than arriving as scattered
 * patches of fine detail. Within a depth the angle off the camera's forward
 * vector stands in for distance from the screen centre, which is where a
 * viewer is usually looking; screen-space error can't say that, since it only
 * knows how large a node appears, not where.
 */
export function orderForLoading(
  keys: Iterable<string>,
  getSphere: (key: string) => Cesium.BoundingSphere,
  camera: Cesium.Camera,
): string[] {
  // The `WC` variants for the same reason as `getCullingVolume`: the plain
  // vectors are local to `camera.transform` under a `lookAt()`.
  const eye = camera.positionWC;
  const forward = camera.directionWC;

  const ranked = Array.from(keys, (key) => ({
    key,
    depth: getDepth(key),
    alignment: viewAlignment(getSphere(key).center, eye, forward),
  }));

  ranked.sort((a, b) => a.depth - b.depth || b.alignment - a.alignment);
  return ranked.map((entry) => entry.key);
}
