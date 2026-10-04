import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';

// EyeDomeLighting drives Cesium's renderer internals (FramebufferManager,
// ClearCommand, DrawCommand.shallowClone, ...), which need a live WebGL
// context. Stub exactly those; what's under test is which command gets
// submitted when, not the pixels it produces.
const framebufferUpdate = vi.fn();
const framebufferDestroy = vi.fn();
let currentFramebuffer: object = {};
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cesium')>();
  return {
    ...actual,
    FramebufferManager: vi.fn(function () {
      return {
        get framebuffer() {
          return currentFramebuffer;
        },
        update: framebufferUpdate,
        getColorTexture: vi.fn(),
        destroy: framebufferDestroy,
      };
    }),
    ClearCommand: vi.fn(function () {
      return { kind: 'clear', framebuffer: undefined };
    }),
    ShaderSource: Object.assign(
      vi.fn(function () {
        return {};
      }),
      {
        replaceMain: (source: string, name: string) =>
          source.replace(/void\s+main\s*\(\s*\)/g, `void ${name}()`),
      },
    ),
    DrawCommand: {
      shallowClone: vi.fn((command: object, result?: object) =>
        Object.assign(result ?? {}, command),
      ),
    },
    RenderState: { fromCache: vi.fn(() => ({})) },
    BlendingState: { ALPHA_BLEND: {} },
    Pass: { CESIUM_3D_TILE: 5, OPAQUE: 8 },
  };
});

const { EyeDomeLighting } = await import('./EyeDomeLighting');

const derivedProgram = { destroy: vi.fn() };
const compositeProgram = { destroy: vi.fn() };
const pointProgram = {
  vertexShaderSource: {},
  fragmentShaderSource: {
    sources: ['in vec4 v_color;\nvoid main() {\n  out_FragColor = v_color;\n}'],
    clone() {
      return { sources: [...this.sources] };
    },
  },
  _attributeLocations: { position: 0 },
};

function makeContext(supported = true) {
  const derivedPrograms = new Map<unknown, unknown>();
  return {
    drawBuffers: supported,
    fragmentDepth: supported,
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    shaderCache: {
      getDerivedShaderProgram: vi.fn((program: unknown) => derivedPrograms.get(program)),
      createDerivedShaderProgram: vi.fn((program: unknown) => {
        derivedPrograms.set(program, derivedProgram);
        return derivedProgram;
      }),
    },
    createViewportQuadCommand: vi.fn(() => ({
      kind: 'composite',
      shaderProgram: compositeProgram,
    })),
  };
}

function makeFrame(context: ReturnType<typeof makeContext>, frameNumber = 1, render = true) {
  return { context, commandList: [] as unknown[], passes: { render }, frameNumber, pixelRatio: 2 };
}

function makeCommand() {
  return {
    shaderProgram: pointProgram,
    modelMatrix: new Cesium.Matrix4(),
    framebuffer: undefined,
    pass: 8,
  };
}

const sphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(6378137, 0, 0), 100);

