import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import { getCullingVolume, getNodeBoundingSphere, isInFrustum, type ProjectToCartesian } from './boundingVolume';

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
