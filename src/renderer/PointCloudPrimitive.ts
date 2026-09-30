/**
 * Rendering stage. Not a `Cesium.Primitive` subclass — a standalone class
 * built on Cesium's low-level DrawCommand API (custom vertex/fragment
 * shaders from `./shaders`) that uploads one loaded node's decoded points as
 * a single GPU buffer instead of the per-point JS objects `Cesium.Primitive`
 * would allocate. Exposes the live-tunable style uniforms (`pixelSize`,
 * `colorMode`, `opacity`, ...) that `CopcDataSource`'s setters mutate in
 * place.
 */
import * as Cesium from 'cesium';
import {
  vertexShaderSource,
  fragmentShaderSource,
  pickVertexShaderSource,
  pickFragmentShaderSource,
} from './shaders';
import type { NodeRenderData } from '../types';

/**
 * Style state shared live by every loaded primitive. Mutated in place by
 * `CopcDataSource`'s setters and read through each primitive's `uniformMap`,
 * so a style change is a uniform update on the next frame — no cache
 * invalidation, no refetch, no re-decode.
 */
export interface PointStyle {
  pixelSize: number;
  /** One of `SIZE_MODE`'s values. */
  sizeMode: number;
  /** Numerator of `attenuationFactor / sqrt(dist_m)`; only read when `sizeMode` is `attenuated`. */
  attenuationFactor: number;
  /** Lower clamp (pixels) for attenuated point size. */
  minPixelSize: number;
  /** Upper clamp (pixels) for attenuated point size. */
  maxPixelSize: number;
  /** One of `COLOR_MODE`'s values. */
  colorMode: number;
  /** Raw LAS intensity units at the two ends of the intensity ramp. */
  intensityRange: Cesium.Cartesian2;
  /** The 256-bit classification allow-list, as the 2 ivec4s `buildClassMask` packs. */
  classMask: Cesium.Cartesian4[];
  /** Alpha multiplier applied to every point's colour, 0..1. */
  opacity: number;
  /**
   * Meters to shift every point along its node's local "up" (the ECEF
   * direction from Earth's center through the node origin), for correcting a
   * vertical-datum/geoid mismatch between the point cloud and the globe.
   * Applied to the model matrix, not the shader — points move, the geometry
   * doesn't need touching.
   */
  heightOffset: number;
}

/** A Cesium `Buffer` (vertex buffer wrapper); `_buffer` is its raw
 *  `WebGLBuffer`, read directly by `readPointAttributes()`'s `getBufferSubData`
 *  calls — Cesium's own wrapper exposes no public readback method. */
interface CesiumBufferLike {
  _buffer: WebGLBuffer;
  destroy(): void;
}

/** The subset of Cesium's `Context` this file reaches into directly for
 *  `readPointAttributes()`'s raw `gl.getBufferSubData` calls. */
interface CesiumContextLike {
  _gl: WebGL2RenderingContext;
}

/** One point's attributes as read back by `readPointAttributes()`. */
export interface PickedPointAttributes {
  /** World-space (ECEF) position, including the live `heightOffset` shift. */
  position: Cesium.Cartesian3;
  /** Raw LAS classification code (0-255). */
  classification: number;
  /** Raw LAS intensity, or 0 for a file with no such dimension. */
  intensity: number;
}

// Cesium's low-level GPU API (Buffer/VertexArray/ShaderProgram/DrawCommand) has no
// public type declarations, so only the members this file uses are declared here.
interface CesiumInternal {
  Buffer: {
    createVertexBuffer(opts: {
      context: unknown;
      typedArray: ArrayBufferView;
      usage: unknown;
    }): CesiumBufferLike;
  };
  BufferUsage: { STATIC_DRAW: unknown };
  VertexArray: new (opts: { context: unknown; attributes: unknown[] }) => { destroy(): void };
  ShaderProgram: {
    fromCache(opts: {
      context: unknown;
      vertexShaderSource: string;
      fragmentShaderSource: string;
      attributeLocations: Record<string, number>;
    }): { destroy(): void };
  };
  DrawCommand: new (opts: Record<string, unknown>) => unknown;
  RenderState: { fromCache(opts: Record<string, unknown>): unknown };
  Pass: { OPAQUE: unknown; TRANSLUCENT: unknown };
  BlendingState: { ALPHA_BLEND: unknown };
}
const CesiumAny = Cesium as unknown as CesiumInternal;

