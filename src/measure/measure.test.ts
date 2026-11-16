/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import { measurePath, measureSegment } from './measure';

const WGS84_A = 6378137;
const at = (lonDeg: number, latDeg: number, height: number) =>
  Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, height);

/** Moves a point `meters` along its geocentric radial, the way `heightOffset`
 *  moves a node along the direction of its origin. */
function shiftRadially(p: Cesium.Cartesian3, meters: number): Cesium.Cartesian3 {
  const up = Cesium.Cartesian3.normalize(p, new Cesium.Cartesian3());
  return Cesium.Cartesian3.add(
    p,
    Cesium.Cartesian3.multiplyByScalar(up, meters, up),
    new Cesium.Cartesian3(),
  );
}

describe('measureSegment', () => {
  it('is all zero for the same point', () => {
    const p = at(-123.07, 44.05, 120);
    expect(measureSegment(p, p)).toEqual({
      distance: 0,
      horizontalDistance: 0,
      heightDifference: 0,
    });
  });

  it('reads a vertical pair as pure height', () => {
    const m = measureSegment(at(10, 45, 100), at(10, 45, 150));
    expect(m.distance).toBeCloseTo(50, 6);
    expect(m.horizontalDistance).toBe(0);
    expect(m.heightDifference).toBeCloseTo(50, 6);
  });

  it('signs the height difference from start to end', () => {
    expect(measureSegment(at(10, 45, 150), at(10, 45, 100)).heightDifference).toBeCloseTo(-50, 6);
  });

  it('measures horizontal distance along the ellipsoid, and the straight line as the shorter chord', () => {
    // 0.01° of longitude on the equator: an arc of a × Δλ on the equatorial circle.
    const dLambda = Cesium.Math.toRadians(0.01);
    const m = measureSegment(at(0, 0, 0), at(0.01, 0, 0));
    expect(m.horizontalDistance).toBeCloseTo(WGS84_A * dLambda, 3);
    expect(m.distance).toBeCloseTo(2 * WGS84_A * Math.sin(dLambda / 2), 3);
    expect(m.distance).toBeLessThan(m.horizontalDistance);
    expect(m.heightDifference).toBeCloseTo(0, 6);
  });

  it("keeps horizontal distance at the footprints, whatever the points' heights", () => {
    const low = measureSegment(at(0, 0, 0), at(0.01, 0, 0));
    const high = measureSegment(at(0, 0, 2000), at(0.01, 0, 2000));
    expect(high.horizontalDistance).toBeCloseTo(low.horizontalDistance, 6);
    // The chord itself does grow with height (radius a + h instead of a).
    expect(high.distance).toBeGreaterThan(low.distance);
  });

  describe('height is ellipsoidal height, not an ECEF axis', () => {
    it('differs from the ECEF Z difference at mid latitude', () => {
      const a = at(10, 45, 100);
      const b = at(10, 45, 200);
      const m = measureSegment(a, b);
      expect(m.heightDifference).toBeCloseTo(100, 6);
      // Z only sees the polar component of "up": about sin(45°) of it.
      expect(b.z - a.z).toBeCloseTo(100 * Math.sin(Cesium.Math.toRadians(45)), 0);
      expect(Math.abs(b.z - a.z - m.heightDifference)).toBeGreaterThan(25);
    });

    it('is not the ECEF Z difference on the equator either, where Z does not change at all', () => {
      const a = at(30, 0, 0);
      const b = at(30, 0, 50);
      expect(b.z - a.z).toBeCloseTo(0, 6);
      expect(measureSegment(a, b).heightDifference).toBeCloseTo(50, 6);
    });

    it('agrees with Z only at the pole', () => {
      const a = at(0, 90, 0);
      const b = at(0, 90, 50);
      expect(measureSegment(a, b).heightDifference).toBeCloseTo(b.z - a.z, 6);
    });
  });

  describe('offsets applied to every point', () => {
    it('drops a geoid offset out of the height difference exactly', () => {
      // `geoidOffset` adds the same meters to every point's ellipsoidal height
      // at load time.
      const geoidOffset = -23.4;
      const plain = measureSegment(at(-123.07, 44.05, 120), at(-123.06, 44.06, 180));
      const shifted = measureSegment(
        at(-123.07, 44.05, 120 + geoidOffset),
        at(-123.06, 44.06, 180 + geoidOffset),
      );
      expect(shifted.heightDifference).toBeCloseTo(plain.heightDifference, 6);
      expect(shifted.horizontalDistance).toBeCloseTo(plain.horizontalDistance, 6);
      // The straight line scales with the radius ratio: for a 1.4 km pair
      // lowered 23.4 m, about 1.4 km × 23.4 / 6.37e6 ≈ 5 mm shorter.
      const expected = plain.horizontalDistance * (geoidOffset / WGS84_A);
      expect(shifted.distance - plain.distance).toBeCloseTo(expected, 3);
    });

    it('drops a heightOffset (a radial shift of the whole cloud) out of the height difference', () => {
      const a = at(-123.07, 44.05, 120);
      const b = at(-123.06, 44.06, 180);
      const plain = measureSegment(a, b);
      const lifted = measureSegment(shiftRadially(a, 300), shiftRadially(b, 300));
      // A radial shift is not quite along the ellipsoid normal (they differ by
      // up to 0.19°), so the cancellation is to micrometers, not exact.
      expect(lifted.heightDifference).toBeCloseTo(plain.heightDifference, 4);
      expect(lifted.horizontalDistance).toBeCloseTo(plain.horizontalDistance, 2);
    });
  });

  it('takes another ellipsoid', () => {
    const sphere = new Cesium.Ellipsoid(1000, 1000, 1000);
    const a = Cesium.Cartesian3.fromDegrees(0, 0, 0, sphere);
    const b = Cesium.Cartesian3.fromDegrees(90, 0, 10, sphere);
    const m = measureSegment(a, b, { ellipsoid: sphere });
    expect(m.horizontalDistance).toBeCloseTo((Math.PI / 2) * 1000, 6);
    expect(m.heightDifference).toBeCloseTo(10, 6);
  });

  it('rejects a non-finite position', () => {
    expect(() => measureSegment(new Cesium.Cartesian3(NaN, 0, 0), at(0, 0, 0))).toThrow(
      /start point.*finite/,
    );
    expect(() => measureSegment(at(0, 0, 0), new Cesium.Cartesian3(0, Infinity, 0))).toThrow(
      /end point.*finite/,
    );
  });

  it('rejects a position at the ellipsoid center, which has no height', () => {
    expect(() => measureSegment(Cesium.Cartesian3.ZERO, at(0, 0, 0))).toThrow(/center/);
  });
});

