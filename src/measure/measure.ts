/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Distances between picked points (#215). Pure geometry on ECEF positions —
 * no scene, no picking, no drawing — so the numbers can be tested against
 * known coordinates and reused by any UI.
 *
 * What each number means, since "distance" and "height" are each ambiguous
 * on a curved Earth:
 *
 * - `distance` is the straight line between the two ECEF points, in meters.
 *   It is what a tape measure stretched between them would read.
 * - `horizontalDistance` is the geodesic between the two points' footprints
 *   on the ellipsoid surface (height 0), in meters. It does not change with
 *   the points' heights, and for points kilometers apart it is longer than
 *   the chord `distance` would be at the same height.
 * - `heightDifference` is `height(b) − height(a)` above the ellipsoid
 *   (WGS84 unless another is given), in meters. It is not the difference in
 *   ECEF Z: that axis points at the pole, not "up", and away from the poles
 *   the two disagree by a large factor. It is also not a difference in
 *   orthometric (geoid) height; the two differ by however much the geoid
 *   tilts between the points, which is negligible over a site but not across
 *   a region.
 *
 * Offsets that move every point by the same height cancel out of
 * `heightDifference`: the load-time `geoidOffset` exactly, and the live
 * `heightOffset` too if both points were measured in the same state. Pass
 * `PickedPoint.dataPosition` rather than `position` to measure the data
 * itself, independent of the current `heightOffset`.
 */
import * as Cesium from 'cesium';

/** Two-point result. All values in meters. */
export interface SegmentMeasurement {
  /** Straight-line (chord) distance between the two ECEF points. */
  distance: number;
  /** Geodesic distance between the points' footprints on the ellipsoid. */
  horizontalDistance: number;
  /** Ellipsoidal height of the end point minus that of the start point. */
  heightDifference: number;
}

/** Multi-point result. All values in meters. */
export interface PathMeasurement {
  /** Sum of the segments' straight-line distances. */
  length: number;
  /** Sum of the segments' horizontal distances. */
  horizontalLength: number;
  /** Ellipsoidal height of the last point minus that of the first. */
  heightDifference: number;
  /** Sum of the segments' height gains (each segment's positive part). */
  totalAscent: number;
  /** Sum of the segments' height losses, as a positive number. */
  totalDescent: number;
  /** One entry per consecutive pair, in order. */
  segments: SegmentMeasurement[];
}

export interface MeasureOptions {
  /** Ellipsoid heights and geodesics are taken on. Default WGS84. */
  ellipsoid?: Cesium.Ellipsoid;
}

/** Below this, two footprints are the same place: `EllipsoidGeodesic` cannot
 *  build a path between coincident points. 1 mm is far below what a picked
 *  point's Float32 node-relative position resolves anyway. */
const SAME_PLACE_METERS = 1e-3;

function toCartographic(
  position: Cesium.Cartesian3,
  ellipsoid: Cesium.Ellipsoid,
  role: string,
): Cesium.Cartographic {
  if (![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new RangeError(`measure: ${role} is not a finite position`);
  }
  // Undefined only near the Earth's center, where no "height" exists.
  const carto = Cesium.Cartographic.fromCartesian(position, ellipsoid);
  if (!carto)
    throw new RangeError(`measure: ${role} is too close to the ellipsoid center to have a height`);
  return carto;
}

function surfaceDistance(
  a: Cesium.Cartographic,
  b: Cesium.Cartographic,
  ellipsoid: Cesium.Ellipsoid,
): number {
  const aSurface = Cesium.Cartographic.toCartesian(
    new Cesium.Cartographic(a.longitude, a.latitude, 0),
    ellipsoid,
  );
  const bSurface = Cesium.Cartographic.toCartesian(
    new Cesium.Cartographic(b.longitude, b.latitude, 0),
    ellipsoid,
  );
  if (Cesium.Cartesian3.distance(aSurface, bSurface) < SAME_PLACE_METERS) return 0;
  const geodesic = new Cesium.EllipsoidGeodesic(
    new Cesium.Cartographic(a.longitude, a.latitude, 0),
    new Cesium.Cartographic(b.longitude, b.latitude, 0),
    ellipsoid,
  );
  return geodesic.surfaceDistance;
}

function segment(
  a: Cesium.Cartesian3,
  b: Cesium.Cartesian3,
  aCarto: Cesium.Cartographic,
  bCarto: Cesium.Cartographic,
  ellipsoid: Cesium.Ellipsoid,
): SegmentMeasurement {
  return {
    distance: Cesium.Cartesian3.distance(a, b),
    horizontalDistance: surfaceDistance(aCarto, bCarto, ellipsoid),
    heightDifference: bCarto.height - aCarto.height,
  };
}

/** Measures from `a` to `b` (ECEF positions, meters). */
export function measureSegment(
  a: Cesium.Cartesian3,
  b: Cesium.Cartesian3,
  options: MeasureOptions = {},
): SegmentMeasurement {
  const ellipsoid = options.ellipsoid ?? Cesium.Ellipsoid.WGS84;
  return segment(
    a,
    b,
    toCartographic(a, ellipsoid, 'start point'),
    toCartographic(b, ellipsoid, 'end point'),
    ellipsoid,
  );
}

/**
 * Measures a polyline through `points` in order. Fewer than two points give
 * an all-zero result with no segments, so a UI can call this on every click
 * without special-casing the first one.
 */
export function measurePath(
  points: readonly Cesium.Cartesian3[],
  options: MeasureOptions = {},
): PathMeasurement {
  const ellipsoid = options.ellipsoid ?? Cesium.Ellipsoid.WGS84;
  const cartos = points.map((p, i) => toCartographic(p, ellipsoid, `point ${i}`));
  const segments: SegmentMeasurement[] = [];
  for (let i = 1; i < points.length; i++) {
    segments.push(segment(points[i - 1]!, points[i]!, cartos[i - 1]!, cartos[i]!, ellipsoid));
  }
  let length = 0;
  let horizontalLength = 0;
  let totalAscent = 0;
  let totalDescent = 0;
  for (const s of segments) {
    length += s.distance;
    horizontalLength += s.horizontalDistance;
    if (s.heightDifference > 0) totalAscent += s.heightDifference;
    else totalDescent -= s.heightDifference;
  }
  const heightDifference =
    cartos.length >= 2 ? cartos[cartos.length - 1]!.height - cartos[0]!.height : 0;
  return { length, horizontalLength, heightDifference, totalAscent, totalDescent, segments };
}
