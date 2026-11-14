/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import type * as Cesium from 'cesium';
import type { FetchWaste } from './copc/TransferCounter';
import type { PointCloudPrimitive } from './renderer/PointCloudPrimitive';
import type { WorkerPoolTiming } from './worker/WorkerPool';

/** See `CopcStats.cache`. */
export interface CacheStats {
  /** Nodes held, on screen or not. */
  nodes: number;
  /** `pointCount × 21` summed over them: the figure `maxCacheBytes` limits.
   *  Nodes decoded but not yet drawn hold this in JS memory, drawn ones on
   *  the GPU. */
  estimatedBytes: number;
  /** Nodes on screen, which eviction skips; the budget can be exceeded by
   *  these alone. */
  pinned: number;
  /** Nodes evicted to stay within budget since load. */
  evictions: number;
}

/** See `CopcStats.decodeQueue`. */
export interface DecodeQueueStats extends WorkerPoolTiming {
  /** Visible nodes held back by `decodeBackpressure`, waiting to be started. */
  deferredLoads: number;
}

export type { FetchWaste };

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

/**
 * How `gl_PointSize` is computed. `'fixed'` (the historical default) draws
 * every point at `pixelSize` regardless of distance. `'attenuated'` scales
 * size down with camera distance — `attenuationFactor / sqrt(dist_m)`,
 * clamped to `[minPixelSize, maxPixelSize]` — so points stay dense near the
 * camera without inflating (and overdrawing) distant, already-dense nodes.
 */
export type PointSizeMode = 'fixed' | 'attenuated';

/**
 * Which side of the clip regions is drawn. `'inside'` keeps points that are
 * on the kept side of every `clipPlanes` plane and inside at least one
 * `clipBoxes` box; `'outside'` keeps everything else.
 */
export type ClipMode = 'inside' | 'outside';