describe('EyeDomeLighting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentFramebuffer = {};
  });

  it('passes the command through untouched while disabled', () => {
    const edl = new EyeDomeLighting(sphere, false, 1, 1);
    const frame = makeFrame(makeContext());
    const cmd = makeCommand();

    expect(edl.apply(frame, cmd)).toBe(cmd);
    expect(frame.commandList).toEqual([]);
  });

  it('passes the command through on a pick pass', () => {
    const edl = new EyeDomeLighting(sphere, true, 1, 1);
    const frame = makeFrame(makeContext(), 1, false);
    const cmd = makeCommand();

    expect(edl.apply(frame, cmd)).toBe(cmd);
    expect(frame.commandList).toEqual([]);
  });

  it('falls back to the plain command and warns once without MRT/frag-depth support', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const edl = new EyeDomeLighting(sphere, true, 1, 1);
    const context = makeContext(false);
    const cmd = makeCommand();

    expect(edl.apply(makeFrame(context, 1), cmd)).toBe(cmd);
    expect(edl.apply(makeFrame(context, 2), cmd)).toBe(cmd);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('redirects the command offscreen in a pass that runs before the composite', () => {
    const edl = new EyeDomeLighting(sphere, true, 1, 1);
    const cmd = makeCommand();

    const derived = edl.apply(makeFrame(makeContext()), cmd) as Record<string, unknown>;

    expect(derived).not.toBe(cmd);
    expect(derived.framebuffer).toBe(currentFramebuffer);
    expect(derived.shaderProgram).toBe(derivedProgram);
    expect(derived.pass).toBe(5); // CESIUM_3D_TILE, before OPAQUE's composite
    expect(cmd.pass).toBe(8); // the original is left alone
  });

  it('rewrites the point shader to write packed depth to a second target', () => {
    const edl = new EyeDomeLighting(sphere, true, 1, 1);
    const context = makeContext();
    edl.apply(makeFrame(context), makeCommand());

    const opts = context.shaderCache.createDerivedShaderProgram.mock.calls[0]![2] as {
      fragmentShaderSource: { sources: string[] };
    };
    const fs = opts.fragmentShaderSource.sources.join('\n');
    expect(fs).toContain('layout (location = 1) out vec4 out_FragData_1;');
    expect(fs).toContain('void copc_edl_main()');
    expect(fs).toContain('out_FragData_0 = v_color;');
    expect(fs).not.toContain('out_FragColor');
    expect(fs).toContain('czm_packDepth');
  });

  it('pushes the composite then the clear once per frame, in the opaque pass', () => {
    const edl = new EyeDomeLighting(sphere, true, 1.5, 3);
    const context = makeContext();
    const frame = makeFrame(context, 7);

    edl.apply(frame, makeCommand());
    edl.apply(frame, makeCommand());

    expect(frame.commandList).toHaveLength(2);
    const [composite, clear] = frame.commandList as Record<string, unknown>[];
    expect(composite!.kind).toBe('composite');
    expect(composite!.boundingVolume).toBe(sphere);
    expect(clear!.kind).toBe('clear');
    expect(clear!.framebuffer).toBe(currentFramebuffer);
    expect(framebufferUpdate).toHaveBeenCalledWith(context, 800, 600);

    const overrides = context.createViewportQuadCommand.mock.calls[0]![1] as {
      pass: unknown;
      uniformMap: { u_radiusAndStrength: () => Cesium.Cartesian2 };
    };
    expect(overrides.pass).toBe(8); // OPAQUE
    // radius is in CSS pixels, scaled to device pixels by pixelRatio (2).
    expect(overrides.uniformMap.u_radiusAndStrength()).toEqual(new Cesium.Cartesian2(6, 1.5));

    const next = makeFrame(context, 8);
    edl.apply(next, makeCommand());
    expect(next.commandList).toHaveLength(2);
  });

  it('reuses the derived command until the model matrix or framebuffer changes', () => {
    const edl = new EyeDomeLighting(sphere, true, 1, 1);
    const context = makeContext();
    const cmd = makeCommand();

    const first = edl.apply(makeFrame(context, 1), cmd);
    expect(edl.apply(makeFrame(context, 2), cmd)).toBe(first);
    expect(Cesium.DrawCommand.shallowClone).toHaveBeenCalledTimes(1);

    // heightOffset swaps in a new model matrix.
    cmd.modelMatrix = new Cesium.Matrix4();
    expect((edl.apply(makeFrame(context, 3), cmd) as Record<string, unknown>).modelMatrix).toBe(
      cmd.modelMatrix,
    );

    // A resize recreates the framebuffer.
    currentFramebuffer = {};
    expect((edl.apply(makeFrame(context, 4), cmd) as Record<string, unknown>).framebuffer).toBe(
      currentFramebuffer,
    );
    expect(Cesium.DrawCommand.shallowClone).toHaveBeenCalledTimes(3);
  });

  it('allocates the offscreen target only once an EDL frame is drawn', () => {
    const edl = new EyeDomeLighting(sphere, true, 1, 1);
    expect(Cesium.FramebufferManager).not.toHaveBeenCalled();

    edl.apply(makeFrame(makeContext()), makeCommand());
    expect(Cesium.FramebufferManager).toHaveBeenCalledTimes(1);
  });

  it('releases the offscreen target when disabled and recreates it when re-enabled', () => {
    const edl = new EyeDomeLighting(sphere, true, 1, 1);
    const context = makeContext();
    const cmd = makeCommand();
    edl.apply(makeFrame(context, 1), cmd);

    edl.enabled = false;
    expect(edl.enabled).toBe(false);
    expect(framebufferDestroy).toHaveBeenCalledTimes(1);
    // Disabling again with nothing allocated is a no-op.
    edl.enabled = false;
    expect(framebufferDestroy).toHaveBeenCalledTimes(1);
    expect(edl.apply(makeFrame(context, 2), cmd)).toBe(cmd);
    expect(Cesium.FramebufferManager).toHaveBeenCalledTimes(1);

    currentFramebuffer = {};
    edl.enabled = true;
    const frame = makeFrame(context, 3);
    const derived = edl.apply(frame, cmd) as Record<string, unknown>;
    expect(Cesium.FramebufferManager).toHaveBeenCalledTimes(2);
    expect(framebufferUpdate).toHaveBeenLastCalledWith(context, 800, 600);
    // The derived command and the clear both follow the new target.
    expect(derived.framebuffer).toBe(currentFramebuffer);
    expect((frame.commandList[1] as Record<string, unknown>).framebuffer).toBe(currentFramebuffer);
  });

  it('destroy() releases the framebuffer and the composite shader', () => {
    const edl = new EyeDomeLighting(sphere, true, 1, 1);
    edl.apply(makeFrame(makeContext()), makeCommand());

    edl.destroy();

    expect(framebufferDestroy).toHaveBeenCalledTimes(1);
    expect(compositeProgram.destroy).toHaveBeenCalledTimes(1);
  });
});
