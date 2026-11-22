/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Spatial clipping: planes and boxes in world (ECEF) coordinates, applied in
 * the vertex shader. The regions are re-expressed per node, on the CPU in
 * double precision, relative to that node's origin — the shader only ever
 * sees small node-local numbers, so a clip boundary lands where it was put
 * rather than snapping to Float32's ~0.5 m steps at ECEF magnitudes.
 */
import * as Cesium from 'cesium';
import type { ClipMode } from '../types';

export const MAX_CLIP_PLANES = 6;
export const MAX_CLIP_BOXES = 4;

/** Clip mode as the shader sees it; `none` also stands in when no region is set. */
export const CLIP_MODE = {
  none: 0,
  inside: 1,
  outside: 2,
} as const;

/**
 * Shared live by every loaded primitive, like the rest of `PointStyle`.
 * Replaced field-by-field by `CopcDataSource`'s setters, which bump
 * `version` so each primitive knows to rebuild its node-local uniforms.
 */
export interface ClipState {
  planes: Cesium.Plane[];
  /** Copies of the user's box matrices: unit cube -> world. */
  boxes: Cesium.Matrix4[];
  /** Their inverses: world -> unit-cube coordinates. */
  inverseBoxes: Cesium.Matrix4[];
  /** One of `CLIP_MODE`'s values, before the "no regions" override. */
  mode: number;
  version: number;
}

/**
 * Maps a `ClipMode` to its shader value, throwing on anything else. Untyped
 * JS could otherwise pass e.g. `'foo'`, which would index to `undefined`, reach
 * the shader as 0 (`none`), and silently turn clipping off.
 */
export function validateClipMode(mode: ClipMode): number {
  if (mode !== 'inside' && mode !== 'outside') {
    throw new RangeError(`clipMode must be 'inside' or 'outside', got ${String(mode)}`);
  }
  return CLIP_MODE[mode];
}

export function createClipState(
  planes: Cesium.Plane[] | undefined,
  boxes: Cesium.Matrix4[] | undefined,
  mode: ClipMode,
): ClipState {
  const clip: ClipState = {
    planes: validateClipPlanes(planes),
    boxes: [],
    inverseBoxes: [],
    mode: validateClipMode(mode),
    version: 0,
  };
  setClipBoxes(clip, boxes);
  return clip;
}

/** Copies, so later mutation of the caller's planes can't change the clip unseen. */
export function validateClipPlanes(planes: Cesium.Plane[] | undefined): Cesium.Plane[] {
  if (!planes) return [];
  if (planes.length > MAX_CLIP_PLANES) {
    throw new RangeError(
      `clipPlanes supports at most ${MAX_CLIP_PLANES} planes, got ${planes.length}`,
    );
  }
  return planes.map((plane) => {
    const { normal, distance } = plane;
    if (![normal.x, normal.y, normal.z, distance].every(Number.isFinite)) {
      throw new RangeError('clipPlanes must have a finite normal and distance');
    }
    return Cesium.Plane.clone(plane);
  });
}

/** Validates and stores copies of `boxes` and their inverses on `clip`. */
export function setClipBoxes(clip: ClipState, boxes: Cesium.Matrix4[] | undefined): void {
  boxes ??= [];
  if (boxes.length > MAX_CLIP_BOXES) {
    throw new RangeError(`clipBoxes supports at most ${MAX_CLIP_BOXES} boxes, got ${boxes.length}`);
  }
  clip.inverseBoxes = boxes.map((box) => {
    // A zero-size axis would make every point fall outside (or the inverse
    // blow up); Matrix4.inverse special-cases a zero 3x3 part rather than
    // throwing, so check the determinant here instead.
    const det = Cesium.Matrix3.determinant(Cesium.Matrix4.getMatrix3(box, new Cesium.Matrix3()));
    if (!Cesium.Matrix4.toArray(box).every(Number.isFinite) || det === 0) {
      throw new RangeError('clipBoxes must be finite, invertible matrices');
    }
    return Cesium.Matrix4.inverse(box, new Cesium.Matrix4());
  });
  clip.boxes = boxes.map((box) => Cesium.Matrix4.clone(box));
}

/**
 * Node-local clip uniforms for a node whose points sit at `origin + position`.
 * Writes into the fixed-length uniform arrays and returns the effective mode
 * (`none` when there's nothing to clip against).
 *
 * - plane `n·x + d >= 0` becomes `n·p + (d + n·origin) >= 0`
 * - box `B⁻¹·x` becomes `(B⁻¹·T(origin))·p`
 */
