/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Everything about the view that `selectNodes` reads, flattened to numbers so
 * two passes can be compared without allocating: the camera pose, the
 * frustum's shape, and the viewport size. Fields a camera lacks read as `NaN`
 * and compare equal to themselves here, so a partial camera never reads as
 * moving.
 */
import type * as Cesium from 'cesium';

const FRUSTUM_FIELDS = ['fov', 'fovy', 'aspectRatio', 'near', 'far', 'width', 'xOffset', 'yOffset'] as const;

/** Fills `out` in place when given, so a per-pass caller can reuse one buffer. */
export function viewSignature(
  camera: Cesium.Camera,
  viewportWidth: number,
  viewportHeight: number,
  out: number[] = [],
): number[] {
  out.length = 0;
  out.push(viewportWidth, viewportHeight);
  for (const v of [camera.positionWC, camera.directionWC, camera.upWC] as (Cesium.Cartesian3 | undefined)[]) {
    out.push(v?.x ?? NaN, v?.y ?? NaN, v?.z ?? NaN);
  }
  const frustum = camera.frustum as unknown as Record<string, number | undefined> | undefined;
  for (const field of FRUSTUM_FIELDS) out.push(frustum?.[field] ?? NaN);
  return out;
}

/** True when the two signatures describe the same view (NaN equals NaN). */
export function sameView(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  }
  return true;
}
