import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import {
  CLIP_MODE,
  MAX_CLIP_BOXES,
  MAX_CLIP_PLANES,
  createClipState,
  setClipBoxes,
  writeLocalClipUniforms,
  type ClipState,
} from './clipping';

/**
 * JS mirror of `clipKeeps()` in shaders.ts, run over the node-local uniforms
 * exactly as the GPU would — but in Float32 for the uniforms and the
 * node-local position, so it also checks the precision the GPU actually gets.
 */
function keeps(clip: ClipState, origin: Cesium.Cartesian3, world: Cesium.Cartesian3): boolean {
  const planes = Array.from({ length: MAX_CLIP_PLANES }, () => new Cesium.Cartesian4());
  const boxes = Array.from({ length: MAX_CLIP_BOXES }, () => new Cesium.Matrix4());
  const { mode, planeCount, boxCount } = writeLocalClipUniforms(clip, origin, planes, boxes);
  if (mode === CLIP_MODE.none) return true;
  const f = Math.fround;
  const p = [f(world.x - origin.x), f(world.y - origin.y), f(world.z - origin.z)];

  let inside = true;
  for (let i = 0; i < planeCount; i++) {
    const pl = planes[i]!;
    if (f(pl.x) * p[0]! + f(pl.y) * p[1]! + f(pl.z) * p[2]! + f(pl.w) < 0) inside = false;
  }
  if (inside && boxCount > 0) {
    inside = boxes.slice(0, boxCount).some((m) => {
      const a = Cesium.Matrix4.toArray(m).map(f); // column-major
      return [0, 1, 2].every((r) => {
        const q = a[r]! * p[0]! + a[4 + r]! * p[1]! + a[8 + r]! * p[2]! + a[12 + r]!;
        return Math.abs(q) <= 0.5;
      });
    });
  }
  return mode === CLIP_MODE.inside ? inside : !inside;
}

// A spot on the ground near Eugene, OR — ECEF magnitudes, where Float32
// alone would only resolve ~0.5 m.
const center = Cesium.Cartesian3.fromDegrees(-123.07, 44.05, 120);
const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
/** World point `e`/`n`/`u` meters east/north/up of `center`. */
const at = (e: number, n: number, u: number) =>
  Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(e, n, u), new Cesium.Cartesian3());
// Node origin a few hundred meters away, as a real node's would be.
const origin = at(-300, 200, -40);

describe('clip planes', () => {
  // Keeps everything east of center (the side the normal points to).
  const eastward = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    Cesium.Cartesian3.UNIT_X,
    new Cesium.Cartesian3(),
  );
  const plane = Cesium.Plane.fromPointNormal(center, eastward);

  it('keeps the side the normal points to', () => {
    const clip = createClipState([plane], undefined, 'inside');
    expect(keeps(clip, origin, at(5, 0, 0))).toBe(true);
    expect(keeps(clip, origin, at(0.01, 30, 10))).toBe(true); // along the plane, just on the kept side
    expect(keeps(clip, origin, at(-5, 0, 0))).toBe(false);
  });

  it('resolves the boundary to centimeters at ECEF scale', () => {
    const clip = createClipState([plane], undefined, 'inside');
    expect(keeps(clip, origin, at(0.02, 0, 0))).toBe(true);
    expect(keeps(clip, origin, at(-0.02, 0, 0))).toBe(false);
  });

  it("'outside' keeps the complement", () => {
    const clip = createClipState([plane], undefined, 'outside');
    expect(keeps(clip, origin, at(5, 0, 0))).toBe(false);
    expect(keeps(clip, origin, at(-5, 0, 0))).toBe(true);
  });

  it('requires the kept side of every plane', () => {
    const northward = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      Cesium.Cartesian3.UNIT_Y,
      new Cesium.Cartesian3(),
    );
    const clip = createClipState(
      [plane, Cesium.Plane.fromPointNormal(center, northward)],
      undefined,
      'inside',
    );
    expect(keeps(clip, origin, at(5, 5, 0))).toBe(true);
    expect(keeps(clip, origin, at(5, -5, 0))).toBe(false);
  });
});

