import type { PointCloudPrimitive } from './renderer/PointCloudPrimitive';

/**
 * How a point's colour is chosen.
 *
 * `'rgb'` uses the file's own colour, falling back per point to the
 * classification palette and then to flat grey when the file carries no
 * Red/Green/Blue — this is the historical (and default) behaviour.
 * `'classification'` applies the palette unconditionally, so it works on a
 * file that *does* have RGB too.
 */
export type ColorMode = 'rgb' | 'intensity' | 'classification' | 'elevation';

/** Public options for CopcDataSource */
export interface CopcDataSourceOptions {
  proj?: string;
  projDef?: string | null;
  geoidOffset?: number;
  /**
   * Worker pool size — how many nodes decode at once. Also the default for
   * `maxConcurrentRequests`. Default `5`.
   */
  concurrency?: number;
  /**
   * How many HTTP Range Requests may be in flight at once. Defaults to
   * `concurrency`, which is how the two were fused before they could be set
   * apart.
   *
   * They bound stages with different shapes. Decoding is CPU-bound and
   * saturates at a handful of workers; fetching is latency-bound, so a
   * high-RTT link keeps far more requests usefully in flight than there are
   * cores. Raising `concurrency` to buy fetch parallelism also spawns that
   * many workers, each carrying its own laz-perf WASM instance, which is
   * memory spent on a stage that was never the bottleneck.
   */
  maxConcurrentRequests?: number;
  debounceMs?: number;
  maxCacheNodes?: number;
  /**
   * Bounds the node cache by memory too, on top of `maxCacheNodes`: a node's
   * size is `pointCount * 21` bytes, the fixed per-point layout (`positions`
   * 12B + `colors` 4B + `intensities` 2B + `classifications` 1B +
   * `elevations` 2B). Omit for no byte-based limit, since a sensible default
   * depends on the dataset's typical points-per-node.
   */
  maxCacheBytes?: number;
  maxVisibleNodes?: number;
  /**
   * Bounds the render set by total point count across selected nodes, on top
   * of `maxVisibleNodes`. Default 5,000,000.
   */
  maxPoints?: number;
  pixelSize?: number;
  sseThreshold?: number;
  /** Factor that converts the Z axis unit to meters. Auto-detected from the WKT when omitted. */
  zFactor?: number;
  /** Factor that converts the XY axis unit to meters. Auto-detected from the WKT when omitted. */
  xyFactor?: number;
  /** Whether `load()` flies the camera to the loaded dataset before resolving. Default true. */
  autoFrame?: boolean;
  /** How points are coloured. Default `'rgb'`. Switching costs no refetch. */
  colorMode?: ColorMode;
  /**
   * Alpha multiplier applied to every point's colour, 0..1. Default `1`
   * (opaque). Below `1`, the primitive switches to alpha blending with no
   * per-point depth sort, so overlapping points may blend out of order.
   */
  opacity?: number;
  /**
   * Classification codes (0-255) to draw; every other point is dropped in the
   * vertex shader. Omit to draw everything.
   */
  classificationFilter?: number[];
  /**
   * Raw LAS intensity values mapped to the two ends of the `'intensity'` ramp.
   * Omitted, the range grows to `[0, highest intensity seen so far]` as nodes
   * stream in — LAS producers rarely use the full 16-bit span, so a fixed
   * 0-65535 mapping would render most files nearly black.
   */
  intensityRange?: [number, number];
}

/** Result of auto-detecting a CRS from a WKT VLR */
export interface CrsDetectionResult {
  /** CRS name registered with proj4 (EPSG:xxxx or CRS:<url-based identifier>) */
  proj: string;
  /** Original definition string registered via proj4.defs (null for a geographic CRS) */
  projDef: string | null;
  /** Factor that converts the Z axis unit to meters */
  zFactor: number;
  /** Factor that converts the XY axis unit to meters */
  xyFactor: number;
}

/**
 * Rendering-ready TypedArray buffers the Worker hands back to the main thread.
 *
 * `colors` stays baked (RGB, else the classification palette, else grey) so
 * `colorMode: 'rgb'` costs nothing on the GPU; the other three modes are
 * computed in the vertex shader from the raw attributes below, which is what
 * lets a mode change be a uniform update rather than a re-decode.
 */
export interface NodeRenderData {
  /** Point positions as Float32 offsets from `origin`, in ECEF meters. */
  positions: Float32Array;
  /** ECEF origin (double precision) the positions are relative to; carried in the primitive's model matrix. */
  origin: [number, number, number];
  colors: Uint8Array;
  /** Raw LAS `Intensity`, or all zeroes when the file has no such dimension. */
  intensities: Uint16Array;
  /** Raw LAS `Classification`, or all zeroes when the file has no such dimension. */
  classifications: Uint8Array;
  /**
   * Point Z normalized over the file header's full Z range, so the elevation
   * ramp needs no uniform and costs 2 bytes per point instead of a full
   * float. Zero throughout when the header reports a flat dataset.
   */
  elevations: Uint16Array;
  pointCount: number;
  /** Highest raw `Intensity` in this node; feeds the auto `intensityRange`. */
  maxIntensity: number;
}

/** Latency distribution for one stage of the per-node load pipeline. */
export interface StageTiming {
  /** Nodes that completed this stage since load. Unbounded — unlike the
   *  window the percentiles below are drawn from. */
  count: number;
  /** Median and 95th percentile, in milliseconds, over a rolling window of
   *  recent nodes. Percentiles rather than a mean because the two failure
   *  shapes differ: one pathological node and a uniformly slow pipeline
   *  average the same but call for different fixes. */
  p50: number;
  p95: number;
}

/**
 * What one data source has spent, for measuring the streaming claim rather
 * than asserting it. Read from `dataSource.stats`.
 */
export interface CopcStats {
  /** Total size of the COPC file, read from a range response's
   *  `Content-Range` — the whole point of comparison for `transferredBytes`. */
  fileBytes: number;
  /** HTTP range responses received, counting merged fetches once (#86). */
  requestCount: number;
  /** Bytes actually received across every path: the Range-support probe, the
   *  header, hierarchy pages, and node point data. */
  transferredBytes: number;
  /** Nodes currently in flight — fetching, decoding, or uploading. Zero means
   *  the current view is fully resolved, which is the only externally visible
   *  signal a benchmark can use to know when to stop the clock. */
  pendingNodes: number;
  /** Waiting on the network for a node's compressed point data. */
  fetch: StageTiming;
  /** LAZ decode plus coordinate transform, in a worker. */
  decode: StageTiming;
  /** Creating the node's GPU vertex buffers and shader, measured on the first
   *  frame it is drawn — that is when a rendering context exists. A node that
   *  is decoded but never shown (the camera moved on, or it lost a budget cut)
   *  never reaches the GPU, so `upload.count` trails `decode.count` by however
   *  many of those the session accumulated. That gap is information, not a
   *  dropped sample. */
  upload: StageTiming;
}

/** A node built into a Cesium Primitive, ready to be added to the Scene */
export interface LoadedNode {
  key: string;
  primitive: PointCloudPrimitive;
  pointCount: number;
}
