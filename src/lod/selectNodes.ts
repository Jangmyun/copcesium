/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun), 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * LoD stage. Walks the loaded octree on each (debounced) LoD pass, deciding
 * which nodes are visible and worth their screen-space error given the
 * current camera, and returns the set `CopcDataSource` should have loaded
 * and rendered next.
 */
import * as Cesium from 'cesium';
import type { Hierarchy } from 'copc';
import {
  getCullingVolume,
  getExpandedCullingVolume,
  isInFrustum,
  type CameraPose,
  type CameraView,
} from './boundingVolume';
import { viewAlignment } from './loadOrder';
import { computeScreenSpaceError, getFovy, sseScale } from './screenSpaceError';

/**
 * Max-heap ordered by `score`. Expands the highest screen-space-error node
 * first, so once `maxVisibleNodes` is hit, the nodes that already made it
 * into `selected` are the most visually important ones found so far, rather
 * than whatever a FIFO traversal order happened to reach first — a plain
 * queue makes the budget cutoff arbitrary, and (worse) makes the exact same
 * on-screen region flicker in and out as camera noise reshuffles the
 * insertion order pass to pass.
 */
interface HeapEntry {
  key: string;
  d: number;
  x: number;
  y: number;
  z: number;
  priority: number;
  /** Bounding sphere and raw SSE, computed once when pushed (absent on the root, filled at pop). */
  sphere?: Cesium.BoundingSphere;
  sse?: number;
}

class MaxHeap {
  private readonly data: HeapEntry[] = [];

  get size(): number {
    return this.data.length;
  }

  push(item: HeapEntry): void {
    const d = this.data;
    d.push(item);
    let i = d.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = d[parent];
      if (p.priority >= item.priority) break;
      d[i] = p;
      i = parent;
    }
    d[i] = item;
  }

  pop(): HeapEntry | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0];
    const last = d.pop()!;
    if (d.length > 0) {
      let i = 0;
      const n = d.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let largest = i;
        let best = last.priority;
        if (l < n && d[l].priority > best) {
          largest = l;
          best = d[l].priority;
        }
        if (r < n && d[r].priority > best) largest = r;
        if (largest === i) break;
        d[i] = d[largest];
        i = largest;
      }
      d[i] = last;
    }
    return top;
  }
}

export interface SelectNodesOptions {
  nodes: Hierarchy.Node.Map;
  /**
   * Sub-page entry points not yet merged into `nodes`. A child key found
   * here instead of in `nodes` is a node whose subtree lives in a hierarchy
   * page that hasn't been loaded yet, not a childless node.
   */
  pages?: Hierarchy.Page.Map;
  /**
   * Called (possibly more than once per pass) with the key of a sub-page
   * whose subtree is needed but not yet loaded. The traversal doesn't wait
   * for it — the caller is expected to load it asynchronously and re-run
   * selection once it's merged into `nodes`.
   */
  onPageNeeded?: (key: string) => void;
  /**
   * Returns (and, per the caller's discretion, caches) a node's bounding
   * sphere. Pulled out as a callback rather than raw ingredients
   * (rootCenter/rootHalfSize/project/xyFactor) so a caller can memoize per
   * key instead of recomputing a proj4 transform for every node on every
   * selection pass.
   */
  getSphere: (key: string) => Cesium.BoundingSphere;
  camera: CameraView;
  viewportHeight: number;
  sseThreshold: number;
  maxVisibleNodes: number;
  /**
   * Bounds the render set by total point count across selected nodes, on top
   * of `maxVisibleNodes`. Node point counts vary widely across a hierarchy,
   * so `maxVisibleNodes` alone can't predict actual rendering cost (draw
   * calls, GPU memory, points on screen) across datasets with different
   * point densities per node; this bounds that directly. Defaults to
   * unlimited (`maxVisibleNodes` alone governs) when omitted.
   */
  maxPoints?: number;
  /**
   * Widens the region considered for prefetching beyond the actual display
   * frustum, so nodes just off-screen are already cached by the time a pan
   * reveals them (#212). Multiplies the frustum's near-plane projected width
   * and height by this factor — see `getExpandedCullingVolume`. Omitted, or
   * `<= 1`, disables prefetching: no expanded frustum is computed and
   * `onPrefetchCandidate` is never called.
   */
  prefetchFrustumFactor?: number;
  /**
   * Caps how many prefetch-only candidates one pass reports through
   * `onPrefetchCandidate`, independent of `maxVisibleNodes`/`maxPoints`
   * (which continue to bound only the render set). Ignored when
   * `prefetchFrustumFactor` is unset. Defaults to 50.
   */
  maxPrefetchNodes?: number;
  /**
   * Called once per prefetch-only candidate: a populated node inside the
   * expanded prefetch region but outside the actual display frustum. Never
   * added to the returned selection — the caller decides whether/how to load
   * and cache it ahead of time.
   */
  onPrefetchCandidate?: (key: string) => void;
  /**
   * Where the camera is expected to be a short moment from now. When set, the
   * prefetch region is the expanded frustum placed at this pose, the prefetch
   * screen-space error is measured from its eye, and candidates are reported
   * nearest to that eye first (instead of in traversal order). The visible
   * selection still uses `camera`. Unset: prefetch is built around `camera`.
   */
  predictedPose?: CameraPose;
  /**
   * Keys currently on screen. Their heap priority is multiplied by
   * `incumbentBonus`, so when a budget cuts the traversal mid-heap, a visible
   * node is only displaced by a candidate that is clearly better rather than
   * one that merely edges ahead on camera noise. Without this, the nodes
   * straddling the cut swap places on almost every pass while the camera
   * moves, and the same patch of ground pulses in and out of detail (#192).
   * Only the traversal order is affected — the SSE threshold test still uses
   * the raw value.
   */
  incumbents?: ReadonlySet<string>;
  /** Priority multiplier for `incumbents`. Defaults to 1 (no bonus). */
  incumbentBonus?: number;
  /**
   * How far the centre of the view outranks its corners when a budget cuts the
   * traversal: heap priority is scaled from `1 + viewAxisBias` on the view axis
   * down to 1 at the screen corner and beyond. Screen-space error only knows
   * how near a node is, so looking out at a shallow angle would otherwise spend
   * the budget on the ground under the camera before the distant middle of the
   * screen, whose error barely clears the threshold. Only the traversal order
   * is affected — the SSE threshold test still uses the raw value, so a view
   * that fits the budget selects the same nodes. Defaults to 0 (no bias).
   */
  viewAxisBias?: number;
  /**
   * Whether clipping discards every point a node's sphere can hold. Such a
   * node is dropped with its subtree, like one outside the frustum, so it
   * costs no fetch, decode or budget (#228). Children sit inside their
   * parent's sphere, so a clipped-away parent never hides a kept child.
   */
  isClippedAway?: (sphere: Cesium.BoundingSphere) => boolean;
}

