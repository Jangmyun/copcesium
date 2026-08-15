import { Copc } from 'copc';
import type { View } from 'copc';
// `laz-perf/lib/worker` (not the top-level `laz-perf`/`lib/web` entry) has
// `ENVIRONMENT_IS_WORKER` compiled in as `true`; this file always executes
// inside a Worker, and the web build's glue code assumes window/DOM globals
// that aren't present here.
import { LazPerf } from 'laz-perf/lib/worker';
import proj4 from 'proj4';
import type { Getter } from 'copc';
import type { WorkerCancelRequest, WorkerRequest, WorkerResponse } from './WorkerPool';
import type { NodeConversionPayload } from './messages';
import type { NodeRenderData } from '../types';
import { CLASSIFICATION_COLORS, DEFAULT_CLASS_COLOR } from '../style/classificationColors';
// laz-perf.wasm, embedded as base64 by vite-plugins/lazPerfWasmInline.ts — see
// getLazPerf() below for why this worker can't fetch it as a sibling file.
import lazPerfWasmBase64 from 'virtual:laz-perf-wasm-base64';

// This file always runs inside a Worker, never a Window, but the project's
// tsconfig only includes the "DOM" lib (not "webworker") to avoid the global
// type conflicts between the two. Re-declare postMessage with its Worker
// signature (message, transfer?) instead of Window's (message, targetOrigin,
// transfer?) so the calls below type-check against what this file actually
// runs under.
declare function postMessage(message: unknown, transfer?: Transferable[]): void;

// WGS84 ellipsoid parameters, applied by hand instead of via Cesium.Cartesian3
// — this worker must never construct a Cesium object (team rule 3).
const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;

export function lonLatAltToEcef(lonDeg: number, latDeg: number, altM: number): [number, number, number] {
  const lon = lonDeg * (Math.PI / 180);
  const lat = latDeg * (Math.PI / 180);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (n + altM) * cosLat * Math.cos(lon),
    (n + altM) * cosLat * Math.sin(lon),
    (n * (1 - WGS84_E2) + altM) * sinLat,
  ];
}

const FLAT_COLOR: [number, number, number] = [200, 200, 200];

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Created once and reused for the lifetime of this worker. Recompiling the
// laz-perf WASM per node is exactly what WorkerPool exists to avoid, so the
// worker script itself must not undo that by re-creating it per task either.
let lazPerfPromise: ReturnType<typeof LazPerf.create> | null = null;
function getLazPerf(): ReturnType<typeof LazPerf.create> {
  // This worker is itself inlined into a Blob at build time (see
  // `?worker&inline` in CopcDataSource.ts), so it has no stable, fetchable
  // URL of its own to resolve a sibling laz-perf.wasm against — a Blob's
  // `import.meta.url` has an opaque origin. Passing the raw bytes directly as
  // `wasmBinary` skips emscripten's `locateFile`/`fetch` path entirely, which
  // also sidesteps the muted-error behavior a `data:`-URI fetch had (#B10):
  // WebAssembly.instantiate() on an in-memory buffer throws a real error, not
  // one flattened by an opaque-origin fetch.
  lazPerfPromise ??= LazPerf.create({ wasmBinary: base64ToBytes(lazPerfWasmBase64) });
  return lazPerfPromise;
}

/**
 * `Copc.loadPointDataView()` needs a `Getter`, but this node's compressed
 * bytes have already been fetched — merged with any adjacent sibling ranges
 * by `RangeFetcher` — on the main thread before the task ever reached a
 * worker (#86), so no network access happens here; this just hands the bytes
 * back.
 */
function createBufferGetter(bytes: Uint8Array): Getter {
  return async () => bytes;
}

const registeredProjs = new Set<string>();

function tryGetter(view: View, name: string): View.Getter | undefined {
  try {
    return view.getter(name);
  } catch {
    return undefined;
  }
}

/**
 * Fetches a COPC node's compressed point data (HTTP Range Request), decodes
 * it, and converts it into render-ready ECEF positions and RGBA colors.
 *
 * Deliberately stops short of what the original copc-cesium worker did: RTE
 * high/low splitting now lives in renderer/PointCloudPrimitive.ts (#16), and
 * the bounding sphere is computed from the node key alone in
 * lod/boundingVolume.ts (#13), so neither is duplicated here.
 */