describe('clip boxes', () => {
  // 10 m east-west, 20 m north-south, 30 m tall, centered on `center`.
  const box = Cesium.Matrix4.multiplyByScale(
    enu,
    new Cesium.Cartesian3(10, 20, 30),
    new Cesium.Matrix4(),
  );

  it('keeps points inside, boundary included', () => {
    const clip = createClipState(undefined, [box], 'inside');
    expect(keeps(clip, origin, center)).toBe(true);
    expect(keeps(clip, origin, at(4.98, -9.98, 14.98))).toBe(true); // just inside the corner
    expect(keeps(clip, origin, at(5.03, 0, 0))).toBe(false);
    expect(keeps(clip, origin, at(0, 10.03, 0))).toBe(false);
    expect(keeps(clip, origin, at(0, 0, -15.03))).toBe(false);
  });

  it('keeps points inside any of several boxes', () => {
    const other = Cesium.Matrix4.multiplyByScale(
      Cesium.Transforms.eastNorthUpToFixedFrame(at(100, 0, 0)),
      new Cesium.Cartesian3(4, 4, 4),
      new Cesium.Matrix4(),
    );
    const clip = createClipState(undefined, [box, other], 'inside');
    expect(keeps(clip, origin, at(101, 1, 1))).toBe(true);
    expect(keeps(clip, origin, at(50, 0, 0))).toBe(false);
  });

  it("'outside' cuts a hole", () => {
    const clip = createClipState(undefined, [box], 'outside');
    expect(keeps(clip, origin, center)).toBe(false);
    expect(keeps(clip, origin, at(50, 0, 0))).toBe(true);
  });

  it('combines with planes: inside every plane and some box', () => {
    const eastward = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      Cesium.Cartesian3.UNIT_X,
      new Cesium.Cartesian3(),
    );
    const clip = createClipState([Cesium.Plane.fromPointNormal(center, eastward)], [box], 'inside');
    expect(keeps(clip, origin, at(2, 0, 0))).toBe(true);
    expect(keeps(clip, origin, at(-2, 0, 0))).toBe(false); // in the box, wrong side of the plane
    expect(keeps(clip, origin, at(20, 0, 0))).toBe(false); // right side, outside the box
  });

  // heightOffset moves the node origin; the clip is world-space, so the same
  // drawn position must get the same answer whatever origin it's relative to.
  it('gives the same result for a world point whatever the node origin', () => {
    const clip = createClipState(undefined, [box], 'inside');
    for (const o of [origin, at(0, 0, -200), at(800, -800, 50)]) {
      expect(keeps(clip, o, at(4.9, 0, 0))).toBe(true);
      expect(keeps(clip, o, at(5.1, 0, 0))).toBe(false);
    }
  });
});

describe('clip state', () => {
  it('draws everything when no region is set, in either mode', () => {
    for (const mode of ['inside', 'outside'] as const) {
      const clip = createClipState(undefined, [], mode);
      const out = writeLocalClipUniforms(clip, origin, [], []);
      expect(out.mode).toBe(CLIP_MODE.none);
    }
  });

  it('rejects too many planes or boxes', () => {
    const plane = new Cesium.Plane(Cesium.Cartesian3.UNIT_Z, 0);
    expect(() =>
      createClipState(Array(MAX_CLIP_PLANES + 1).fill(plane), undefined, 'inside'),
    ).toThrow(RangeError);
    expect(() =>
      createClipState(undefined, Array(MAX_CLIP_BOXES + 1).fill(Cesium.Matrix4.IDENTITY), 'inside'),
    ).toThrow(RangeError);
  });

  it('rejects a non-finite plane', () => {
    const bad = new Cesium.Plane(Cesium.Cartesian3.UNIT_Z, 0);
    bad.distance = NaN;
    expect(() => createClipState([bad], undefined, 'inside')).toThrow(RangeError);
  });

  it('rejects a box with a zero-length axis or non-finite entries', () => {
    const flat = Cesium.Matrix4.fromScale(new Cesium.Cartesian3(1, 1, 0));
    expect(() => createClipState(undefined, [flat], 'inside')).toThrow(RangeError);
    const nan = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
    nan[12] = NaN;
    expect(() => createClipState(undefined, [nan], 'inside')).toThrow(RangeError);
  });

  it("copies the caller's boxes so later mutation has no effect", () => {
    const box = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
    const clip = createClipState(undefined, undefined, 'inside');
    setClipBoxes(clip, [box]);
    box[12] = 1000;
    expect(clip.boxes[0]![12]).toBe(0);
    expect(clip.inverseBoxes[0]![12]).toBeCloseTo(0);
  });
});
