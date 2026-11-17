/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Decides which nodes get fetched and decoded, and when: the loads for the
 * current selection, the prefetch of nodes just outside the frustum, the
 * decode-backpressure deferral, and the cancellation of loads the camera has
 * moved past. Each load runs fetch, then decode, then GPU upload, and lands
 * in the node cache. `CopcDataSource` calls in once per LoD pass.
 */
import type * as Cesium from 'cesium';
import type { Copc, Hierarchy } from 'copc';
import type { NodeCache } from '../cache/NodeCache';
import type { RangeFetcher } from '../copc/RangeFetcher';
import type { CopcDataSourceOptions, NodeRenderData } from '../types';
import { StageTimer } from '../util/StageTimer';
import type { StyleController } from '../renderer/StyleController';
import type { WorkerPool } from '../worker/WorkerPool';
import type { NodeConversionPayload } from '../worker/messages';
import { createNodePrimitive } from './loadNode';

// Below the default 0 visible nodes decode at, so under `decodeBackpressure`
// a prefetched node never takes a worker ahead of one on screen.
const PREFETCH_DECODE_PRIORITY = -1;

/** The option fields the scheduler reads; the live options object is passed in. */
export type LoadSchedulerOptions = Required<
  Pick<
    CopcDataSourceOptions,
    'decodeBackpressure' | 'prefetchIdleOnly' | 'proj' | 'projDef' | 'geoidOffset' | 'zFactor'
  >
>;

export interface LoadSchedulerDeps {
  options: LoadSchedulerOptions;
  viewer: Cesium.Viewer;
  copc: Copc;
  nodes: Hierarchy.Node.Map;
  rangeFetcher: RangeFetcher;
  workerPool: WorkerPool;
  nodeCache: NodeCache;
  stages: StageTimer;
  style: StyleController;
  getSphere: (key: string) => Cesium.BoundingSphere;
  isDestroyed: () => boolean;
  /** Whether the current selection includes `key`; read when a node finishes loading. */
  isSelected: (key: string) => boolean;
}

export class LoadScheduler {
  private readonly _pendingKeys = new Set<string>();
  private readonly _cancels = new Map<string, () => void>();
  /** The last LoD pass's selection and prefetch candidates, kept so
   *  `dispatchPrefetch()` can run again when a load finishes. */
  private _wantedKeys = new Set<string>();
  private _prefetchCandidates = new Set<string>();
  /** Under `decodeBackpressure`: loads of `_wantedKeys` held back because the
   *  decode queue was full, in selection order. */
  private _deferredLoads: string[] = [];

  private readonly _o: LoadSchedulerOptions;
  private readonly _viewer: Cesium.Viewer;
  private readonly _copc: Copc;
  private readonly _nodes: Hierarchy.Node.Map;
  private readonly _fetcher: RangeFetcher;
  private readonly _pool: WorkerPool;
  private readonly _cache: NodeCache;
  private readonly _stages: StageTimer;
  private readonly _style: StyleController;
  private readonly _getSphere: (key: string) => Cesium.BoundingSphere;
  private readonly _isDestroyed: () => boolean;
  private readonly _isSelected: (key: string) => boolean;

  constructor(deps: LoadSchedulerDeps) {
    this._o = deps.options;
    this._viewer = deps.viewer;
    this._copc = deps.copc;
    this._nodes = deps.nodes;
    this._fetcher = deps.rangeFetcher;
    this._pool = deps.workerPool;
    this._cache = deps.nodeCache;
    this._stages = deps.stages;
    this._style = deps.style;
    this._getSphere = deps.getSphere;
    this._isDestroyed = deps.isDestroyed;
    this._isSelected = deps.isSelected;
  }

  get pendingCount(): number {
    return this._pendingKeys.size;
  }

  get deferredCount(): number {
    return this._deferredLoads.length;
  }

  isPending(key: string): boolean {
    return this._pendingKeys.has(key);
  }

  /**
   * Records what the pass just decided and starts prefetch. `deferred` and
   * `prefetchCandidates` replace the previous ones, not append: keys the
   * camera has since moved past must not be loaded later just because they
   * were once deferred.
   */
  commit(wanted: Set<string>, deferred: string[], prefetchCandidates: Set<string>): void {
    this._wantedKeys = wanted;
    this._deferredLoads = deferred;
    this._prefetchCandidates = prefetchCandidates;
    this.dispatchPrefetch();
  }

  /**
   * Prefetch candidates never set `show` — they're outside the actual frustum
   * — and only get a request once the visible loads have already claimed
   * their slots, so a pan never waits on prefetch traffic for the detail it
   * needs right now (#212).
   *
   * Claiming slots first is not enough on a link that is bandwidth-bound
   * rather than latency-bound: a prefetch request that starts while visible
   * loads are still downloading takes its share of the bytes, and every
   * visible node arrives that much later. With `prefetchIdleOnly`, prefetch
   * waits until no load for the current selection is still pending, and
   * `load()` calls back here when the last one finishes, so prefetch
   * still runs in the pauses between camera moves without another LoD pass.
   *
   * Every prefetch rule is decided here, in `_prefetchBlocked()`, and the
   * rules only ever add conditions: with both `prefetchIdleOnly` and
   * `decodeBackpressure` on, prefetch waits until *both* the visible loads
   * have finished and the decode queue is empty. Neither option can let
   * prefetch through when the other holds it back.
   */
  dispatchPrefetch(): void {
    if (this._prefetchBlocked()) return;
    const concurrency = this._pool.concurrency;
    const priority = this._o.decodeBackpressure ? PREFETCH_DECODE_PRIORITY : 0;
    for (const key of this._prefetchCandidates) {
      if (this._pendingKeys.size >= concurrency) break;
      if (this._cache.peek(key)) continue;
      if (this._pendingKeys.has(key)) continue;
      void this.load(key, priority);
    }
  }

