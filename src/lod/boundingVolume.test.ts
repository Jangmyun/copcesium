import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import {
  getCullingVolume,
  getExpandedCullingVolume,
  getNodeBoundingSphere,
  isInFrustum,
  type ProjectToCartesian,
} from './boundingVolume';

// Identity projection that passes coordinates straight through to Cartesian3 (verifies pure math, no CRS involved)
const identityProject: ProjectToCartesian = (x, y, z) => new Cesium.Cartesian3(x, y, z);

describe('getNodeBoundingSphere', () => {
  it('root node (0-0-0-0) has the same center as rootCenter and radius rootHalfSize*sqrt(3)', () => {
    const rootCenter = { x: 100, y: 200, z: 50 };
    const rootHalfSize = 10;

    const sphere = getNodeBoundingSphere('0-0-0-0', rootCenter, rootHalfSize, identityProject);

    expect(sphere.center.x).toBeCloseTo(100);
    expect(sphere.center.y).toBeCloseTo(200);
    expect(sphere.center.z).toBeCloseTo(50);
    expect(sphere.radius).toBeCloseTo(10 * Math.sqrt(3));
  });

  it('a child node has half the half-size and is offset to its octree octant position', () => {
    const rootCenter = { x: 0, y: 0, z: 0 };
    const rootHalfSize = 10;

    // level 1, x=1,y=0,z=0 → +x direction octant
    const sphere = getNodeBoundingSphere('1-1-0-0', rootCenter, rootHalfSize, identityProject);

    expect(sphere.center.x).toBeCloseTo(5);
    expect(sphere.center.y).toBeCloseTo(-5);
    expect(sphere.center.z).toBeCloseTo(-5);
    expect(sphere.radius).toBeCloseTo(5 * Math.sqrt(3));
  });

  it('xyFactor can convert the radius unit', () => {
    const sphere = getNodeBoundingSphere(
      '0-0-0-0',
      { x: 0, y: 0, z: 0 },
      10,
      identityProject,
      0.3048,
    );

    expect(sphere.radius).toBeCloseTo(10 * 0.3048 * Math.sqrt(3));
  });
});

describe('isInFrustum', () => {
  // 6-plane CullingVolume mimicking an axis-aligned box ([-10,10]^3), without a camera
  const boxCullingVolume = new Cesium.CullingVolume([
    new Cesium.Cartesian4(-1, 0, 0, 10), // x <= 10
    new Cesium.Cartesian4(1, 0, 0, 10), // x >= -10
    new Cesium.Cartesian4(0, -1, 0, 10), // y <= 10
    new Cesium.Cartesian4(0, 1, 0, 10), // y >= -10
    new Cesium.Cartesian4(0, 0, -1, 10), // z <= 10
    new Cesium.Cartesian4(0, 0, 1, 10), // z >= -10
  ]);

  it('a sphere inside the box returns true', () => {
    const sphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(0, 0, 0), 1);

    expect(isInFrustum(sphere, boxCullingVolume)).toBe(true);
  });

  it('a sphere outside the box returns false', () => {
    const sphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(20, 0, 0), 1);

    expect(isInFrustum(sphere, boxCullingVolume)).toBe(false);
  });
});

