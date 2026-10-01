/**
 * Eye-Dome Lighting (EDL) for one `CopcDataSource`'s points, and nothing
 * else in the scene. Each opaque point command is swapped, per frame, for a
 * derived copy that draws into an offscreen colour + packed-depth target
 * instead of the scene; a viewport-quad composite then shades that image by
 * neighbouring depth and writes it — with each point's own depth — into the
 * scene, so terrain and other objects still occlude the points normally.
 *
 * Modelled on CesiumJS's private `PointCloudEyeDomeLighting` (which serves
 * 3D Tiles), rebuilt here rather than reused: that class expects its
 * commands as one contiguous run of the command list and tags the 3D Tiles
 * stencil bit, neither of which fits standalone primitives.
 */
import * as Cesium from 'cesium';
import { edlCompositeShaderSource } from './shaders';

interface ShaderSourceLike {
  sources: string[];
  clone(): ShaderSourceLike;
}
interface ShaderProgramLike {
  vertexShaderSource: ShaderSourceLike;
  fragmentShaderSource: ShaderSourceLike;
  _attributeLocations: Record<string, number>;
  destroy(): void;
}
interface DrawCommandLike {
  shaderProgram: ShaderProgramLike;
  modelMatrix: Cesium.Matrix4;
  framebuffer: unknown;
  pass: unknown;
  boundingVolume: unknown;
  castShadows: boolean;
  receiveShadows: boolean;
}
interface EdlContext {
  drawBuffers: boolean;
  fragmentDepth: boolean;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  shaderCache: {
    getDerivedShaderProgram(program: ShaderProgramLike, key: string): ShaderProgramLike | undefined;
    createDerivedShaderProgram(
      program: ShaderProgramLike,
      key: string,
      opts: {
        vertexShaderSource: ShaderSourceLike;
        fragmentShaderSource: ShaderSourceLike;
        attributeLocations: Record<string, number>;
      },
    ): ShaderProgramLike;
  };
  createViewportQuadCommand(
    fragmentShaderSource: unknown,
    overrides: Record<string, unknown>,
  ): DrawCommandLike;
}
interface EdlFrameState {
  context: EdlContext;
  commandList: unknown[];
  passes: { render: boolean };
  frameNumber: number;
  pixelRatio: number;
}
interface FramebufferManagerLike {
  framebuffer: unknown;
  update(context: unknown, width: number, height: number): void;
  getColorTexture(index: number): unknown;
  destroy(): void;
}

// None of these have public type declarations; only the members used here
// are declared.
interface CesiumEdlInternal {
  FramebufferManager: new (opts: Record<string, unknown>) => FramebufferManagerLike;
  ClearCommand: new (opts: Record<string, unknown>) => { framebuffer: unknown };
  ShaderSource: (new (opts: { defines?: string[]; sources: string[] }) => ShaderSourceLike) & {
    replaceMain(source: string, renamedMain: string): string;
  };
  DrawCommand: {
    shallowClone(command: DrawCommandLike, result?: DrawCommandLike): DrawCommandLike;
  };
  RenderState: { fromCache(opts?: Record<string, unknown>): unknown };
  BlendingState: { ALPHA_BLEND: unknown };
  Pass: { CESIUM_3D_TILE: unknown; OPAQUE: unknown };
}
const CesiumAny = Cesium as unknown as CesiumEdlInternal;

const DERIVED_SHADER_KEY = 'copcEdl';

/** The point shader, rewritten to also write its packed depth to a 2nd target. */
function getEdlShaderProgram(context: EdlContext, program: ShaderProgramLike): ShaderProgramLike {
  const cached = context.shaderCache.getDerivedShaderProgram(program, DERIVED_SHADER_KEY);
  if (cached) return cached;

  const fs = program.fragmentShaderSource.clone();
  fs.sources = fs.sources.map((source) =>
    CesiumAny.ShaderSource.replaceMain(source, 'copc_edl_main').replace(
      /out_FragColor/g,
      'out_FragData_0',
    ),
  );
  fs.sources.unshift(
    'layout (location = 0) out vec4 out_FragData_0;\nlayout (location = 1) out vec4 out_FragData_1;',
  );
  // czm_writeLogDepth() appearing here also tells Cesium's log-depth
  // derivation this shader already writes log depth, so it isn't wrapped twice.
  fs.sources.push(`
void main() {
  copc_edl_main();
#ifdef LOG_DEPTH
  czm_writeLogDepth();
  out_FragData_1 = czm_packDepth(gl_FragDepth);
#else
  out_FragData_1 = czm_packDepth(gl_FragCoord.z);
#endif
}`);

  return context.shaderCache.createDerivedShaderProgram(program, DERIVED_SHADER_KEY, {
    vertexShaderSource: program.vertexShaderSource,
    fragmentShaderSource: fs,
    attributeLocations: program._attributeLocations,
  });
}

export class EyeDomeLighting {
  enabled: boolean;
  /** Shading strength; `0` leaves the points unshaded. */
  strength: number;
  /** Neighbour sampling distance, in CSS pixels. */
  radius: number;

