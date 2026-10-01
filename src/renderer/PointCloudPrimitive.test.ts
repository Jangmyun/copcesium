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
    DrawCommand: vi.fn(function (opts: { framebuffer?: unknown; uniformMap?: Record<string, () => unknown> }) {
      return {
        modelMatrix: actual.Matrix4.IDENTITY,
        pass: 0,
        renderState: {},
        framebuffer: opts?.framebuffer,
        uniformMap: opts?.uniformMap,
      };
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
  sizeMode: 0,
  attenuationFactor: 100,
  minPixelSize: 1,
  maxPixelSize: 6,
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

describe('PointCloudPrimitive.preparePickCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null before the node has reached the GPU', () => {
    const primitive = new PointCloudPrimitive(renderData, sphere, style);
    expect(primitive.preparePickCommand({}, 1, {})).toBeNull();
  });

  it('returns null while the node is hidden, even after reaching the GPU', () => {
    const primitive = new PointCloudPrimitive(renderData, sphere, style);
    primitive.update(frame());
    primitive.show = false;
    expect(primitive.preparePickCommand({}, 1, {})).toBeNull();
  });

  it('builds a pick command once GPU-initialized and shown, reading the assigned node slot live', () => {
    const primitive = new PointCloudPrimitive(renderData, sphere, style);
    primitive.update(frame());

    const cmd = primitive.preparePickCommand({}, 1, {}) as unknown as {
      uniformMap: { u_nodeSlot(): number };
    };
    expect(cmd).not.toBeNull();
    expect(cmd.uniformMap.u_nodeSlot()).toBe(1);

    // Same call reused, not rebuilt, with the new slot reflected live.
    const vertexArrayCallsBefore = vi.mocked(Cesium.VertexArray).mock.calls.length;
    const cmd2 = primitive.preparePickCommand({}, 2, {});
    expect(cmd2).toBe(cmd);
    expect(cmd.uniformMap.u_nodeSlot()).toBe(2);
    expect(vi.mocked(Cesium.VertexArray).mock.calls.length).toBe(vertexArrayCallsBefore);
  });

  it('points the pick command at the given framebuffer, updated on every call', () => {
    const primitive = new PointCloudPrimitive(renderData, sphere, style);
    primitive.update(frame());

    const fbA = { id: 'a' };
    const fbB = { id: 'b' };
    const cmd = primitive.preparePickCommand({}, 1, fbA) as unknown as { framebuffer: unknown };
    expect(cmd.framebuffer).toBe(fbA);

    primitive.preparePickCommand({}, 1, fbB);
    expect(cmd.framebuffer).toBe(fbB);
  });
});

describe('PointCloudPrimitive.readPointAttributes', () => {
  const PREVIOUS_BUFFER = { previous: true };
  function fakeGpuContext() {
    const gl = {
      ARRAY_BUFFER: 'ARRAY_BUFFER',
      ARRAY_BUFFER_BINDING: 'ARRAY_BUFFER_BINDING',
      getParameter: vi.fn(() => PREVIOUS_BUFFER),
      bindBuffer: vi.fn(),
      getBufferSubData: vi.fn((_target: unknown, _offset: number, dst: ArrayBufferView) => {
        if (dst instanceof Float32Array) {
          dst[0] = 1;
          dst[1] = 2;
          dst[2] = 3;
        } else if (dst instanceof Uint16Array) {
          dst[0] = 500;
        } else if (dst instanceof Uint8Array) {
          dst[0] = 6;
        }
      }),
    };
    return { _gl: gl };
  }

  beforeEach(() => vi.clearAllMocks());

  it('throws for a point index outside the node', () => {
    const primitive = new PointCloudPrimitive(renderData, sphere, style);
    primitive.update(frame());
    expect(() => primitive.readPointAttributes(-1, fakeGpuContext())).toThrow(RangeError);
    expect(() => primitive.readPointAttributes(renderData.pointCount, fakeGpuContext())).toThrow(RangeError);
  });

  it('throws if called before the node has reached the GPU', () => {
    const primitive = new PointCloudPrimitive(renderData, sphere, style);
    expect(() => primitive.readPointAttributes(0, fakeGpuContext())).toThrow();
  });

  it('reads position (origin + node-relative offset), classification, and intensity off the GPU buffers', () => {
    const primitive = new PointCloudPrimitive(renderData, sphere, style);
    primitive.update(frame());

    const attrs = primitive.readPointAttributes(0, fakeGpuContext());

    // origin [6378137, 0, 0] + the fake offset [1, 2, 3] read back above, with heightOffset 0.
    expect(attrs.position.x).toBeCloseTo(6378138);
    expect(attrs.position.y).toBeCloseTo(2);
    expect(attrs.position.z).toBeCloseTo(3);
    expect(attrs.classification).toBe(6);
    expect(attrs.intensity).toBe(500);
  });

  it('restores the ARRAY_BUFFER binding it found, so Cesium\'s cached GL state stays accurate', () => {
    const primitive = new PointCloudPrimitive(renderData, sphere, style);
    primitive.update(frame());
    const context = fakeGpuContext();

    primitive.readPointAttributes(0, context);

    expect(context._gl.bindBuffer).toHaveBeenLastCalledWith('ARRAY_BUFFER', PREVIOUS_BUFFER);
  });
});