describe('getCullingVolume', () => {
  // Node spheres live in ECEF, where the ellipsoid radius is ~6.378e6. A camera
  // under `lookAt()` reads `position`/`direction`/`up` in a small local offset
  // (tens to hundreds of units) from the target's east-north-up frame — the two
  // are separated by six orders of magnitude, which is what makes reading the
  // local vectors as if they were world ones result in "everything culled"
  // rather than a small pointing error. `boxCullingVolume` above (a synthetic
  // [-10,10]^3 box) can't exercise that gap; this camera is built the same way
  // `Camera.lookAt()` builds a real one, at real scale.
  const target = Cesium.Cartesian3.fromDegrees(0, 0, 0);
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame(target);

  // What `camera.position/direction/up` read as under a lookAt: a short offset
  // and orientation in the target's local ENU frame.
  const localPosition = new Cesium.Cartesian3(0, -500, 300);
  const localDirection = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(localPosition, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const localUp = new Cesium.Cartesian3(0, 0, 1);

  // The `WC` variants are what `Camera.js` actually computes: `transform` applied
  // to the local vectors (translation for position, rotation-only for direction/up).
  const worldPosition = Cesium.Matrix4.multiplyByPoint(transform, localPosition, new Cesium.Cartesian3());
  const worldDirection = Cesium.Cartesian3.normalize(
    Cesium.Matrix4.multiplyByPointAsVector(transform, localDirection, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const worldUp = Cesium.Cartesian3.normalize(
    Cesium.Matrix4.multiplyByPointAsVector(transform, localUp, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );

  function cameraUnderLookAt(): Cesium.Camera {
    return {
      position: localPosition,
      direction: localDirection,
      up: localUp,
      positionWC: worldPosition,
      directionWC: worldDirection,
      upWC: worldUp,
      frustum: new Cesium.PerspectiveFrustum({
        fov: Cesium.Math.toRadians(60),
        aspectRatio: 1,
        near: 1,
        far: 1e9,
      }),
    } as unknown as Cesium.Camera;
  }

  it('builds the volume from world coordinates, so a camera under lookAt() still sees a node near the target', () => {
    // Regression: reading `position`/`direction`/`up` (local to the target's ENU
    // frame, magnitude in the hundreds) put the culling volume near the world
    // origin instead of near the target on the ellipsoid (magnitude ~6.378e6),
    // pointed the wrong way besides — every ECEF node fell outside it, and the
    // whole point cloud blanked for as long as a lookAt transform was active.
    const volume = getCullingVolume(cameraUnderLookAt());
    const nodeNearTarget = new Cesium.BoundingSphere(target, 50);

    expect(isInFrustum(nodeNearTarget, volume)).toBe(true);
  });

  it('still culls a node genuinely outside the frustum', () => {
    const volume = getCullingVolume(cameraUnderLookAt());
    // On the opposite side of the ellipsoid from the target, well behind the camera.
    const antipodalNode = new Cesium.BoundingSphere(
      Cesium.Cartesian3.negate(target, new Cesium.Cartesian3()),
      50,
    );

    expect(isInFrustum(antipodalNode, volume)).toBe(false);
  });
});

describe('getExpandedCullingVolume', () => {
  // Looking down -z from the origin; fovy=60°, aspect=1, so at distance d the
  // near-plane half-height/half-width is d*tan(30°).
  function makeCamera(fovyDegrees = 60, aspectRatio = 1): Cesium.Camera {
    const position = new Cesium.Cartesian3(0, 0, 0);
    const direction = new Cesium.Cartesian3(0, 0, -1);
    const up = new Cesium.Cartesian3(0, 1, 0);
    return {
      position,
      direction,
      up,
      positionWC: position,
      directionWC: direction,
      upWC: up,
      frustum: new Cesium.PerspectiveFrustum({
        fov: Cesium.Math.toRadians(fovyDegrees),
        aspectRatio,
        near: 1,
        far: 1e9,
      }),
    } as unknown as Cesium.Camera;
  }

  it('a factor of 1 leaves the volume equivalent to the unexpanded frustum', () => {
    const camera = makeCamera();
    const distance = 100;
    const halfWidth = distance * Math.tan(Cesium.Math.toRadians(30));
    // Just inside the actual frustum at this distance.
    const sphere = new Cesium.BoundingSphere(
      new Cesium.Cartesian3(halfWidth * 0.99, 0, -distance),
      0.1,
    );

    expect(isInFrustum(sphere, getExpandedCullingVolume(camera, 1))).toBe(
      isInFrustum(sphere, getCullingVolume(camera)),
    );
  });

  it('widens the near-plane width/height by exactly the given factor, regardless of aspect ratio', () => {
    const distance = 100;
    const factor = 1.8;

    for (const aspectRatio of [1, 2, 0.5]) {
      const camera = makeCamera(60, aspectRatio);
      const volume = getExpandedCullingVolume(camera, factor);
      // `fov` only equals `fovy` when aspectRatio <= 1 — for a wide (>1)
      // aspect ratio, Cesium treats `fov` as the horizontal angle instead and
      // derives `fovy` from it. Reading `fovy` back (rather than assuming
      // it equals the `fov` passed to `makeCamera`) keeps this correct
      // regardless of which case applies, matching how PerspectiveFrustum
      // itself computes `top`/`right` internally.
      const fovy = (camera.frustum as Cesium.PerspectiveFrustum).fovy!;
      const halfHeight = distance * Math.tan(fovy / 2);
      const halfWidth = aspectRatio * halfHeight;

      // A sphere just inside factor*halfWidth is retained...
      const justInside = new Cesium.BoundingSphere(
        new Cesium.Cartesian3(halfWidth * factor * 0.99, 0, -distance),
        0.1,
      );
      expect(isInFrustum(justInside, volume)).toBe(true);

      // ...while one just outside it is culled, on every aspect ratio.
      const justOutside = new Cesium.BoundingSphere(
        new Cesium.Cartesian3(halfWidth * factor * 1.01, 0, -distance),
        0.1,
      );
      expect(isInFrustum(justOutside, volume)).toBe(false);
    }
  });

  it('a node outside the actual frustum but inside the expanded one is only caught by the expanded volume', () => {
    const camera = makeCamera();
    const distance = 100;
    const halfWidth = distance * Math.tan(Cesium.Math.toRadians(30));
    // 1.5x the actual half-width: outside the plain frustum, inside a 1.8x-expanded one.
    const sphere = new Cesium.BoundingSphere(
      new Cesium.Cartesian3(halfWidth * 1.5, 0, -distance),
      0.1,
    );

    expect(isInFrustum(sphere, getCullingVolume(camera))).toBe(false);
    expect(isInFrustum(sphere, getExpandedCullingVolume(camera, 1.8))).toBe(true);
  });

  it('scales an off-center perspective frustum directly by the factor', () => {
    const offCenter = new Cesium.PerspectiveOffCenterFrustum({
      left: -10,
      right: 10,
      top: 10,
      bottom: -10,
      near: 1,
      far: 1e9,
    });
    const position = new Cesium.Cartesian3(0, 0, 0);
    const direction = new Cesium.Cartesian3(0, 0, -1);
    const up = new Cesium.Cartesian3(0, 1, 0);
    const camera = {
      position,
      direction,
      up,
      positionWC: position,
      directionWC: direction,
      upWC: up,
      frustum: offCenter,
    } as unknown as Cesium.Camera;

    // Off-center frustum side planes emanate from the eye through the
    // near-plane edges, so `right` only bounds the frustum's width exactly
    // at `near`; at any other depth `d` the half-width scales to
    // `right * (d / near)`. Testing well past `near` (rather than exactly at
    // it) avoids the near plane's own cutoff being what culls the sphere,
    // since `near`'s own test would otherwise dominate the classification of
    // a sphere whose radius straddles that plane.
    const distance = 100;
    const scaledRight = 10 * 1.8 * (distance / 1); // right=10, factor=1.8, near=1
    const justInside = new Cesium.BoundingSphere(
      new Cesium.Cartesian3(scaledRight * 0.9, 0, -distance),
      0.1,
    );
    const justOutside = new Cesium.BoundingSphere(
      new Cesium.Cartesian3(scaledRight * 1.1, 0, -distance),
      0.1,
    );
    const volume = getExpandedCullingVolume(camera, 1.8);

    expect(isInFrustum(justInside, volume)).toBe(true);
    expect(isInFrustum(justOutside, volume)).toBe(false);
  });

  it('scales an orthographic frustum by widening its width', () => {
    const orthographic = new Cesium.OrthographicFrustum({
      width: 20,
      aspectRatio: 1,
      near: 1,
      far: 1e9,
    });
    const position = new Cesium.Cartesian3(0, 0, 0);
    const direction = new Cesium.Cartesian3(0, 0, -1);
    const up = new Cesium.Cartesian3(0, 1, 0);
    const camera = {
      position,
      direction,
      up,
      positionWC: position,
      directionWC: direction,
      upWC: up,
      frustum: orthographic,
    } as unknown as Cesium.Camera;

    // Orthographic half-width is constant with distance: width/2 = 10, times factor 1.8 = 18.
    const justInside = new Cesium.BoundingSphere(new Cesium.Cartesian3(17, 0, -100), 0.1);
    const justOutside = new Cesium.BoundingSphere(new Cesium.Cartesian3(19, 0, -100), 0.1);
    const volume = getExpandedCullingVolume(camera, 1.8);

    expect(isInFrustum(justInside, volume)).toBe(true);
    expect(isInFrustum(justOutside, volume)).toBe(false);
  });
});