export async function convertNode(payload: NodeConversionPayload): Promise<NodeRenderData> {
  const { compressedBytes, copc, node, proj, projDef, geoidOffset, zFactor, zMin, zMax } = payload;

  const lazPerf = await getLazPerf();
  const view = await Copc.loadPointDataView(createBufferGetter(compressedBytes), copc, node, { lazPerf });
  const n = view.pointCount;

  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
    throw new Error(`Invalid pointCount: ${n}`);
  }

  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  const getR = tryGetter(view, 'Red');
  const getG = tryGetter(view, 'Green');
  const getB = tryGetter(view, 'Blue');
  const hasRGB = !!(getR && getG && getB);
  // Read unconditionally now — Classification is shipped as its own attribute
  // for the styling API, not just consumed by the no-RGB colour fallback.
  const getCls = tryGetter(view, 'Classification');
  const getIntensity = tryGetter(view, 'Intensity');

  if (proj !== 'EPSG:4326' && projDef && !registeredProjs.has(proj)) {
    proj4.defs(proj, projDef);
    registeredProjs.add(proj);
  }
  const needsProj = proj !== 'EPSG:4326';
  const converter = needsProj ? proj4(proj, 'EPSG:4326') : null;

  // Read each point's raw RGB once into a scratch buffer while tracking
  // maxColor in the same pass, so 16-bit-encoded colors (0-65535, common in
  // LAS producers) still scale down correctly without a second round of
  // getter calls (each of which does a bounds check, an offset computation,
  // and a DataView read) during the main loop below.
  let maxColor = 0;
  const rgbRaw = hasRGB ? new Uint16Array(n * 3) : null;
  if (hasRGB && rgbRaw) {
    for (let i = 0; i < n; i++) {
      const r = getR!(i);
      const g = getG!(i);
      const b = getB!(i);
      const i3 = i * 3;
      rgbRaw[i3] = r;
      rgbRaw[i3 + 1] = g;
      rgbRaw[i3 + 2] = b;
      if (r > maxColor) maxColor = r;
      if (g > maxColor) maxColor = g;
      if (b > maxColor) maxColor = b;
    }
  }
  const colorScale = maxColor > 255 ? 65535 : 255;

  // Positions leave the worker as Float32 offsets from the node origin (the
  // first point's ECEF), with the double-precision origin carried separately
  // and baked into the primitive's model matrix on the main thread. This
  // halves the wire size (12 vs 24 bytes/point) and lets the render thread skip
  // the RTE high/low split entirely — precision now lives in the origin, not in
  // splitting each absolute coordinate. Offsets stay within a node's extent, so
  // a single float32 holds them to sub-millimeter precision.
  const positions = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 4);
  const intensities = new Uint16Array(n);
  const classifications = new Uint8Array(n);
  const elevations = new Uint16Array(n);
  let maxIntensity = 0;
  let ox = 0;
  let oy = 0;
  let oz = 0;

  // A flat dataset (or a header that reports one) leaves every point at the
  // bottom of the ramp rather than dividing by zero.
  const zSpan = zMax - zMin;
  const zScale = zSpan > 0 ? 65535 / zSpan : 0;

  for (let i = 0; i < n; i++) {
    const x = getX(i);
    const y = getY(i);
    const z = getZ(i);

    let lon: number;
    let lat: number;
    if (needsProj && converter) {
      [lon, lat] = converter.forward([x, y]);
      if (!isFinite(lon) || !isFinite(lat)) {
        throw new Error(`proj4 transform produced a non-finite coordinate at point ${i}: x=${x}, y=${y}`);
      }
    } else {
      lon = x;
      lat = y;
    }
    const alt = z * zFactor + geoidOffset;
    const [ecefX, ecefY, ecefZ] = lonLatAltToEcef(lon, lat, alt);

    if (i === 0) {
      ox = ecefX;
      oy = ecefY;
      oz = ecefZ;
    }

    const i3 = i * 3;
    positions[i3] = ecefX - ox;
    positions[i3 + 1] = ecefY - oy;
    positions[i3 + 2] = ecefZ - oz;

    const cls = getCls ? getCls(i) & 0xff : 0;
    classifications[i] = cls;

    if (getIntensity) {
      const raw = Math.max(0, Math.min(65535, Math.round(getIntensity(i))));
      intensities[i] = raw;
      if (raw > maxIntensity) maxIntensity = raw;
    }

    elevations[i] = Math.max(0, Math.min(65535, Math.round((z - zMin) * zScale)));

    const i4 = i * 4;
    if (hasRGB && rgbRaw) {
      colors[i4] = clamp255((rgbRaw[i3] / colorScale) * 255);
      colors[i4 + 1] = clamp255((rgbRaw[i3 + 1] / colorScale) * 255);
      colors[i4 + 2] = clamp255((rgbRaw[i3 + 2] / colorScale) * 255);
    } else if (getCls) {
      const [r, g, b] = CLASSIFICATION_COLORS[cls] ?? DEFAULT_CLASS_COLOR;
      colors[i4] = r;
      colors[i4 + 1] = g;
      colors[i4 + 2] = b;
    } else {
      colors[i4] = FLAT_COLOR[0];
      colors[i4 + 1] = FLAT_COLOR[1];
      colors[i4 + 2] = FLAT_COLOR[2];
    }
    colors[i4 + 3] = 255;
  }

  return { positions, origin: [ox, oy, oz], colors, intensities, classifications, elevations, pointCount: n, maxIntensity };
}

self.onmessage = async (e: MessageEvent<WorkerRequest | WorkerCancelRequest>) => {
  const data = e.data;
  // Nothing left to abort in here: the node's bytes are already fetched by
  // the time a task reaches a worker, so a decode in progress just runs to
  // completion. WorkerPool still frees the caller immediately for a task
  // that hasn't been dispatched yet (see WorkerPool._cancel's queue branch);
  // for one already running, CopcDataSource simply leaves the (now unwanted)
  // result hidden rather than adding it to the scene.
  if ('cancel' in data) return;

  const { id, payload } = data;
  try {
    const result = await convertNode(payload as NodeConversionPayload);
    postMessage({ id, result } satisfies WorkerResponse, [
      result.positions.buffer,
      result.colors.buffer,
      result.intensities.buffer,
      result.classifications.buffer,
      result.elevations.buffer,
    ]);
  } catch (err) {
    const error = err as Error;
    postMessage({ id, error: { name: error.name, message: error.message } } satisfies WorkerResponse);
  }
};