  private readonly _boundingVolume: Cesium.BoundingSphere;
  private readonly _framebuffer: FramebufferManagerLike;
  private readonly _derived = new WeakMap<object, DrawCommandLike>();
  private readonly _radiusAndStrength = new Cesium.Cartesian2();
  private _compositeCommand: DrawCommandLike | null = null;
  private _clearCommand: { framebuffer: unknown } | null = null;
  private _frameNumber = -1;
  private _warnedUnsupported = false;

  /**
   * @param boundingVolume Encloses every point; decides which frustums of a
   *   multi-frustum render run the composite.
   */
  constructor(
    boundingVolume: Cesium.BoundingSphere,
    enabled: boolean,
    strength: number,
    radius: number,
  ) {
    this._boundingVolume = boundingVolume;
    this.enabled = enabled;
    this.strength = strength;
    this.radius = radius;
    this._framebuffer = new CesiumAny.FramebufferManager({
      colorAttachmentsLength: 2,
      depth: true,
      supportsDepthTexture: true,
    });
  }

  /**
   * Returns the command to submit in place of `command` this frame: its EDL
   * copy when EDL is on and supported, else `command` itself. Only call it
   * for opaque commands — the composite has no per-pixel alpha ordering, so
   * translucent points (`opacity < 1`) are left to the normal pass.
   */
  apply(frameState: { context: unknown; commandList: unknown[] }, command: object): object {
    const fs = frameState as EdlFrameState;
    // A pick pass reads the plain commands' pick output; nothing to shade.
    if (!this.enabled || !fs.passes.render) return command;
    const context = fs.context;
    if (!context.drawBuffers || !context.fragmentDepth) {
      if (!this._warnedUnsupported) {
        this._warnedUnsupported = true;
        console.warn(
          '[CopcDataSource] eyeDomeLighting needs WebGL2 (or WEBGL_draw_buffers + EXT_frag_depth); drawing points without it.',
        );
      }
      return command;
    }

    if (this._frameNumber !== fs.frameNumber) {
      this._frameNumber = fs.frameNumber;
      this._prepareFrame(context, fs.pixelRatio);
      // Scene runs Pass.CESIUM_3D_TILE (where the offscreen point draws go)
      // before Pass.OPAQUE in every frustum, so the composite always reads
      // finished points however the primitives are ordered. The clear after
      // it leaves the target empty for the next frustum and frame.
      fs.commandList.push(this._compositeCommand, this._clearCommand);
    }
    return this._derive(context, command as DrawCommandLike);
  }

  private _prepareFrame(context: EdlContext, pixelRatio: number): void {
    // No-op unless the drawing buffer was resized (or this is the first frame).
    this._framebuffer.update(context, context.drawingBufferWidth, context.drawingBufferHeight);

    this._compositeCommand ??= context.createViewportQuadCommand(
      // LOG_DEPTH_WRITE: the composite writes gl_FragDepth itself, so Cesium's
      // log-depth derivation must not overwrite it.
      new CesiumAny.ShaderSource({
        defines: ['LOG_DEPTH_WRITE'],
        sources: [edlCompositeShaderSource],
      }),
      {
        uniformMap: {
          u_colorTexture: () => this._framebuffer.getColorTexture(0),
          u_depthTexture: () => this._framebuffer.getColorTexture(1),
          u_radiusAndStrength: () => this._radiusAndStrength,
        },
        renderState: CesiumAny.RenderState.fromCache({
          blending: CesiumAny.BlendingState.ALPHA_BLEND,
          depthMask: true,
          depthTest: { enabled: true },
        }),
        pass: CesiumAny.Pass.OPAQUE,
        owner: this,
      },
    );
    this._compositeCommand.boundingVolume = this._boundingVolume;

    this._clearCommand ??= new CesiumAny.ClearCommand({
      color: new Cesium.Color(0, 0, 0, 0),
      depth: 1,
      renderState: CesiumAny.RenderState.fromCache(),
      pass: CesiumAny.Pass.OPAQUE,
      owner: this,
    });
    // A resize recreates the framebuffer.
    this._clearCommand.framebuffer = this._framebuffer.framebuffer;

    this._radiusAndStrength.x = this.radius * pixelRatio;
    this._radiusAndStrength.y = this.strength;
  }

  private _derive(context: EdlContext, command: DrawCommandLike): DrawCommandLike {
    const framebuffer = this._framebuffer.framebuffer;
    let derived = this._derived.get(command);
    // modelMatrix is the one field PointCloudPrimitive replaces on an opaque
    // command (heightOffset); the framebuffer changes on resize.
    if (
      !derived ||
      derived.framebuffer !== framebuffer ||
      derived.modelMatrix !== command.modelMatrix
    ) {
      derived = CesiumAny.DrawCommand.shallowClone(command, derived);
      derived.framebuffer = framebuffer;
      derived.shaderProgram = getEdlShaderProgram(context, command.shaderProgram);
      derived.pass = CesiumAny.Pass.CESIUM_3D_TILE;
      derived.castShadows = false;
      derived.receiveShadows = false;
      this._derived.set(command, derived);
    }
    return derived;
  }

  destroy(): void {
    this._framebuffer.destroy();
    this._compositeCommand?.shaderProgram.destroy();
    this._compositeCommand = null;
    this._clearCommand = null;
  }
}
