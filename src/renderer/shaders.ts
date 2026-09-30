import * as Cesium from 'cesium';
import { CLASSIFICATION_COLORS, DEFAULT_CLASS_COLOR } from '../style/classificationColors';

/** Colour mode as the shader sees it. Kept in sync with `ColorMode` in types.ts. */
export const COLOR_MODE = {
  rgb: 0,
  intensity: 1,
  classification: 2,
  elevation: 3,
} as const;

/** Point size mode as the shader sees it. Kept in sync with `PointSizeMode` in types.ts. */
export const SIZE_MODE = {
  fixed: 0,
  attenuated: 1,
} as const;

/**
 * Packs classification codes into the 8 signed 32-bit words `classAllowed()`
 * below reads. `undefined` means "no filter" and sets every bit.
 *
 * Lives next to the GLSL that decodes it so the two halves of the encoding
 * can't be changed independently.
 */
export function buildClassMask(filter: number[] | undefined): Cesium.Cartesian4[] {
  const words = new Int32Array(8);
  if (filter === undefined) {
    words.fill(-1); // every bit set — all 256 codes allowed
  } else {
    for (const code of filter) {
      if (!Number.isInteger(code) || code < 0 || code > 255) {
        throw new RangeError(`classificationFilter expects LAS classification codes (integers 0-255), got ${code}`);
      }
      words[code >> 5] |= 1 << (code & 31);
    }
  }
  return [
    new Cesium.Cartesian4(words[0], words[1], words[2], words[3]),
    new Cesium.Cartesian4(words[4], words[5], words[6], words[7]),
  ];
}

function toVec3([r, g, b]: [number, number, number]): string {
  return `vec3(${(r / 255).toFixed(4)}, ${(g / 255).toFixed(4)}, ${(b / 255).toFixed(4)})`;
}

// Generated from the table the worker also uses, so the palette can't drift
// between the CPU fallback path and this GPU colour mode. Eight comparisons
// against a uniform-free constant chain costs less than a texture lookup.
const classificationBranches = Object.entries(CLASSIFICATION_COLORS)
  .map(([code, rgb]) => `  if (c == ${code}) return ${toVec3(rgb)};`)
  .join('\n');

// Shared by the main and pick vertex shaders so the two can't drift apart —
// a point the pick pass would let through that the main pass culls (or vice
// versa) would make picking silently disagree with what's on screen.
const classAllowedSource = `
// 256 codes packed into 8 int32 words: word = c / 32, bit = c % 32. Cesium's
// uniform layer has no unsigned-int setter (createUniform throws on uvec*),
// so the words are signed and "all allowed" is -1 rather than 0xFFFFFFFF.
bool classAllowed(int c) {
  int word = c >> 5;
  int bits = u_classMask[word >> 2][word & 3];
  return ((bits >> (c & 31)) & 1) != 0;
}`;

// Also shared for the same reason: the pick pass must rasterize points at
// exactly the size the main pass draws them, or a click that visually lands
// on a point could miss it (or hit a neighbor) in the pick pass.
const pointSizeSource = `
  vec3 eyeRel = position - czm_encodedCameraPositionMCHigh - czm_encodedCameraPositionMCLow;

  if (u_sizeMode == ${SIZE_MODE.attenuated}) {
    // max(..., epsilon): a point essentially at the camera would otherwise
    // divide by ~0 and blow up to a huge, GPU-hostile point size.
    float distMeters = max(length(eyeRel), 1e-4);
    gl_PointSize = clamp(u_attenuationFactor / sqrt(distMeters), u_minPixelSize, u_maxPixelSize);
  } else {
    gl_PointSize = u_pixelSize;
  }`;

export const vertexShaderSource = `
in vec3 position;
in vec4 color;
in float intensity;       // UNSIGNED_SHORT, normalized -> raw / 65535
in float classification;  // UNSIGNED_BYTE, normalized  -> code / 255
in float elevation;       // UNSIGNED_SHORT, normalized -> already 0..1 over the file's Z range

uniform float u_pixelSize;
uniform int u_sizeMode;
uniform float u_attenuationFactor;
uniform float u_minPixelSize;
uniform float u_maxPixelSize;
uniform int u_colorMode;
uniform vec2 u_intensityRange;  // raw LAS units, mapped to the ramp's 0..1
uniform ivec4 u_classMask[2];   // 256-bit allow-list, one bit per classification code
uniform float u_opacity;

out vec4 v_color;

vec3 classificationColor(int c) {
${classificationBranches}
  return ${toVec3(DEFAULT_CLASS_COLOR)};
}

vec3 elevationColor(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) return mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 1.0), t * 4.0);
  if (t < 0.50) return mix(vec3(0.0, 1.0, 1.0), vec3(0.0, 1.0, 0.0), (t - 0.25) * 4.0);
  if (t < 0.75) return mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 1.0, 0.0), (t - 0.50) * 4.0);
  return mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), (t - 0.75) * 4.0);
}
${classAllowedSource}

void main() {
  int c = int(classification * 255.0 + 0.5);

  if (!classAllowed(c)) {
    // Outside clip space, so the point is culled before it ever rasterizes.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    v_color = vec4(0.0);
    return;
  }

  vec3 rgb;
  if (u_colorMode == ${COLOR_MODE.intensity}) {
    float raw = intensity * 65535.0;
    float span = max(u_intensityRange.y - u_intensityRange.x, 1.0);
    rgb = vec3(clamp((raw - u_intensityRange.x) / span, 0.0, 1.0));
  } else if (u_colorMode == ${COLOR_MODE.classification}) {
    rgb = classificationColor(c);
  } else if (u_colorMode == ${COLOR_MODE.elevation}) {
    rgb = elevationColor(elevation);
  } else {
    rgb = color.rgb;
  }

  v_color = vec4(rgb, color.a * u_opacity);
  // position is a node-relative offset (model coordinates); the node origin
  // rides in the model matrix. Reconstruct the eye-relative position the way
  // czm_translateRelativeToEye does, but from a single Float32 offset — the
  // precision comes from the double-precision origin baked into the matrix.
${pointSizeSource}

  gl_Position = czm_modelViewProjectionRelativeToEye * vec4(eyeRel, 1.0);
}`;