/**
 * Traverses the COPC octree starting at the root key ("0-0-0-0"), expanding
 * the highest screen-space-error node first, and returns the set of node
 * keys to render for the current camera view.
 *
 * Every node the traversal visits is selected, not just the ones it stops at.
 * A COPC octree stores each point in exactly one node, so a node's points are
 * not a coarse copy of its children's — they are distinct points interleaved
 * through the same volume, and the cloud the user sees is the union of the
 * root down through the current cut. Selecting only the frontier would
 * silently drop everything held above it (19% of `autzen-classified`, 55% of
 * `redrocks.small`). A node is expanded further when its projected
 * screen-space error exceeds `sseThreshold`; children add detail on top of it
 * rather than replacing it.
 *
 * A node with zero points is never selected — it holds nothing to draw — but
 * is still expanded regardless of SSE so its populated children are reached.
 * Nodes outside the view frustum are dropped along with their whole subtree,
 * unless `prefetchFrustumFactor` is set, in which case nodes outside the
 * actual frustum but inside the wider prefetch region are reported through
 * `onPrefetchCandidate` instead of being dropped or selected (#212).
 *
 * `maxVisibleNodes` and `maxPoints` both bound the whole render set, ancestors
 * included, terminating on whichever limit is hit first. Since a parent is
 * always popped before its children are pushed, the budget can only ever cut
 * depth off the bottom, never leave a descendant selected without the
 * ancestors it sits on top of.
 */