// The subset of a constructed DrawCommand's own fields (as opposed to its
// constructor options) this file mutates in place after construction.
interface DrawCommandLike {
  modelMatrix: Cesium.Matrix4;
  pass: unknown;
  renderState: unknown;
  /** Off-screen target; only set on the pick command, and re-set on every
   *  pick call since `CopcDataSource`'s shared `PickFramebuffer` is rebuilt
   *  (a new Cesium `Framebuffer` object) whenever the canvas resizes. */
  framebuffer: unknown;
}

// Cesium.Primitive allocates a JS object per point; this DrawCommand-based
// wrapper instead uploads the node's TypedArrays as a single GPU buffer.
//
// GPU resources (VertexArray, ShaderProgram) are created lazily on the first
// update() call, since frameState.context is only available there.
export class PointCloudPrimitive {
  private _positions: Float32Array | null;
  private _origin: [number, number, number];
  private _up: Cesium.Cartesian3;
  private _appliedHeightOffset: number;
  private _appliedOpaque: boolean;
  private _colors: Uint8Array | null;
  private _intensities: Uint16Array | null;
  private _classifications: Uint8Array | null;
  private _elevations: Uint16Array | null;
  private _pointCount: number;
  private _boundingSphere: Cesium.BoundingSphere;
  private _style: PointStyle;
  public show: boolean;
  private _destroyed: boolean;
  private _cmd: DrawCommandLike | null;
  private _va: { destroy(): void } | null;
  private _sp: { destroy(): void } | null;
  /** Fired once, after the first successful `_initGpu()`, then dropped. */
  private _onGpuInit: ((startedAt: number, endedAt: number) => void) | null;
  // Raw buffer handles retained past `_initGpu()` (unlike the CPU TypedArrays,
  // which are freed) so `readPointAttributes()` can read a single point's
  // worth of bytes back from the GPU on demand, without keeping a full CPU
  // copy of every loaded node around for the sake of picking.
  private _positionBuffer: CesiumBufferLike | null;
  private _intensityBuffer: CesiumBufferLike | null;
  private _classificationBuffer: CesiumBufferLike | null;
  // Built lazily on first pick, from a WebGL2-only shader (reads
  // `gl_VertexID`) — see CopcDataSource.pickPoint().
  private _pickVa: { destroy(): void } | null;
  private _pickSp: { destroy(): void } | null;
  private _pickCmd: DrawCommandLike | null;
  /** Set by `preparePickCommand()` just before the caller draws it; read by
   *  the pick command's own `u_nodeSlot` uniform. */
  private _pickNodeSlot: number;

