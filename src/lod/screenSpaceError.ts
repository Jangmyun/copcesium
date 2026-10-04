/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import type * as Cesium from 'cesium';

/**
 * Approximates how many screen pixels a node's bounding sphere radius covers,
 * using the same "geometric error in pixels" metric 3D Tiles uses for LoD.
 */
export function computeScreenSpaceError(
  boundingSphere: Cesium.BoundingSphere,
  cameraPosition: Cesium.Cartesian3,
  viewportHeight: number,
  fovy: number,
): number {
  const dx = boundingSphere.center.x - cameraPosition.x;
  const dy = boundingSphere.center.y - cameraPosition.y;
  const dz = boundingSphere.center.z - cameraPosition.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Camera at (or touching) the sphere's center: distance would blow up the
  // division below, so short-circuit to "always subdivide further" instead.
  if (distance <= 1e-6) return Infinity;

  const k = viewportHeight / (2 * Math.tan(fovy / 2));
  return (boundingSphere.radius * k) / distance;
}