// Cesium's shader pipeline recognizes the literal output name "out_FragColor"
// (its own convention, e.g. PerInstanceFlatColorAppearanceFS) and both
// auto-injects its "layout(location = 0) out vec4 out_FragColor;"
// declaration AND regex-rewrites it for the translucent/OIT multi-render-
// target pass. Declaring it ourselves causes a "redefinition" compile error;
// using a different name (e.g. "fragColor") leaves the OIT derivation
// unrecognized and produces an unlocated extra output instead. So: reference
// out_FragColor, but don't declare it.
export const fragmentShaderSource = `
in vec4 v_color;
void main() {
  out_FragColor = v_color;
}`;

/**
 * Highest node slot / point index the pick encoding below can represent.
 * `decodePickColor()`'s caller must keep concurrently-picked nodes at or
 * under this count, and must not pick a node with more points than this —
 * past it the index wraps and reports a different point's data.
 *
 * Split 24/8 rather than 16/16: a COPC node commonly holds more than 65,535
 * points, while the slot count is bounded by the visible node set (default
 * `maxVisibleNodes` 100).
 */
export const MAX_PICKABLE_NODE_SLOTS = 0xff;
export const MAX_PICKABLE_POINT_INDEX = 0xffffff;

// Reads gl_VertexID (WebGL2/GLSL ES 300 only), so point-level picking is a
// WebGL2-only feature — see CopcDataSource.pickPoint()'s
// FeatureDetection.supportsWebgl2 guard.
export const pickVertexShaderSource = `
in vec3 position;
in float classification;  // UNSIGNED_BYTE, normalized -> code / 255

uniform float u_pixelSize;
uniform int u_sizeMode;
uniform float u_attenuationFactor;
uniform float u_minPixelSize;
uniform float u_maxPixelSize;
uniform ivec4 u_classMask[2];
// 1-based: a decoded node slot of 0 unambiguously means "the framebuffer's
// clear color", i.e. no hit — point index 0 of node slot 0 would otherwise be
// indistinguishable from an untouched pixel.
uniform int u_nodeSlot;

flat out int v_pointIndex;
flat out int v_nodeSlot;
${classAllowedSource}

void main() {
  int c = int(classification * 255.0 + 0.5);
  v_pointIndex = gl_VertexID;
  v_nodeSlot = u_nodeSlot;

  if (!classAllowed(c)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
${pointSizeSource}

  gl_Position = czm_modelViewProjectionRelativeToEye * vec4(eyeRel, 1.0);
}`;

export const pickFragmentShaderSource = `
flat in int v_pointIndex;
flat in int v_nodeSlot;

void main() {
  // Packs pointIndex (24-bit, RGB) and nodeSlot (8-bit, A) across the four
  // RGBA8 channels — decoded by decodePickColor() below.
  int idx = v_pointIndex;
  int slot = v_nodeSlot;
  out_FragColor = vec4(
    float(idx & 255) / 255.0,
    float((idx >> 8) & 255) / 255.0,
    float((idx >> 16) & 255) / 255.0,
    float(slot & 255) / 255.0
  );
}`;

/** Mirrors `pickFragmentShaderSource`'s encoding. Returns `undefined` for a
 *  pixel the pick pass never drew to (node slot 0 — see the shader's comment). */
export function decodePickColor(
  rgba: Uint8Array | Uint8ClampedArray,
  offset = 0,
): { pointIndex: number; nodeSlot: number } | undefined {
  const nodeSlot = rgba[offset + 3]!;
  if (nodeSlot === 0) return undefined;
  const pointIndex = rgba[offset]! | (rgba[offset + 1]! << 8) | (rgba[offset + 2]! << 16);
  return { pointIndex, nodeSlot };
}