export function selectNodes(options: SelectNodesOptions): string[] {
  const {
    nodes,
    pages = {},
    onPageNeeded,
    getSphere,
    camera,
    viewportHeight,
    sseThreshold,
    maxVisibleNodes,
    maxPoints = Infinity,
    prefetchFrustumFactor,
    maxPrefetchNodes = 50,
    onPrefetchCandidate,
    predictedPose,
    incumbents,
    incumbentBonus = 1,
    viewAxisBias = 0,
    isClippedAway,
  } = options;

  const cullingVolume = getCullingVolume(camera);
  const prefetchFactor = prefetchFrustumFactor ?? 1;
  const prefetchEnabled = prefetchFactor > 1;
  // Computed once per pass, up front, rather than lazily on first use: the
  // camera is the same for every node this pass considers, so there's
  // nothing to gain from deferring it, and doing so up front keeps the
  // per-node branch below a plain frustum test.
  const expandedCullingVolume = prefetchEnabled
    ? getExpandedCullingVolume(camera, prefetchFactor, predictedPose)
    : undefined;
  const fovy = getFovy(camera.frustum);
  const selected: string[] = [];
  let pointsUsed = 0;
  let prefetchCount = 0;

  // `positionWC`, not `position` — the latter is relative to `camera.transform`
  // and goes local the moment anything calls `camera.lookAt()`, which would
  // measure every node's screen-space error against the wrong viewpoint.
  const scale = sseScale(viewportHeight, fovy);
  const sseOf = (sphere: Cesium.BoundingSphere): number =>
    computeScreenSpaceError(sphere, camera.positionWC, viewportHeight, fovy, scale);

  // Prefetch candidates are measured from the predicted eye, when there is one.
  const prefetchEye = predictedPose?.positionWC ?? camera.positionWC;
  const prefetchSseOf = (sphere: Cesium.BoundingSphere): number =>
    computeScreenSpaceError(sphere, prefetchEye, viewportHeight, fovy, scale);
  // Only filled with a predicted pose: candidates are then sorted before they are reported.
  const ranked: { key: string; distance: number }[] = [];

  // The angle from the view axis to a corner of the screen.
  const aspectRatio =
    camera.frustum instanceof Cesium.PerspectiveFrustum ? (camera.frustum.aspectRatio ?? 1) : 1;
  const tanHalfFovy = Math.tan(fovy / 2);
  const halfDiagonal = Math.atan(Math.hypot(tanHalfFovy, tanHalfFovy * aspectRatio));

  const viewAxisFactor = (sphere: Cesium.BoundingSphere): number => {
    if (viewAxisBias === 0) return 1;
    const alignment = viewAlignment(sphere.center, camera.positionWC, camera.directionWC);
    return 1 + viewAxisBias * Math.max(0, 1 - Cesium.Math.acosClamped(alignment) / halfDiagonal);
  };

  const heap = new MaxHeap();
  // The root's priority never matters — it's the only entry until popped.
  heap.push({ key: '0-0-0-0', d: 0, x: 0, y: 0, z: 0, priority: Infinity });

  const expandChildren = (entry: HeapEntry): void => {
    // Child order: x varies fastest, then y, then z.
    const nd = entry.d + 1;
    const nx = entry.x * 2;
    const ny = entry.y * 2;
    const nz = entry.z * 2;
    for (let i = 0; i < 8; i++) {
      const cx = nx + (i & 1);
      const cy = ny + ((i >> 1) & 1);
      const cz = nz + (i >> 2);
      const childKey = `${nd}-${cx}-${cy}-${cz}`;
      if (nodes[childKey]) {
        const sphere = getSphere(childKey);
        const sse = sseOf(sphere);
        heap.push({
          key: childKey,
          d: nd,
          x: cx,
          y: cy,
          z: cz,
          priority: (incumbents?.has(childKey) ? sse * incumbentBonus : sse) * viewAxisFactor(sphere),
          sphere,
          sse,
        });
      } else if (pages[childKey]) {
        onPageNeeded?.(childKey);
      }
    }
  };

  for (;;) {
    const visibleBudgetLeft = selected.length < maxVisibleNodes && pointsUsed < maxPoints;
    const prefetchBudgetLeft = prefetchEnabled && prefetchCount < maxPrefetchNodes;
    // Once the visible render set is full, the traversal used to stop
    // outright. Now it keeps going — bounded by its own budget — purely to
    // discover prefetch candidates in the expanded region; an onscreen node
    // popped after the visible budget is spent is still dropped below, same
    // as before.
    if (heap.size === 0 || (!visibleBudgetLeft && !prefetchBudgetLeft)) break;

    const entry = heap.pop()!;
    const key = entry.key;
    const nodeInfo = nodes[key];
    if (!nodeInfo) continue;

    const sphere = entry.sphere ?? getSphere(key);
    // Nothing of this subtree would be drawn, on screen or after a pan.
    if (isClippedAway?.(sphere)) continue;
    const onscreen = isInFrustum(sphere, cullingVolume);

    if (!onscreen) {
      // Outside the actual frustum. Only worth descending into at all when
      // it's still inside the wider prefetch region; otherwise this whole
      // subtree is irrelevant, same as the original frustum cull.
      if (!prefetchEnabled || !isInFrustum(sphere, expandedCullingVolume!)) continue;
      if (!prefetchBudgetLeft) continue; // prefetch budget spent; prune the subtree

      if (nodeInfo.pointCount > 0) {
        if (predictedPose) {
          ranked.push({
            key,
            distance: Cesium.Cartesian3.distance(sphere.center, prefetchEye),
          });
        } else {
          onPrefetchCandidate?.(key);
        }
        prefetchCount++;
      }
      // Same empty-node/SSE expansion rule as the onscreen branch below, so a
      // prefetched node ends up at roughly the LOD it would render at once
      // panned into view, not an arbitrarily coarse one.
      const prefetchSse = predictedPose ? prefetchSseOf(sphere) : (entry.sse ?? sseOf(sphere));
      if (nodeInfo.pointCount > 0 && prefetchSse <= sseThreshold) continue;
      expandChildren(entry);
      continue;
    }

    if (!visibleBudgetLeft) continue; // visible budget spent; drop this (and its subtree)

    if (nodeInfo.pointCount > 0) {
      selected.push(key);
      pointsUsed += nodeInfo.pointCount;
    }

    // An empty node is descended through regardless of SSE — it contributes
    // nothing itself, so its populated children are the only way to fill the
    // volume it covers.
    if (nodeInfo.pointCount > 0 && (entry.sse ?? sseOf(sphere)) <= sseThreshold) continue;

    expandChildren(entry);
  }

  if (predictedPose) {
    ranked.sort((a, b) => a.distance - b.distance);
    for (const { key } of ranked) onPrefetchCandidate?.(key);
  }

  return selected;
}