  constructor(
    renderData: NodeRenderData,
    boundingSphere: Cesium.BoundingSphere,
    style: PointStyle,
    onGpuInit?: (startedAt: number, endedAt: number) => void,
  ) {
    this._positions = renderData.positions;
    this._origin = renderData.origin;
    this._up = Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(renderData.origin[0], renderData.origin[1], renderData.origin[2]),
      new Cesium.Cartesian3(),
    );
    this._appliedHeightOffset = 0;
    this._appliedOpaque = true;
    this._colors = renderData.colors;
    this._intensities = renderData.intensities;
    this._classifications = renderData.classifications;
    this._elevations = renderData.elevations;
    this._pointCount = renderData.pointCount;
    this._boundingSphere = boundingSphere;
    this._style = style;
    this.show = true;
    this._destroyed = false;
    this._cmd = null;
    this._va = null;
    this._sp = null;
    this._onGpuInit = onGpuInit ?? null;
    this._positionBuffer = null;
    this._intensityBuffer = null;
    this._classificationBuffer = null;
    this._pickVa = null;
    this._pickSp = null;
    this._pickCmd = null;
    this._pickNodeSlot = 0;
  }

  // Called by PrimitiveCollection every frame.
  update(frameState: { context: unknown; commandList: unknown[] }): void {
    if (!this.show || this._destroyed) return;
    if (!this._cmd) {
      // A GPU init failure (context loss, out of VRAM, ...) must not throw here:
      // that would abort Cesium's whole frame loop. Skip just this node instead.
      try {
        const startedAt = performance.now();
        this._initGpu(frameState.context);
        // Only on success: a node excluded below never reached the GPU, and
        // counting its failed attempt as an upload would skew the percentiles
        // with a number that measures an error path.
        this._onGpuInit?.(startedAt, performance.now());
        this._onGpuInit = null;
      } catch (err) {
        console.error('[PointCloudPrimitive] GPU initialization failed; excluding this node from rendering:', err);
        this._destroyed = true;
        return;
      }
    } else {
      // Cheap enough to compare every frame; the underlying rebuilds only
      // happen on the frames where the relevant style field actually changed.
      if (this._style.heightOffset !== this._appliedHeightOffset) {
        this._cmd.modelMatrix = this._modelMatrix(this._style.heightOffset);
        this._appliedHeightOffset = this._style.heightOffset;
      }
      const opaque = this._style.opacity >= 1;
      if (opaque !== this._appliedOpaque) {
        this._cmd.pass = opaque ? CesiumAny.Pass.OPAQUE : CesiumAny.Pass.TRANSLUCENT;
        this._cmd.renderState = PointCloudPrimitive._renderState(opaque);
        this._appliedOpaque = opaque;
      }
    }
    frameState.commandList.push(this._cmd);
  }

  // RenderState.fromCache memoizes by contents, so this is cheap to call on
  // every opacity threshold crossing rather than caching the result here too.
  private static _renderState(opaque: boolean): unknown {
    return opaque
      ? CesiumAny.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: true })
      : CesiumAny.RenderState.fromCache({
          depthTest: { enabled: true },
          depthMask: false,
          blending: CesiumAny.BlendingState.ALPHA_BLEND,
        });
  }

  /** Node origin shifted `heightOffset` meters along the node's local "up". */
  private _modelMatrix(heightOffset: number): Cesium.Matrix4 {
    const origin = new Cesium.Cartesian3(this._origin[0], this._origin[1], this._origin[2]);
    const shift = Cesium.Cartesian3.multiplyByScalar(this._up, heightOffset, new Cesium.Cartesian3());
    return Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.add(origin, shift, origin));
  }

  private _initGpu(context: unknown): void {
    const mkVBuf = (arr: ArrayBufferView) =>
      CesiumAny.Buffer.createVertexBuffer({
        context,
        typedArray: arr,
        usage: CesiumAny.BufferUsage.STATIC_DRAW,
      });

    let va: { destroy(): void } | null = null;
    let sp: { destroy(): void } | null = null;
    try {
      // Retained on `this` (not just local vars) for position/intensity/
      // classification — readPointAttributes() reads them back directly by
      // pointIndex on a pick hit, instead of keeping a full CPU copy of every
      // loaded node around just in case it's picked.
      const positionBuffer = mkVBuf(this._positions!);
      const colorBuffer = mkVBuf(this._colors!);
      const intensityBuffer = mkVBuf(this._intensities!);
      const classificationBuffer = mkVBuf(this._classifications!);
      const elevationBuffer = mkVBuf(this._elevations!);

      va = new CesiumAny.VertexArray({
        context,
        attributes: [
          {
            index: 0, // position (node-relative offset)
            vertexBuffer: positionBuffer,
            componentsPerAttribute: 3,
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            offsetInBytes: 0,
            strideInBytes: 12,
          },
          {
            index: 1, // color
            vertexBuffer: colorBuffer,
            componentsPerAttribute: 4,
            componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
            normalize: true,
            offsetInBytes: 0,
            strideInBytes: 4,
          },
          {
            index: 2, // intensity
            vertexBuffer: intensityBuffer,
            componentsPerAttribute: 1,
            componentDatatype: Cesium.ComponentDatatype.UNSIGNED_SHORT,
            normalize: true,
            offsetInBytes: 0,
            strideInBytes: 2,
          },
          {
            index: 3, // classification
            vertexBuffer: classificationBuffer,
            componentsPerAttribute: 1,
            componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
            normalize: true,
            offsetInBytes: 0,
            strideInBytes: 1,
          },
          {
            index: 4, // elevation
            vertexBuffer: elevationBuffer,
            componentsPerAttribute: 1,
            componentDatatype: Cesium.ComponentDatatype.UNSIGNED_SHORT,
            normalize: true,
            offsetInBytes: 0,
            strideInBytes: 2,
          },
        ],
      });
      this._positionBuffer = positionBuffer;
      this._intensityBuffer = intensityBuffer;
      this._classificationBuffer = classificationBuffer;

      const style = this._style;

      sp = CesiumAny.ShaderProgram.fromCache({
        context,
        vertexShaderSource,
        fragmentShaderSource,
        attributeLocations: {
          position: 0,
          color: 1,
          intensity: 2,
          classification: 3,
          elevation: 4,
        },
      });

      this._va = va;
      this._sp = sp;
      const opaque = style.opacity >= 1;
      this._cmd = new CesiumAny.DrawCommand({
        vertexArray: va,
        primitiveType: Cesium.PrimitiveType.POINTS,
        shaderProgram: sp,
        renderState: PointCloudPrimitive._renderState(opaque),
        boundingVolume: this._boundingSphere,
        count: this._pointCount,
        pass: opaque ? CesiumAny.Pass.OPAQUE : CesiumAny.Pass.TRANSLUCENT,
        // Carries the node origin (shifted by the live heightOffset) the
        // worker subtracted off; the vertex shader reconstructs absolute
        // ECEF from this plus the node-relative offsets.
        modelMatrix: this._modelMatrix(this._style.heightOffset),
        uniformMap: {
          u_pixelSize: () => style.pixelSize,
          u_sizeMode: () => style.sizeMode,
          u_attenuationFactor: () => style.attenuationFactor,
          u_minPixelSize: () => style.minPixelSize,
          u_maxPixelSize: () => style.maxPixelSize,
          u_colorMode: () => style.colorMode,
          u_intensityRange: () => style.intensityRange,
          u_classMask: () => style.classMask,
          u_opacity: () => style.opacity,
        },
      }) as DrawCommandLike;
      this._appliedHeightOffset = this._style.heightOffset;
      this._appliedOpaque = opaque;
    } catch (err) {
      try {
        if (va) va.destroy();
      } catch {
        /* ignore */
      }
      try {
        if (sp) sp.destroy();
      } catch {
        /* ignore */
      }
      this._destroyed = true;
      throw err;
    }

    // CPU-side arrays are no longer needed once uploaded to the GPU. Every
    // style change is a uniform update, so nothing here has to be re-read.
    this._positions = null;
    this._colors = null;
    this._intensities = null;
    this._classifications = null;
    this._elevations = null;
  }

  /**
   * Builds (once) and returns this node's pick-pass `DrawCommand`, or `null`
   * if the node isn't currently showing — a hidden/off-screen node has
   * nothing on screen to click, so it must not be pickable (matches the main
   * pass's rendered visibility). `nodeSlot` must be `>= 1`; the caller assigns
   * one per currently-visible primitive for a single `pickPoint()` call (see
   * `decodePickColor()` in `./shaders` for why `0` is reserved).
   *
   * WebGL2-only: the pick vertex shader reads `gl_VertexID`. Callers must
   * check `Cesium.FeatureDetection.supportsWebgl2(scene)` before ever reaching
   * this (`CopcDataSource.pickPoint()` does).
   */
  preparePickCommand(context: unknown, nodeSlot: number, framebuffer: unknown): DrawCommandLike | null {
    if (!this.show || this._destroyed || !this._cmd || !this._positionBuffer || !this._classificationBuffer) {
      return null;
    }
    this._pickNodeSlot = nodeSlot;
    if (this._pickCmd) {
      this._pickCmd.framebuffer = framebuffer;
      // heightOffset may have changed since this command was built; update()
      // keeps _cmd's modelMatrix in sync the same way for the main pass.
      this._pickCmd.modelMatrix = this._modelMatrix(this._style.heightOffset);
      return this._pickCmd;
    }

    const pickVa = new CesiumAny.VertexArray({
      context,
      attributes: [
        {
          index: 0, // position (node-relative offset) — same buffer as the main VA's
          vertexBuffer: this._positionBuffer,
          componentsPerAttribute: 3,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          offsetInBytes: 0,
          strideInBytes: 12,
        },
        {
          index: 1, // classification — same buffer as the main VA's, for the same allow-list cull
          vertexBuffer: this._classificationBuffer,
          componentsPerAttribute: 1,
          componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
          normalize: true,
          offsetInBytes: 0,
          strideInBytes: 1,
        },
      ],
    });
    const pickSp = CesiumAny.ShaderProgram.fromCache({
      context,
      vertexShaderSource: pickVertexShaderSource,
      fragmentShaderSource: pickFragmentShaderSource,
      attributeLocations: { position: 0, classification: 1 },
    });

    const style = this._style;
    this._pickVa = pickVa;
    this._pickSp = pickSp;
    this._pickCmd = new CesiumAny.DrawCommand({
      vertexArray: pickVa,
      primitiveType: Cesium.PrimitiveType.POINTS,
      shaderProgram: pickSp,
      // Always opaque depth test/write, independent of the style's live
      // opacity: blending two points' encoded IDs together would decode to
      // neither, and a decisive nearest-wins hit is exactly what picking wants.
      renderState: CesiumAny.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: true }),
      boundingVolume: this._boundingSphere,
      count: this._pointCount,
      modelMatrix: this._modelMatrix(this._style.heightOffset),
      framebuffer,
      uniformMap: {
        u_pixelSize: () => style.pixelSize,
        u_sizeMode: () => style.sizeMode,
        u_attenuationFactor: () => style.attenuationFactor,
        u_minPixelSize: () => style.minPixelSize,
        u_maxPixelSize: () => style.maxPixelSize,
        u_classMask: () => style.classMask,
        u_nodeSlot: () => this._pickNodeSlot,
      },
    }) as DrawCommandLike;
    return this._pickCmd;
  }

  /**
   * Reads one point's position/classification/intensity directly off the
   * GPU buffers via `gl.getBufferSubData` (WebGL2-only) — a targeted few-byte
   * read, not a full-buffer download, since the CPU-side copies were freed
   * once uploaded (see `_initGpu()`). `pointIndex` is `gl_VertexID` as decoded
   * from a pick hit; out-of-range values throw.
   */
  readPointAttributes(pointIndex: number, context: unknown): PickedPointAttributes {
    if (pointIndex < 0 || pointIndex >= this._pointCount) {
      throw new RangeError(`pointIndex ${pointIndex} is out of range for a node with ${this._pointCount} points`);
    }
    if (!this._positionBuffer || !this._intensityBuffer || !this._classificationBuffer) {
      throw new Error('readPointAttributes() called before this node reached the GPU');
    }
    const gl = (context as CesiumContextLike)._gl;
    // Restored below: Cesium caches its own GL bindings, and a binding changed
    // behind its back could otherwise leak into its next draw.
    const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;

    const positionBytes = new Float32Array(3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._positionBuffer._buffer);
    gl.getBufferSubData(gl.ARRAY_BUFFER, pointIndex * 12, positionBytes);

    const intensityBytes = new Uint16Array(1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._intensityBuffer._buffer);
    gl.getBufferSubData(gl.ARRAY_BUFFER, pointIndex * 2, intensityBytes);

    const classificationBytes = new Uint8Array(1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._classificationBuffer._buffer);
    gl.getBufferSubData(gl.ARRAY_BUFFER, pointIndex, classificationBytes);
    gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer);

    const offset = new Cesium.Cartesian3(positionBytes[0], positionBytes[1], positionBytes[2]);
    const position = Cesium.Matrix4.multiplyByPoint(
      this._modelMatrix(this._style.heightOffset),
      offset,
      new Cesium.Cartesian3(),
    );

    return {
      position,
      classification: classificationBytes[0]!,
      intensity: intensityBytes[0]!,
    };
  }

  /** The shared style object this primitive's uniforms read through. */
  get style(): PointStyle {
    return this._style;
  }

  isDestroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    if (!this._destroyed) {
      if (this._va) this._va.destroy();
      if (this._sp) this._sp.destroy();
      // _pickVa shares its position/classification buffers with _va, already
      // destroyed above; VertexArray.destroy() skips an already-destroyed
      // buffer, so this is safe to call unconditionally after it.
      if (this._pickVa) this._pickVa.destroy();
      if (this._pickSp) this._pickSp.destroy();
      this._destroyed = true;
    }
    return Cesium.destroyObject(this);
  }
}
