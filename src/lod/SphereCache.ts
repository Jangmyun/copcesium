/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * LRU cache of per-node bounding spheres, shared by LoD selection, load
 * ordering, visibility culling, picking and loading.
 */
import type * as Cesium from 'cesium';
import { getNodeBoundingSphere, type ProjectToCartesian } from './boundingVolume';

// Bounds the cache independently of `maxCacheNodes`: every candidate the
// selectNodes() pass touches while walking the hierarchy gets a sphere
// computed, not just currently-loaded/visible nodes, so this cache sees a much
// larger working set per LoD pass than NodeCache does. Sized generously above
// the default `maxCacheNodes` (150) to comfortably hold a pass's candidates
// without thrashing.
export const MAX_SPHERE_CACHE_SIZE = 5000;

export class SphereCache {
  private readonly _cache = new Map<string, Cesium.BoundingSphere>();

  constructor(
    private readonly _rootCenter: { x: number; y: number; z: number },
    private readonly _rootHalfSize: number,
    private readonly _project: ProjectToCartesian,
    private readonly _xyFactor: number,
  ) {}

  /** The backing map, read by tests that check eviction. */
  get entries(): ReadonlyMap<string, Cesium.BoundingSphere> {
    return this._cache;
  }

  /** LRU-cached, capped at `MAX_SPHERE_CACHE_SIZE`. Unlike `NodeCache`, no
   *  pinning is needed: a `Cesium.BoundingSphere` is pure arithmetic (no I/O,
   *  no GPU work), so evicting even a currently-visible node's sphere is
   *  safe — it's simply recomputed on the next call. */
  get(key: string): Cesium.BoundingSphere {
    const cached = this._cache.get(key);
    if (cached) {
      // Bump recency: delete + re-insert moves this key to the end of the
      // Map's iteration order, which the eviction below relies on.
      this._cache.delete(key);
      this._cache.set(key, cached);
      return cached;
    }
    const sphere = getNodeBoundingSphere(key, this._rootCenter, this._rootHalfSize, this._project, this._xyFactor);
    this._cache.set(key, sphere);
    if (this._cache.size > MAX_SPHERE_CACHE_SIZE) {
      // Iterates in insertion (= least-recently-used-first) order.
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) this._cache.delete(oldestKey);
    }
    return sphere;
  }

  /** `get` without the LRU bump, for the per-frame visibility pass:
   *  re-inserting up to 100 keys every frame is pure churn when nothing is
   *  being evicted. Falls back to `get` on a miss so it still caches. */
  peek(key: string): Cesium.BoundingSphere {
    return this._cache.get(key) ?? this.get(key);
  }
}