  /** True while any enabled prefetch rule holds prefetch back. */
  private _prefetchBlocked(): boolean {
    if (this._o.decodeBackpressure && this._pool.backlog > 0) return true;
    if (this._o.prefetchIdleOnly) {
      for (const key of this._pendingKeys) if (this._wantedKeys.has(key)) return true;
    }
    return false;
  }

  /**
   * True when a full round of decoding (one task per worker) is already
   * waiting for a worker. Downloads are then outrunning the CPU: another
   * node fetched now would only wait in the decode queue, holding bandwidth
   * and memory that the next view's nodes could have used, and be cancelled
   * outright if the camera moves on first.
   */
  decodeBound(): boolean {
    return this._pool.backlog >= this._pool.concurrency;
  }

  /** Under decode backpressure, starts deferred loads still wanted by the
   *  current selection, at most as many as the decode queue has room for in
   *  one round, so they go out in one tick and their ranges can still merge. */
  private _drainDeferredLoads(): void {
    let room = this._pool.concurrency - this._pool.backlog;
    while (room > 0 && this._deferredLoads.length > 0) {
      const key = this._deferredLoads.shift()!;
      if (!this._wantedKeys.has(key) || this._cache.peek(key) || this._pendingKeys.has(key)) continue;
      void this.load(key);
      room--;
    }
  }

  /** A load still in flight for a key the camera has since moved past is
   *  decoding data nobody will show; cancel it so its worker slot frees up
   *  for the current selection instead (#86). `newPrefetchKeys` is included
   *  so a pending prefetch load isn't cancelled just for being outside the
   *  actual frustum — that's exactly what makes it a prefetch candidate. */
  cancelStale(newSelectedKeys: Set<string>, newPrefetchKeys: Set<string>): void {
    for (const key of this._pendingKeys) {
      if (!newSelectedKeys.has(key) && !newPrefetchKeys.has(key)) this._cancels.get(key)?.();
    }
  }

  async load(key: string, decodePriority = 0): Promise<void> {
    this._pendingKeys.add(key);
    try {
      // selectNodes() only ever returns keys it found present in the hierarchy nodes.
      const node = this._nodes[key]!;

      // Queued alongside every other node this same the LoD pass() pass just
      // selected — RangeFetcher merges same-tick requests for adjacent byte
      // ranges (exactly what sibling nodes are) into one HTTP request (#86).
      const rangeTask = this._fetcher.fetch(node.pointDataOffset, node.pointDataOffset + node.pointDataLength);
      this._cancels.set(key, rangeTask.cancel);
      const fetchStart = performance.now();
      const compressedBytes = await rangeTask;
      this._stages.record('fetch', fetchStart);
      if (this._isDestroyed()) return;

      const payload: NodeConversionPayload = {
        compressedBytes,
        copc: { header: this._copc.header, eb: this._copc.eb },
        node,
        proj: this._o.proj,
        projDef: this._o.projDef,
        geoidOffset: this._o.geoidOffset,
        zFactor: this._o.zFactor,
        zMin: this._copc.header.min[2],
        zMax: this._copc.header.max[2],
      };
      const transfer = [compressedBytes.buffer];
      // Priority only under decodeBackpressure; otherwise the call is the
      // plain one, so an injected pool sees exactly what it always has.
      const task =
        decodePriority === 0
          ? this._pool.run<NodeRenderData>(payload, transfer)
          : this._pool.run<NodeRenderData>(payload, transfer, undefined, decodePriority);
      this._cancels.set(key, task.cancel);
      const decodeStart = performance.now();
      const renderData = await task;
      this._stages.record('decode', decodeStart);
      if (this._isDestroyed()) return;

      const boundingSphere = this._getSphere(key);
      this._style.growAutoIntensityRange(renderData.maxIntensity);
      // Timed from inside the primitive rather than around this call: the GPU
      // work happens on the first frame the node is drawn, because that is
      // when `frameState.context` exists. Wrapping the constructor measured
      // object allocation and duly reported 0 ms (#194).
      const primitive = await createNodePrimitive(renderData, boundingSphere, this._style.style, (start, end) => {
        if (!this._isDestroyed()) this._stages.record('upload', start, end);
      });
      if (this._isDestroyed()) {
        primitive.destroy();
        return;
      }
      // The selection may have moved on while this node was decoding; only
      // show it if it's still wanted, but keep it cached either way.
      primitive.show = this._isSelected(key);
      this._viewer.scene.primitives.add(primitive);
      this._cache.set(key, { key, primitive, pointCount: renderData.pointCount });
      // Required under `requestRenderMode: true` for the new primitive to actually
      // appear; harmless (no-op) under continuous rendering otherwise.
      this._viewer.scene.requestRender();
    } catch (err) {
      if (this._isDestroyed()) return;
      // Cancelled because the selection moved on (see the deselect loop in
      // the LoD pass) — expected, not a failure worth logging.
      if ((err as Error).name === 'AbortError') return;
      console.error(`[CopcDataSource] Failed to load node "${key}":`, err);
    } finally {
      this._pendingKeys.delete(key);
      this._cancels.delete(key);
      if (!this._isDestroyed()) {
        // A finished (or abandoned) node is room in the decode queue.
        if (this._o.decodeBackpressure) this._drainDeferredLoads();
        // It may also have been the last thing holding prefetch back.
        if (this._o.decodeBackpressure || (this._o.prefetchIdleOnly && this._wantedKeys.has(key))) {
          this.dispatchPrefetch();
        }
      }
    }
  }
}