export function writeLocalClipUniforms(
  clip: ClipState,
  origin: Cesium.Cartesian3,
  planesOut: Cesium.Cartesian4[],
  boxesOut: Cesium.Matrix4[],
): { mode: number; planeCount: number; boxCount: number } {
  clip.planes.forEach((plane, i) => {
    const { normal } = plane;
    Cesium.Cartesian4.fromElements(
      normal.x,
      normal.y,
      normal.z,
      plane.distance + Cesium.Cartesian3.dot(normal, origin),
      planesOut[i],
    );
  });
  const toOrigin = Cesium.Matrix4.fromTranslation(origin);
  clip.inverseBoxes.forEach((inverse, i) => {
    Cesium.Matrix4.multiply(inverse, toOrigin, boxesOut[i]!);
  });
  const planeCount = clip.planes.length;
  const boxCount = clip.inverseBoxes.length;
  return { mode: planeCount + boxCount === 0 ? CLIP_MODE.none : clip.mode, planeCount, boxCount };
}

/**
 * Whether the clip discards every point a sphere can hold, so LoD selection
 * can skip the node and its subtree instead of fetching, decoding and
 * budgeting points the shader would drop (#228). Conservative: a sphere that
 * straddles any boundary counts as kept.
 *
 * - `inside`: dropped when the sphere is wholly on the clipped side of some
 *   plane, or wholly outside every box.
 * - `outside`: dropped when the sphere is wholly on the kept side of every
 *   plane and, with boxes set, wholly inside one of them.
 */
export function sphereClippedAway(clip: ClipState, sphere: Cesium.BoundingSphere): boolean {
  const planeCount = clip.planes.length;
  const boxCount = clip.inverseBoxes.length;
  if (planeCount + boxCount === 0 || clip.mode === CLIP_MODE.none) return false;
  const { center, radius } = sphere;

  if (clip.mode === CLIP_MODE.inside) {
    for (const plane of clip.planes) {
      if (signedDistance(plane, center) < -radius * Cesium.Cartesian3.magnitude(plane.normal)) {
        return true;
      }
    }
    return boxCount > 0 && clip.inverseBoxes.every((inverse) => sphereOutsideBox(inverse, sphere));
  }

  for (const plane of clip.planes) {
    if (signedDistance(plane, center) <= radius * Cesium.Cartesian3.magnitude(plane.normal)) {
      return false;
    }
  }
  return boxCount === 0 || clip.inverseBoxes.some((inverse) => sphereInsideBox(inverse, sphere));
}

function signedDistance(plane: Cesium.Plane, point: Cesium.Cartesian3): number {
  return Cesium.Cartesian3.dot(plane.normal, point) + plane.distance;
}

const scratchUnit = new Cesium.Cartesian3();

/**
 * The sphere in a box's unit-cube coordinates: its center, and its half
 * extent along each unit axis (the sphere maps to an ellipsoid there, whose
 * extent along axis i is the radius times the length of row i of the
 * inverse's linear part).
 */
function sphereInUnitCube(
  inverse: Cesium.Matrix4,
  sphere: Cesium.BoundingSphere,
): { q: Cesium.Cartesian3; extent: [number, number, number] } {
  const q = Cesium.Matrix4.multiplyByPoint(inverse, sphere.center, scratchUnit);
  const extent: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    // Matrix4 is column-major: row i of the 3x3 part is at i, i + 4, i + 8.
    extent[i] = sphere.radius * Math.hypot(inverse[i]!, inverse[i + 4]!, inverse[i + 8]!);
  }
  return { q, extent };
}

function sphereOutsideBox(inverse: Cesium.Matrix4, sphere: Cesium.BoundingSphere): boolean {
  const { q, extent } = sphereInUnitCube(inverse, sphere);
  return (
    Math.abs(q.x) - extent[0] > 0.5 ||
    Math.abs(q.y) - extent[1] > 0.5 ||
    Math.abs(q.z) - extent[2] > 0.5
  );
}

function sphereInsideBox(inverse: Cesium.Matrix4, sphere: Cesium.BoundingSphere): boolean {
  const { q, extent } = sphereInUnitCube(inverse, sphere);
  return (
    Math.abs(q.x) + extent[0] <= 0.5 &&
    Math.abs(q.y) + extent[1] <= 0.5 &&
    Math.abs(q.z) + extent[2] <= 0.5
  );
}
