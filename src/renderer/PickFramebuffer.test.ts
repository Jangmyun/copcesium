import { describe, it, expect, vi, beforeEach } from 'vitest';

// Texture/Framebuffer/PassState need a live WebGL context; mock them to plain
// recorders so the attachment formats ensure() asks for can be asserted.
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cesium')>();
  return {
    ...actual,
    // Regular functions, not arrows: all three are called with `new`.
    Texture: vi.fn(function (this: Record<string, unknown>, opts: Record<string, unknown>) {
      Object.assign(this, opts, { destroy: vi.fn() });
    }),
    Framebuffer: vi.fn(function (this: Record<string, unknown>, opts: Record<string, unknown>) {
      Object.assign(this, opts, { destroy: vi.fn(), _framebuffer: {} });
    }),
    PassState: vi.fn(function () {}),
  };
});

const Cesium = await import('cesium');
const { PickFramebuffer } = await import('./PickFramebuffer');

type Opts = Record<string, unknown>;
const CesiumAny = Cesium as unknown as {
  PixelFormat: Record<string, unknown>;
  PixelDatatype: Record<string, unknown>;
};

beforeEach(() => vi.clearAllMocks());

describe('PickFramebuffer', () => {
  // 16-bit depth can't order points kilometres apart even with pickPoint()'s
  // tightened near/far, so the pick target must carry 24-bit depth.
  it('attaches a 24-bit depth (DEPTH_STENCIL / UNSIGNED_INT_24_8) texture', () => {
    const fb = new PickFramebuffer();
    fb.ensure({}, 64, 32);

    const textureOpts = vi
      .mocked(Cesium.Texture as unknown as (o: Opts) => void)
      .mock.calls.map((c) => c[0]);
    const depth = textureOpts.find((o) => o.pixelFormat === CesiumAny.PixelFormat.DEPTH_STENCIL);
    expect(depth).toMatchObject({
      width: 64,
      height: 32,
      pixelDatatype: CesiumAny.PixelDatatype.UNSIGNED_INT_24_8,
    });
    expect(textureOpts.some((o) => o.pixelFormat === CesiumAny.PixelFormat.DEPTH_COMPONENT)).toBe(
      false,
    );

    const fbOpts = vi.mocked(Cesium.Framebuffer as unknown as (o: Opts) => void).mock.calls[0]?.[0];
    expect(fbOpts?.depthStencilTexture).toMatchObject({
      pixelFormat: CesiumAny.PixelFormat.DEPTH_STENCIL,
    });
    expect(fbOpts?.depthTexture).toBeUndefined();
  });

  it('reuses the framebuffer at the same size and rebuilds it on resize', () => {
    const fb = new PickFramebuffer();
    const first = fb.ensure({}, 64, 32).framebuffer as { destroy: () => void };
    expect(fb.ensure({}, 64, 32).framebuffer).toBe(first);

    const second = fb.ensure({}, 128, 32).framebuffer;
    expect(second).not.toBe(first);
    expect(first.destroy).toHaveBeenCalledTimes(1);
  });
});
