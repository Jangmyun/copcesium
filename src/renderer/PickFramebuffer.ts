/**
 * Offscreen RGBA8 + depth framebuffer used only by `CopcDataSource.pickPoint()`.
 * Rendered into with the exact same viewport/view/projection as the visible
 * scene — full canvas size, resized in lockstep via `ensure()` — so a pixel
 * read back from it lines up exactly with what's on screen. Depth testing
 * across every visible node's pick `DrawCommand` drawn into it composites
 * occlusion the same way the main color framebuffer already does; nothing
 * here has to reason about "nearest" itself.
 */
import * as Cesium from 'cesium';

interface CesiumDestroyable {
  destroy(): void;
}

/** A Cesium `Framebuffer`; `_framebuffer` is its raw `WebGLFramebuffer`,
 *  bound directly by `readPixels()` — Cesium's wrapper has no public read API. */
interface CesiumFramebufferLike extends CesiumDestroyable {
  _framebuffer: WebGLFramebuffer;
}

interface CesiumContextLike {
  _gl: WebGL2RenderingContext;
}

// Framebuffer/Texture/PixelFormat/PixelDatatype/PassState/ClearCommand are
// Cesium's low-level renderer internals — no public type declarations, same
// as the Buffer/VertexArray/ShaderProgram/DrawCommand this project already
// wraps in PointCloudPrimitive.ts.
interface CesiumInternal {
  Texture: new (opts: {
    context: unknown;
    width: number;
    height: number;
    pixelFormat: unknown;
    pixelDatatype: unknown;
  }) => CesiumDestroyable;
  Framebuffer: new (opts: {
    context: unknown;
    colorTextures: CesiumDestroyable[];
    depthTexture: CesiumDestroyable;
  }) => CesiumFramebufferLike;
  PixelFormat: { RGBA: unknown; DEPTH_COMPONENT: unknown };
  PixelDatatype: { UNSIGNED_BYTE: unknown; UNSIGNED_SHORT: unknown };
  PassState: new (context: unknown) => { framebuffer: unknown; viewport: unknown };
  ClearCommand: new (opts: { color: unknown; depth: unknown; framebuffer: unknown }) => {
    execute(context: unknown, passState?: unknown): void;
  };
}
const CesiumAny = Cesium as unknown as CesiumInternal;

export class PickFramebuffer {
  private _width = 0;
  private _height = 0;
  private _framebuffer: CesiumFramebufferLike | null = null;
  private _passState: { framebuffer: unknown; viewport: unknown } | null = null;

  /** (Re)builds the framebuffer to match `width`/`height` if it doesn't
   *  already, and returns the (framebuffer, passState) pair to draw into and
   *  the raw context for a subsequent `readPixels()`. */
  ensure(context: unknown, width: number, height: number): { framebuffer: unknown; passState: unknown } {
    if (!this._framebuffer || this._width !== width || this._height !== height) {
      this.destroy();
      const colorTexture = new CesiumAny.Texture({
        context,
        width,
        height,
        pixelFormat: CesiumAny.PixelFormat.RGBA,
        pixelDatatype: CesiumAny.PixelDatatype.UNSIGNED_BYTE,
      });
      const depthTexture = new CesiumAny.Texture({
        context,
        width,
        height,
        pixelFormat: CesiumAny.PixelFormat.DEPTH_COMPONENT,
        pixelDatatype: CesiumAny.PixelDatatype.UNSIGNED_SHORT,
      });
      // destroyAttachments defaults to true, so `this._framebuffer.destroy()`
      // tears both textures down too — no separate handles to track.
      this._framebuffer = new CesiumAny.Framebuffer({ context, colorTextures: [colorTexture], depthTexture });
      this._width = width;
      this._height = height;
      const passState = new CesiumAny.PassState(context);
      passState.framebuffer = this._framebuffer;
      passState.viewport = new Cesium.BoundingRectangle(0, 0, width, height);
      this._passState = passState;
    }
    return { framebuffer: this._framebuffer, passState: this._passState };
  }

  /** Clears color to transparent black (node slot 0 — see `decodePickColor()`
   *  in `./shaders`) and depth to 1.0, ready for the next pick's draws. */
  clear(context: unknown): void {
    if (!this._framebuffer) return;
    new CesiumAny.ClearCommand({
      color: Cesium.Color.TRANSPARENT,
      depth: 1.0,
      framebuffer: this._framebuffer,
    }).execute(context, this._passState);
  }

  /** Reads back an RGBA8 rectangle. `x`/`y` are in GL (bottom-left-origin)
   *  drawing-buffer space, not window/CSS space — the caller converts. */
  readPixels(context: unknown, x: number, y: number, width: number, height: number): Uint8Array {
    if (!this._framebuffer) return new Uint8Array(0);
    const gl = (context as CesiumContextLike)._gl;
    const pixels = new Uint8Array(width * height * 4);
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._framebuffer._framebuffer);
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    return pixels;
  }

  destroy(): void {
    this._framebuffer?.destroy();
    this._framebuffer = null;
    this._passState = null;
    this._width = 0;
    this._height = 0;
  }
}