describe('measurePath', () => {
  it('is all zero for fewer than two points', () => {
    const empty = {
      length: 0,
      horizontalLength: 0,
      heightDifference: 0,
      totalAscent: 0,
      totalDescent: 0,
      segments: [],
    };
    expect(measurePath([])).toEqual(empty);
    expect(measurePath([at(10, 45, 100)])).toEqual(empty);
  });

  it('matches measureSegment for two points', () => {
    const a = at(-123.07, 44.05, 120);
    const b = at(-123.06, 44.06, 180);
    const path = measurePath([a, b]);
    const seg = measureSegment(a, b);
    expect(path.segments).toEqual([seg]);
    expect(path.length).toBe(seg.distance);
    expect(path.horizontalLength).toBe(seg.horizontalDistance);
    expect(path.heightDifference).toBe(seg.heightDifference);
  });

  it('sums segments, and splits climbing from descending', () => {
    const p = [at(10, 45, 100), at(10, 45, 160), at(10, 45, 130), at(10.001, 45, 130)];
    const m = measurePath(p);
    expect(m.segments).toHaveLength(3);
    expect(m.length).toBeCloseTo(60 + 30 + m.segments[2]!.distance, 6);
    expect(m.horizontalLength).toBeCloseTo(m.segments[2]!.horizontalDistance, 6);
    expect(m.heightDifference).toBeCloseTo(30, 6);
    expect(m.totalAscent).toBeCloseTo(60, 6);
    expect(m.totalDescent).toBeCloseTo(30, 6);
    expect(m.totalAscent - m.totalDescent).toBeCloseTo(m.heightDifference, 6);
  });

  it('names the offending point when one is invalid', () => {
    expect(() => measurePath([at(0, 0, 0), at(1, 0, 0), new Cesium.Cartesian3(NaN, 0, 0)])).toThrow(
      /point 2/,
    );
  });
});
