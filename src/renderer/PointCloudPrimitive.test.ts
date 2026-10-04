import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';
import type { NodeRenderData } from '../types';

// `_initGpu()` reaches for Cesium's renderer internals (Buffer, VertexArray,
// ShaderProgram, DrawCommand), all of which need a live WebGL context. Stub
// exactly those, leaving the rest of the module real — the point here is when
// the GPU work is timed, not what it produces.
const vertexArray = vi.fn();
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cesium')>();
  return {
    ...actual,
    Buffer: { createVertexBuffer: vi.fn(() => ({})) },
    BufferUsage: { STATIC_DRAW: 0 },
    // Regular functions, not arrows: both are called with `new`, and an
    // arrow function is not a constructor.
    VertexArray: vi.fn(function () {
      vertexArray();
      return { destroy: vi.fn() };
    }),
    ShaderProgram: { fromCache: vi.fn(() => ({ destroy: vi.fn() })) },
    DrawCommand: vi.fn(function () {
      return { modelMatrix: actual.Matrix4.IDENTITY, pass: 0, renderState: {} };
    }),
    RenderState: { fromCache: vi.fn(() => ({})) },
    Pass: { OPAQUE: 0, TRANSLUCENT: 1 },
    BlendingState: { ALPHA_BLEND: {} },
  };
});

const { PointCloudPrimitive } = await import('./PointCloudPrimitive');
const { createClipState } = await import('./clipping');

const renderData: NodeRenderData = {
  positions: new Float32Array([0, 0, 0]),
  origin: [6378137, 0, 0],
  colors: new Uint8Array([255, 0, 0, 255]),
  intensities: new Uint16Array([1000]),
  classifications: new Uint8Array([2]),
  elevations: new Uint16Array([32768]),
  pointCount: 1,
  maxIntensity: 1000,
};

const style = {
  pixelSize: 2,
  sizeMode: 0,
  attenuationFactor: 100,
  minPixelSize: 1,
  maxPixelSize: 6,
  colorMode: 0,
  intensityRange: new Cesium.Cartesian2(0, 65535),
  classMask: [new Cesium.Cartesian4(-1, -1, -1, -1), new Cesium.Cartesian4(-1, -1, -1, -1)],
  opacity: 1,
  heightOffset: 0,
  clip: createClipState(undefined, undefined, 'inside'),
};

const sphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(6378137, 0, 0), 10);
const frame = () => ({ context: {}, commandList: [] as unknown[] });

describe('PointCloudPrimitive GPU-init timing', () => {
  beforeEach(() => vi.clearAllMocks());

  // The whole point of #194: wrapping the constructor timed an allocation and
  // reported 0 ms, because the buffers do not exist until a frame draws it.
  it('does not report an upload before the first frame', () => {
    const onGpuInit = vi.fn();
    new PointCloudPrimitive(renderData, sphere, style, onGpuInit);

    expect(onGpuInit).not.toHaveBeenCalled();
  });

  it('reports one upload on the first frame and none after', () => {
    const onGpuInit = vi.fn();
    const primitive = new PointCloudPrimitive(renderData, sphere, style, onGpuInit);

    primitive.update(frame());
    expect(onGpuInit).toHaveBeenCalledTimes(1);
    const [startedAt, endedAt] = onGpuInit.mock.calls[0] as [number, number];
    expect(endedAt).toBeGreaterThanOrEqual(startedAt);

    primitive.update(frame());
    primitive.update(frame());
    expect(onGpuInit).toHaveBeenCalledTimes(1);
  });

  // A failed init means nothing reached the GPU; counting it would fold an
  // error path's duration into the upload percentiles.
  it('reports nothing when the GPU init fails', () => {
    vi.mocked(Cesium.VertexArray as unknown as () => void).mockImplementationOnce(() => {
      throw new Error('context lost');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onGpuInit = vi.fn();
    const primitive = new PointCloudPrimitive(renderData, sphere, style, onGpuInit);

    primitive.update(frame());

    expect(onGpuInit).not.toHaveBeenCalled();
  });
});

describe('PointCloudPrimitive clipping uniforms', () => {
  beforeEach(() => vi.clearAllMocks());

  /** The uniformMap handed to the (mocked) DrawCommand constructor. */
  function uniforms(): Record<string, () => unknown> {
    const opts = vi.mocked(
      Cesium.DrawCommand as unknown as (o: { uniformMap: Record<string, () => unknown> }) => void,
    ).mock.calls[0]![0];
    return opts.uniformMap;
  }

  it('re-expresses the clip relative to the node origin, and rebuilds it on change', () => {
    const clipStyle = { ...style, clip: createClipState(undefined, undefined, 'inside') };
    // The DrawCommand mock's model matrix is the identity, so the node origin is (0, 0, 0).
    const primitive = new PointCloudPrimitive(renderData, sphere, clipStyle);
    primitive.update(frame());
    expect(uniforms().u_clipMode!()).toBe(0); // nothing to clip against

    clipStyle.clip.planes = [new Cesium.Plane(Cesium.Cartesian3.UNIT_X, -10)];
    clipStyle.clip.version++;
    primitive.update(frame());
    expect(uniforms().u_clipMode!()).toBe(1);
    expect(uniforms().u_clipPlaneCount!()).toBe(1);
    expect((uniforms().u_clipPlanes!() as Cesium.Cartesian4[])[0]).toEqual(
      new Cesium.Cartesian4(1, 0, 0, -10),
    );
  });

  it('rebuilds the clip uniforms when heightOffset moves the node origin', () => {
    const clipStyle = {
      ...style,
      clip: createClipState([new Cesium.Plane(Cesium.Cartesian3.UNIT_X, -10)], undefined, 'inside'),
    };
    const primitive = new PointCloudPrimitive(renderData, sphere, clipStyle);
    primitive.update(frame());
    const before = (uniforms().u_clipPlanes!() as Cesium.Cartesian4[])[0]!.w;

    clipStyle.heightOffset = 50;
    primitive.update(frame());

    // The mocked DrawCommand started at an identity model matrix (origin 0);
    // heightOffset rebuilt it as the real node origin (6378137, 0, 0) shifted
    // 50 m along its "up" (+X), and the plane's node-local w followed.
    expect((uniforms().u_clipPlanes!() as Cesium.Cartesian4[])[0]!.w).toBeCloseTo(
      before + 6378137 + 50,
    );
  });
});