/** Public options for CopcDataSource */
export interface CopcDataSourceOptions {
  proj?: string;
  projDef?: string | null;
  geoidOffset?: number;
  /**
   * Worker pool size — how many nodes decode at once. Also the default for
   * `maxConcurrentRequests`. `'auto'` sizes it from the device:
   * `navigator.hardwareConcurrency − 1` (one core left for the page and
   * rendering), kept between 2 and 5. Default `5`.
   */
  concurrency?: number | 'auto';
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
  /**
   * Merge node Range Requests across small gaps when requests are queueing,
   * sizing the gap from the link itself: measured time to first byte times
   * the link's download rate divided by `maxConcurrentRequests` (≈ RTT ×
   * bandwidth ÷ concurrent requests), clamped to 0–256 KiB. Bridging a gap downloads bytes no node needs to save
   * one request, which pays on a fast, high-latency link and costs on a slow
   * one; a fixed gap gets one of the two wrong. Default `false` (merge only
   * contiguous ranges).
   */
  adaptiveMergeGap?: boolean;
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
  /** How `gl_PointSize` is computed. Default `'fixed'`. */
  pointSizeMode?: PointSizeMode;
  /**
   * Numerator of the attenuated-size formula (`attenuationFactor / sqrt(dist_m)`),
   * in pixel*sqrt(meters). Only used when `pointSizeMode` is `'attenuated'`.
   * Default `100`; tune per dataset density.
   */
  attenuationFactor?: number;
  /** Lower clamp (pixels) for attenuated point size. Default `1`. */
  minPixelSize?: number;
  /** Upper clamp (pixels) for attenuated point size. Default `6`. */
  maxPixelSize?: number;
  sseThreshold?: number;
  /**
   * Widens the region considered for prefetching beyond the actual display
   * frustum: candidate nodes here are loaded and cached, but not rendered,
   * ahead of the camera panning over them. Multiplies the frustum's
   * near-plane projected width and height by this factor (not the raw
   * field-of-view angle — see `getExpandedCullingVolume`). Set to `1` (or
   * less) to disable prefetching. Default `1.8`.
   */
  prefetchFrustumFactor?: number;
  /**
   * Caps how many prefetch-only candidates a single LoD pass may load,
   * independent of `maxVisibleNodes`/`maxPoints` (which continue to bound
   * only the render set). Ignored when `prefetchFrustumFactor` disables
   * prefetching. Default `50`.
   */
  maxPrefetchNodes?: number;
  /**
   * Holds prefetch back until every load for the current view has finished,
   * instead of only until they have all been dispatched. Worth turning on
   * for slow links, where prefetch bytes delay the visible ones. Default
   * `false`.
   */
  prefetchIdleOnly?: boolean;
  /**
   * Stops starting new node downloads while the CPU is the bottleneck: once a
   * full round of decoding (one task per worker) is already waiting for a
   * worker, further nodes of the view are held back and started as decodes
   * finish, prefetch waits until the decode queue is empty, and prefetched
   * nodes decode after visible ones. Meant for slow devices, where LAZ
   * decoding — not the link — limits how fast a view fills in. With
   * `prefetchIdleOnly` also on, prefetch waits for both conditions. Default
   * `false`.
   */
  decodeBackpressure?: boolean;
  /**
   * Re-applies `maxCacheNodes`/`maxCacheBytes` after every LoD pass, not only
   * when a node is inserted, so nodes that just left the screen are evicted
   * right away if the cache is over budget. Default `false`.
   */
  strictCacheBudget?: boolean;
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
  /**
   * Clipping planes in world (ECEF) coordinates, at most 6. A point is on a
   * plane's kept side when `Cesium.Plane.getPointDistance(plane, point) >= 0`
   * — i.e. the side the normal points to; `Cesium.Plane.fromPointNormal`
   * builds one from a point on it. Tested against the drawn position, after
   * `heightOffset`.
   */
  clipPlanes?: Cesium.Plane[];
  /**
   * Clipping boxes, at most 4. Each matrix maps the unit cube
   * `[-0.5, 0.5]^3` to world (ECEF) coordinates — e.g.
   * `Matrix4.multiplyByScale(Transforms.eastNorthUpToFixedFrame(center),
   * dimensions, new Matrix4())` for an axis-aligned local box. Boundaries
   * count as inside.
   */
  clipBoxes?: Cesium.Matrix4[];
  /** Which side of `clipPlanes`/`clipBoxes` to draw. Default `'inside'`. */
  clipMode?: ClipMode;
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
  /**
   * Set when the CRS was recognised but positions may still be wrong, e.g. a
   * datum whose shift to WGS84 neither the WKT nor the local EPSG table
   * gives, which proj4 then applies as no shift at all (hundreds of meters
   * for Tokyo, Korean 1985, DHDN). `CopcDataSource.load()` logs it.
   */
  warning?: string;
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
  /**
   * The decode stage's queue, to tell a CPU-bound session (nodes wait for a
   * worker: `waiting` stays high, `waitP50` grows past `runP50`) from a
   * network-bound one (workers wait for nodes). `decode` timings below
   * include the queue wait; `runP50` is the worker's own time alone.
   */
  decodeQueue: DecodeQueueStats;
  /** The decoded-node cache against its `maxCacheNodes`/`maxCacheBytes` budget. */
  cache: CacheStats;
  /** Node point-data fetches that were aborted, failed or retried, and bytes
   *  received that no node used — what `transferredBytes` leaves out. */
  waste: FetchWaste;
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

/**
 * Result of `CopcDataSource.pickPoint()`. `nodeKey`/`pointIndex` identify the
 * point within the currently-loaded hierarchy — they are only meaningful
 * while that node stays resident; once evicted from the cache (or replaced by
 * a LoD transition), the same indices may point at different data or nothing
 * at all, so don't persist them across a reload or a long idle period.
 */
export interface PickedPoint {
  /** Octree key of the node the point belongs to, e.g. `"2-1-0-3"`. */
  nodeKey: string;
  /** Index of the point within its node's buffers (`gl_VertexID` at draw time). */
  pointIndex: number;
  /** World-space (ECEF) position, including the live `heightOffset` shift. */
  position: Cesium.Cartesian3;
  /** Raw LAS classification code (0-255). */
  classification: number;
  /** Raw LAS intensity, or 0 for a file with no such dimension. */
  intensity: number;
}
