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
  colorMode: 0,
  intensityRange: new Cesium.Cartesian2(0, 65535),
  classMask: [new Cesium.Cartesian4(-1, -1, -1, -1), new Cesium.Cartesian4(-1, -1, -1, -1)],
  opacity: 1,
  heightOffset: 0,
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
