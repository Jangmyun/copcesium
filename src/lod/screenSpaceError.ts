/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import * as Cesium from 'cesium';

// Camera.frustum is PerspectiveFrustum | PerspectiveOffCenterFrustum | OrthographicFrustum;
// only PerspectiveFrustum exposes fovy. The other two aren't used for this library's default
// scene setup, so we fall back to a typical 60° vertical FOV rather than threading an explicit
// fovy option through every call site.
export const DEFAULT_FOVY = Cesium.Math.toRadians(60);

/** Vertical field of view of `frustum`, or the 60° default when it has none. */
export function getFovy(frustum: Cesium.Camera['frustum']): number {
  return (frustum instanceof Cesium.PerspectiveFrustum ? frustum.fovy : undefined) ?? DEFAULT_FOVY;
}

/** Pixels per unit of (size / distance) for a viewport of `viewportHeight` at `fovy`. */
export function sseScale(viewportHeight: number, fovy: number): number {
  return viewportHeight / (2 * Math.tan(fovy / 2));
}

/**
 * Approximates how many screen pixels a node's bounding sphere radius covers,
 * using the same "geometric error in pixels" metric 3D Tiles uses for LoD.
 */
export function computeScreenSpaceError(
  boundingSphere: Cesium.BoundingSphere,
  cameraPosition: Cesium.Cartesian3,
  viewportHeight: number,
  fovy: number,
  scale: number = sseScale(viewportHeight, fovy),
): number {
  const dx = boundingSphere.center.x - cameraPosition.x;
  const dy = boundingSphere.center.y - cameraPosition.y;
  const dz = boundingSphere.center.z - cameraPosition.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Camera at (or touching) the sphere's center: distance would blow up the
  // division below, so short-circuit to "always subdivide further" instead.
  if (distance <= 1e-6) return Infinity;

  return (boundingSphere.radius * scale) / distance;
}
