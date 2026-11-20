/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Orchestrator and public entry point. A standalone class (not a CesiumJS
 * `DataSource` implementation) that takes a `Viewer` and hooks its own
 * `scene.preRender`/`camera.moveStart`/`camera.moveEnd` listeners; owns the
 * loaded hierarchy, node cache, and per-frame LoD walk, wiring together `hierarchy` (metadata),
 * `RangeFetcher`/`WorkerPool` (fetch + decode), `selectNodes` (LoD), and
 * `PointCloudPrimitive` (rendering) into one coherent stream.
 */
import * as Cesium from 'cesium';
import type { Copc } from 'copc';
import type {
  ClipMode,
  ColorMode,
  CopcDataSourceOptions,
  CopcStats,
  LoadedNode,
  PickedPoint,
  PointSizeMode,
} from './types';
import { loadCopcHierarchy } from './copc/hierarchy';
import { HierarchyPager } from './copc/hierarchyPager';
import { sameView, viewSignature } from './lod/viewSignature';
import { bucketKeysByDepth, findRelevantKeys, type ParsedKey } from './copc/node';
import { RangeFetcher } from './copc/RangeFetcher';
import { StageTimer } from './util/StageTimer';
import type { TransferCounter } from './copc/TransferCounter';
import { resolveCrs } from './crs/resolveCrs';
import { getCullingVolume, isInFrustum, type CameraPose, type ProjectToCartesian } from './lod/boundingVolume';
import { CameraMotionTracker, MAX_PREFETCH_LOOKAHEAD_MS } from './lod/cameraMotion';
import { SphereCache } from './lod/SphereCache';
import { orderForLoading } from './lod/loadOrder';
import { getFovy, sseScale } from './lod/screenSpaceError';
import { selectNodes } from './lod/selectNodes';
import { LoadScheduler } from './loader/LoadScheduler';
import { EyeDomeLighting } from './renderer/EyeDomeLighting';
import { PointPicker } from './renderer/pickPoint';
import { StyleController } from './renderer/StyleController';
import { WorkerPool } from './worker/WorkerPool';
import { NodeCache } from './cache/NodeCache';

// Inlined into a Blob at build time (see vite.config.ts's `worker.format`)
// instead of emitted as a separate chunk with a runtime-constructed URL — a
// consumer's own bundler can't discover or copy an asset it never sees a
// static import for, and a URL baked in at our build time either 404s (file
// never shipped to the consumer's own output) or, once shipped, breaks under
// any deploy path other than the site root. See issue on worker 404s in
// consumer builds.
import CopcWorker from './worker/worker.ts?worker&inline';

export type { ClipMode, ColorMode, CopcDataSourceOptions };

/** Shared by the constructor and the live setter. */
function validateEdlStrength(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`eyeDomeLightingStrength must be a non-negative finite number, got ${value}`);
  }
  return value;
}

/** Shared by the constructor and the live setter. */
function validateEdlRadius(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`eyeDomeLightingRadius must be a positive finite number, got ${value}`);
  }
  return value;
}

/**
 * Options with every defaultable field filled in. `classificationFilter`,
 * `intensityRange`, `maxCacheBytes`, and `maxConcurrentRequests`, and `maxGpuInitsPerFrame` stay optional
 * because their unset state is meaningful — "no filter", "auto-range as nodes
 * arrive", "no byte-based cache limit", and "follow the worker pool's size"
 * aren't expressible as a fixed value. The last one in particular has no
 * constant default: it tracks `concurrency`, which the caller may set, and an
 * externally-supplied `WorkerPool` overrides even that.
 */
type OpenEndedOption =
  | 'classificationFilter'
  | 'intensityRange'
  | 'maxCacheBytes'
  | 'prefetchLookaheadMs'
  | 'maxConcurrentRequests'
  | 'maxGpuInitsPerFrame'
  | 'clipPlanes'
  | 'clipBoxes';

type ResolvedOptions = Required<Omit<CopcDataSourceOptions, OpenEndedOption>> &
  Pick<CopcDataSourceOptions, OpenEndedOption>;

const DEFAULT_OPTIONS: Required<Omit<CopcDataSourceOptions, OpenEndedOption>> = {
  proj: 'EPSG:4326',
  projDef: null,
  geoidOffset: 0,
  concurrency: 5,
  adaptiveMergeGap: true,
  debounceMs: 100,
  maxCacheNodes: 150,
  maxVisibleNodes: 100,
  maxPoints: 5_000_000,
  viewAxisBias: 2,
  prefetchFrustumFactor: 1.8,
  maxPrefetchNodes: 50,
  prefetchIdleOnly: false,
  decodeBackpressure: false,
  strictCacheBudget: false,
  preUploadHidden: false,
  pixelSize: 2,
  pointSizeMode: 'fixed',
  attenuationFactor: 100,
  minPixelSize: 1,
  maxPixelSize: 6,
  sseThreshold: 250,
  zFactor: 1,
  xyFactor: 1,
  autoFrame: true,
  colorMode: 'rgb',
  opacity: 1,
  eyeDomeLighting: false,
  eyeDomeLightingStrength: 1,
  eyeDomeLightingRadius: 1,
  clipMode: 'inside',
  skipIdleLoD: false,
};

// Heap-priority multiplier `selectNodes` gives nodes already on screen while
// the camera moves, so nodes straddling a budget cut stop trading places on
// every pass (#192). Released on `moveEnd`, so the settled selection is exact:
// applied unconditionally it would let the view settle on whatever drifted in
// during the move. 1.05–1.30 all eliminated the flicker in the issue's
// measurements; 1.15 sits in the middle.
const INCUMBENT_BONUS = 1.15;

// Bounds for `concurrency: 'auto'`. The top is today's fixed default, so
// 'auto' never spends more cores than a desktop already gets. The bottom keeps
// one decode running while another node's transfer is handed over, even on a
// device that reports one or two cores. Which value within these bounds is
// best on real phones has not been measured.
const AUTO_WORKERS_MIN = 2;
const AUTO_WORKERS_MAX = 5;
// When the browser doesn't say (or rounds the value down for privacy).
const ASSUMED_CORES = 4;

/** Resolves the `concurrency` option to a worker count. */
export function resolveWorkerCount(
  concurrency: number | 'auto',
  hardwareConcurrency: number | undefined = globalThis.navigator?.hardwareConcurrency,
): number {
  if (concurrency !== 'auto') return concurrency;
  const cores =
    hardwareConcurrency && hardwareConcurrency > 0 ? hardwareConcurrency : ASSUMED_CORES;
  return Math.min(AUTO_WORKERS_MAX, Math.max(AUTO_WORKERS_MIN, cores - 1));
}

export class CopcDataSource {
  private readonly _url: string;
  private readonly _viewer: Cesium.Viewer;
  private readonly _copc: Copc;
  private readonly _pager: HierarchyPager;
  private readonly _counter: TransferCounter;
  private readonly _stages = new StageTimer();
  private readonly _options: ResolvedOptions;
  private readonly _styleCtl: StyleController;
  private readonly _edl: EyeDomeLighting;
  private readonly _nodeCache: NodeCache;
  private readonly _rangeFetcher: RangeFetcher;
  private readonly _workerPool: WorkerPool;
  private readonly _ownsPool: boolean;
  private readonly _scheduler: LoadScheduler;
  private readonly _spheres: SphereCache;
  private _selectedKeys = new Set<string>();
  private _isUpdating = false;
  private _pendingUpdate = false;
  private _lastUpdateTime = 0;
  private _removeUpdateListener: () => void = () => {};
  private _removeMoveEndListener: () => void = () => {};
  private _removeMoveStartListener: () => void = () => {};
  private _cameraMoving = false;
  /** `skipIdleLoD`: set by anything that can change what a pass would decide
   *  (a load settling, a page arriving, an eviction, a setter) and cleared as
   *  a pass starts, so an event during the pass re-arms it. */
  private _lodDirty = true;
  /** The view the last pass ran against; compared on each throttled tick. */
  private _lastViewSignature: number[] = [];
  /** Buffer the next signature is written into; swapped with `_lastViewSignature`
   *  after a pass, so the two are never the same array. */
  private _viewSignatureScratch: number[] = [];
  /** Set when the last pass left work that only a later pass completes: a page
   *  still wanted (its retry rides on rediscovery) or a deselected node held
   *  visible until its replacement is ready. */
  private _lodUnsettled = false;
  /** Feeds the predicted pose for `prefetchLookaheadMs`; unused when it is unset. */
  private readonly _motion = new CameraMotionTracker({ dampTauMs: 150 });
  private _destroyed = false;
  private readonly _picker = new PointPicker();

  private constructor(
    url: string,
    viewer: Cesium.Viewer,
    hierarchy: Awaited<ReturnType<typeof loadCopcHierarchy>>,
    options: ResolvedOptions,
    project: ProjectToCartesian,
    workerPool: WorkerPool,
    ownsPool: boolean,
  ) {
    this._url = url;
    this._viewer = viewer;
    this._copc = hierarchy.copc;
    this._options = options;
    this._spheres = new SphereCache(
      hierarchy.rootCenter,
      hierarchy.rootHalfSize,
      project,
      options.xyFactor,
    );
    this._styleCtl = new StyleController(options, () => this._viewer.scene.requestRender());
    this._edl = new EyeDomeLighting(
      () => this._spheres.drawn('0-0-0-0'),
      options.eyeDomeLighting,
      validateEdlStrength(options.eyeDomeLightingStrength),
      validateEdlRadius(options.eyeDomeLightingRadius),
    );
    this._nodeCache = new NodeCache(
      options.maxCacheNodes,
      (_key, node) => {
        this._lodDirty = true;
        this._destroyLoadedNode(node);
      },
      options.maxCacheBytes,
    );
    this._counter = hierarchy.counter;
    this._pager = new HierarchyPager(
      url,
      hierarchy,
      () => this._destroyed,
      () => {
        this._lodDirty = true;
        void this._updateLoD();
      },
    );
    this._rangeFetcher = new RangeFetcher(
      url,
      undefined,
      undefined,
      // Defaults to the worker pool's size, which keeps fetching from outrunning
      // decoding the way it did before any cap existed (#86) — but is settable
      // on its own, because the two stages saturate at different widths.
      options.maxConcurrentRequests ?? workerPool.concurrency,
      this._counter,
      undefined, // idleTimeoutMs: the fetcher's default
      options.adaptiveMergeGap ? {} : undefined,
    );
    this._workerPool = workerPool;
    this._ownsPool = ownsPool;
    this._scheduler = new LoadScheduler({
      options,
      viewer,
      copc: this._copc,
      nodes: this._pager.nodes,
      rangeFetcher: this._rangeFetcher,
      workerPool,
      nodeCache: this._nodeCache,
      stages: this._stages,
      style: this._styleCtl,
      edl: this._edl,
      // The primitive shifts its own sphere along with its points.
      getSphere: (key) => this._spheres.get(key),
      isDestroyed: () => this._destroyed,
      isSelected: (key) => this._selectedKeys.has(key),
      onSettled: () => {
        this._lodDirty = true;
      },
    });
  }

  /**
   * @param workerPool An externally-owned `WorkerPool` to reuse across data
   *   sources/reloads instead of spinning up (and wasm-recompiling) a fresh
   *   one. When provided, `options.concurrency` is ignored — the pool's own
   *   size wins. `destroy()` never tears down a pool it didn't create.
   */
  static async load(
    url: string,
    viewer: Cesium.Viewer,
    options: CopcDataSourceOptions = {},
    workerPool?: WorkerPool,
  ): Promise<CopcDataSource> {
    const resolved: ResolvedOptions = { ...DEFAULT_OPTIONS, ...options };
    // NaN would otherwise flow into every point's height and blank the cloud
    // with no error.
    if (!Number.isFinite(resolved.geoidOffset)) {
      throw new Error(
        `[CopcDataSource] geoidOffset must be a finite number of meters, got ${resolved.geoidOffset}.`,
      );
    }

    const hierarchy = await loadCopcHierarchy(url);

    const project = resolveCrs(url, hierarchy.copc, options, resolved);

    const pool =
      workerPool ??
      new WorkerPool(() => new CopcWorker(), resolveWorkerCount(resolved.concurrency));

    const dataSource = new CopcDataSource(
      url,
      viewer,
      hierarchy,
      resolved,
      project,
      pool,
      !workerPool,
    );

    // Deferred until after the initial camera framing (if any) so the fly-to
    // doesn't spend a debounce cycle computing LoD for wherever the camera
    // started, only to immediately redo it once framing completes.
    if (resolved.autoFrame) {
      await dataSource.zoomTo();
    }
    dataSource._startListening();

    return dataSource;
  }

  private _startListening(): void {
    this._removeUpdateListener = this._viewer.scene.preRender.addEventListener(() =>
      this._onPreRender(),
    );
    this._removeMoveEndListener = this._viewer.scene.camera.moveEnd.addEventListener(() =>
      this._onMoveEnd(),
    );
    this._removeMoveStartListener = this._viewer.scene.camera.moveStart.addEventListener(() => {
      this._cameraMoving = true;
    });
  }

  /** Flies the camera to the loaded dataset's root bounding sphere. */
  async zoomTo(): Promise<void> {
    const rootSphere = this._getSphere('0-0-0-0');
    const camera = this._viewer.scene.camera;
    const scale = sseScale(this._viewer.scene.canvas.clientHeight, getFovy(camera.frustum));
    const initRange = (rootSphere.radius * scale) / (this._options.sseThreshold * 2);

    return new Promise<void>((resolve) => {
      camera.flyToBoundingSphere(rootSphere, {
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), initRange),
        complete: resolve,
      });
    });
  }

  /** One stable function, so the per-pass `selectNodes`/`orderForLoading`
   *  options reuse it instead of allocating a closure each time. Returns the
   *  sphere where the node is drawn, shifted by `heightOffset` (#229), so
   *  selection culls and measures what is actually on screen. */
  private readonly _getSphere = (key: string): Cesium.BoundingSphere => this._spheres.drawn(key);

  /** The sphere cache's backing map; read by tests that check eviction. */
  private get _sphereCache(): ReadonlyMap<string, Cesium.BoundingSphere> {
    return this._spheres.entries;
  }

  /** Runs on every `Scene.preRender`: a cheap visibility pass every frame, an
   *  expensive LoD pass throttled to `debounceMs`. */
  private _onPreRender(): void {
    if (this._destroyed) return;
    this._updateVisibility();
    this._trackMotion();

    const now = performance.now();
    if (now - this._lastUpdateTime < this._options.debounceMs) return;
    // A skipped tick still restarts the debounce clock. Otherwise the first
    // tick after an idle stretch runs a pass at once, on the very frame a
    // camera jump lands, and the passes after it fall out of step with
    // debounceMs; benchmark replays settled 7-10% slower that way.
    const skip = this._options.skipIdleLoD && !this._lodNeeded();
    this._lastUpdateTime = now;
    if (skip) return;
    void this._updateLoD();
  }

  /** `skipIdleLoD`: whether a pass could decide anything new. Conservative: any
   *  doubt (loads in flight or deferred, a page loading, the camera moving)
   *  counts as needed. */
  private _lodNeeded(): boolean {
    if (this._lodDirty || this._lodUnsettled || this._cameraMoving) return true;
    if (this._scheduler.pendingCount > 0 || this._scheduler.deferredCount > 0) return true;
    return !sameView(this._lastViewSignature, this._currentViewSignature());
  }

  private _currentViewSignature(): number[] {
    const canvas = this._viewer.scene.canvas;
    return viewSignature(
      this._viewer.scene.camera,
      canvas.clientWidth,
      canvas.clientHeight,
      this._viewSignatureScratch,
    );
  }

  /** Samples the camera each frame while it moves, for the predicted pose. A
   *  jump (flyTo, teleport) restarts the tracker inside `update()`, so the
   *  prediction falls back to the current pose until a new velocity forms. */
  private _trackMotion(): void {
    if (!this._options.prefetchLookaheadMs || !this._cameraMoving) return;
    const camera = this._viewer.scene.camera;
    const p = camera.positionWC;
    const d = camera.directionWC;
    const u = camera.upWC;
    this._motion.update({
      timeMs: performance.now(),
      position: [p.x, p.y, p.z],
      direction: [d.x, d.y, d.z],
      up: [u.x, u.y, u.z],
    });
  }

  /** The camera pose `prefetchLookaheadMs` ahead (capped), or undefined when
   *  the option is off, the camera is at rest, or nothing has been sampled. */
  private _predictedPose(): CameraPose | undefined {
    const lookahead = this._options.prefetchLookaheadMs;
    if (!lookahead || lookahead <= 0 || !this._cameraMoving) return undefined;
    const pose = this._motion.predict(Math.min(lookahead, MAX_PREFETCH_LOOKAHEAD_MS), 'damped');
    if (!pose) return undefined;
    return {
      positionWC: new Cesium.Cartesian3(...pose.position),
      directionWC: new Cesium.Cartesian3(...pose.direction),
      upWC: new Cesium.Cartesian3(...pose.up),
    };
  }

  /** Camera has come to rest — run the LoD pass immediately rather than
   *  possibly losing the final refinement to debounce timing. */
  private _onMoveEnd(): void {
    if (this._destroyed) return;
    this._cameraMoving = false;
    this._motion.reset();
    this._lastUpdateTime = performance.now();
    void this._updateLoD();
  }

  /** Cheap: re-tests the current selection's cached nodes against the live
   *  frustum and toggles `show` — no octree walk, no allocation, no loading.
   *  Catches camera changes that happen between (throttled) `_updateLoD()`
   *  passes. */
  private _updateVisibility(): void {
    if (this._selectedKeys.size === 0) return;
    const cullingVolume = getCullingVolume(this._viewer.scene.camera);
    let changed = false;
    for (const key of this._selectedKeys) {
      const node = this._nodeCache.peek(key);
      if (!node) continue; // still loading
      const primitive = node.primitive;
      const show = isInFrustum(this._spheres.peekDrawn(key), cullingVolume);
      if (primitive.show !== show) {
        primitive.show = show;
        changed = true;
      }
    }
    if (changed) this._viewer.scene.requestRender();
  }

  /** Expensive: full reselection via `selectNodes`, then reconciles the render set (`show`)
   *  against it and dispatches loads for anything newly selected but not yet
   *  cached. A node dropping out of the selection is hidden only once its
   *  replacement (children, on subdivision, or the parent, on merge) is
   *  actually ready to show — otherwise it stays visible and pinned, so a
   *  LoD transition never leaves a visible gap where neither the old nor the
   *  new detail level is on screen. Nodes are only ever removed from the
   *  scene by NodeCache's own LRU eviction, never by this reconciliation. */
  private async _updateLoD(): Promise<void> {
    if (this._destroyed) return;
    if (this._isUpdating) {
      this._pendingUpdate = true;
      return;
    }
    this._isUpdating = true;
    // Cleared before selecting so a load settling mid-pass re-arms it.
    this._lodDirty = false;
    const previousSignature = this._lastViewSignature;
    this._lastViewSignature = this._currentViewSignature();
    this._viewSignatureScratch = previousSignature;
    try {
      const neededPages = new Set<string>();
      const newPrefetchKeys = new Set<string>();
      const newSelectedKeys = new Set(
        selectNodes({
          nodes: this._pager.nodes,
          pages: this._pager.pages,
          onPageNeeded: (key) => neededPages.add(key),
          getSphere: this._getSphere,
          camera: this._viewer.scene.camera,
          viewportHeight: this._viewer.scene.canvas.clientHeight,
          sseThreshold: this._options.sseThreshold,
          maxVisibleNodes: this._options.maxVisibleNodes,
          maxPoints: this._options.maxPoints,
          prefetchFrustumFactor: this._options.prefetchFrustumFactor,
          maxPrefetchNodes: this._options.maxPrefetchNodes,
          onPrefetchCandidate: (key) => newPrefetchKeys.add(key),
          predictedPose: this._predictedPose(),
          incumbents: this._selectedKeys,
          incumbentBonus: this._cameraMoving ? INCUMBENT_BONUS : 1,
          viewAxisBias: this._options.viewAxisBias,
        }),
      );

      this._dispatchPageLoads(neededPages);
      this._scheduler.cancelStale(newSelectedKeys, newPrefetchKeys);

      let sceneChanged = false;

      // Show/load the new selection first, so a just-arrived replacement
      // already counts as "ready" when the hide pass below checks for it.
      const toLoad: string[] = [];
      const deferred: string[] = [];
      for (const key of newSelectedKeys) {
        const node = this._nodeCache.peek(key);
        if (node) {
          const primitive = node.primitive;
          if (!primitive.show) {
            primitive.show = true;
            sceneChanged = true;
          }
          continue;
        }
        if (this._scheduler.isPending(key)) continue;
        toLoad.push(key);
      }
      // Ordered before the backpressure check, so deferred loads resume in
      // the same shallowest-first, centre-first order.
      for (const key of orderForLoading(toLoad, this._getSphere, this._viewer.scene.camera)) {
        if (this._options.decodeBackpressure && this._scheduler.decodeBound()) {
          deferred.push(key);
          continue;
        }
        void this._scheduler.load(key);
      }

      this._scheduler.commit(newSelectedKeys, deferred, newPrefetchKeys);

      const stillShown = new Set(newSelectedKeys);
      // Bucketed once per pass (not once per deselected key) so
      // _isReplacementReady() doesn't re-parse every candidate key on every
      // call -- see findRelevantKeys().
      const selectionBuckets = bucketKeysByDepth(newSelectedKeys);
      for (const key of this._selectedKeys) {
        if (newSelectedKeys.has(key)) continue;
        const node = this._nodeCache.peek(key);
        if (!node) continue;
        const primitive = node.primitive;
        if (!primitive.show) continue;

        if (this._isReplacementReady(key, selectionBuckets)) {
          primitive.show = false;
          sceneChanged = true;
        } else {
          stillShown.add(key); // keep it visible; re-checked again next pass
        }
      }

      // Prefetched-but-not-shown nodes only get their recency bumped, not a
      // pin: pinned keys are skipped by eviction, so pinning up to
      // maxVisibleNodes + maxPrefetchNodes keys could leave nothing evictable
      // and let the cache outgrow maxCacheNodes/maxCacheBytes. Bumped before
      // pin() so the shown set still ends up most recent (#212).
      for (const key of newPrefetchKeys) this._nodeCache.get(key);
      this._nodeCache.pin(stillShown);
      // Nodes that just left the screen are evictable now; without this they
      // stay over budget until the next node is inserted.
      if (this._options.strictCacheBudget) this._nodeCache.trim();
      this._selectedKeys = stillShown;
      this._lodUnsettled = neededPages.size > 0 || stillShown.size > newSelectedKeys.size;
      if (sceneChanged) this._viewer.scene.requestRender();
    } finally {
      this._isUpdating = false;
      if (this._pendingUpdate) {
        this._pendingUpdate = false;
        void this._updateLoD();
      }
    }
  }

  /** Kicks off a hierarchy page load for every page the current selection
   *  pass needed but that isn't already loading. */
  private _dispatchPageLoads(neededPages: Set<string>): void {
    for (const key of neededPages) {
      if (!this._pager.isPending(key)) void this._pager.loadPage(key);
    }
  }

  /** A deselected node's replacement is whatever in the new selection covers
   *  the same volume: its descendants (subdivision) or an ancestor (merge).
   *  The match is by containment at *any* depth, not just one level — a
   *  single LoD pass routinely moves the cut two or more levels (one mouse
   *  wheel notch is worth roughly 1-1.5 levels of screen-space error, and
   *  `debounceMs` collapses several notches into one pass), and a
   *  grandchild/grandparent covers the outgoing node's area just as a direct
   *  child/parent does. Ready once every such relevant replacement is cached
   *  and shown; a node with neither relationship in the new selection (e.g. a
   *  sibling-only change, or it simply left the frustum) has nothing that
   *  would cover its absence anyway, so it's treated as immediately ready. */
  private _isReplacementReady(key: string, selectionBuckets: Map<number, ParsedKey[]>): boolean {
    const relevant = findRelevantKeys(key, selectionBuckets);
    if (relevant.length === 0) return true;

    return relevant.every((candidate) => {
      const node = this._nodeCache.peek(candidate);
      return !!node && node.primitive.show;
    });
  }

  private _destroyLoadedNode(node: LoadedNode): void {
    this._viewer.scene.primitives.remove(node.primitive);
    this._viewer.scene.requestRender();
  }

  /** Point size in pixels, shared live by every loaded primitive (no reload needed). */
  get pixelSize(): number {
    return this._styleCtl.pixelSize;
  }
  set pixelSize(value: number) {
    this._styleCtl.pixelSize = value;
  }

  /** How `gl_PointSize` is computed. Shared live by every loaded primitive (no reload needed). */
  get pointSizeMode(): PointSizeMode {
    return this._styleCtl.pointSizeMode;
  }
  set pointSizeMode(value: PointSizeMode) {
    this._styleCtl.pointSizeMode = value;
  }

  /**
   * Numerator of the attenuated-size formula (`attenuationFactor / sqrt(dist_m)`).
   * Only affects rendering when `pointSizeMode` is `'attenuated'`. Shared live
   * by every loaded primitive (no reload needed).
   */
  get attenuationFactor(): number {
    return this._styleCtl.attenuationFactor;
  }
  set attenuationFactor(value: number) {
    this._styleCtl.attenuationFactor = value;
  }

  /** Lower clamp (pixels) for attenuated point size. Shared live by every loaded primitive. */
  get minPixelSize(): number {
    return this._styleCtl.minPixelSize;
  }
  set minPixelSize(value: number) {
    this._styleCtl.minPixelSize = value;
  }

  /** Upper clamp (pixels) for attenuated point size. Shared live by every loaded primitive. */
  get maxPixelSize(): number {
    return this._styleCtl.maxPixelSize;
  }
  set maxPixelSize(value: number) {
    this._styleCtl.maxPixelSize = value;
  }

  /**
   * Alpha multiplier applied to every point's colour, shared live by every
   * loaded primitive (no reload needed). Below `1`, the primitive switches to
   * alpha blending with no per-point depth sort, so overlapping points may
   * blend out of order.
   */
  get opacity(): number {
    return this._styleCtl.opacity;
  }
  set opacity(value: number) {
    this._styleCtl.opacity = value;
  }

  /** Eye-Dome Lighting on/off; see `CopcDataSourceOptions.eyeDomeLighting`. */
  get eyeDomeLighting(): boolean {
    return this._edl.enabled;
  }
  set eyeDomeLighting(value: boolean) {
    this._edl.enabled = value;
    this._viewer.scene.requestRender();
  }

  /** EDL shading strength, `>= 0`. */
  get eyeDomeLightingStrength(): number {
    return this._edl.strength;
  }
  set eyeDomeLightingStrength(value: number) {
    this._edl.strength = validateEdlStrength(value);
    this._viewer.scene.requestRender();
  }

  /** EDL neighbour sampling distance, in CSS pixels, `> 0`. */
  get eyeDomeLightingRadius(): number {
    return this._edl.radius;
  }
  set eyeDomeLightingRadius(value: number) {
    this._edl.radius = validateEdlRadius(value);
    this._viewer.scene.requestRender();
  }

  /**
   * How points are coloured. Every mode reads attributes already uploaded to
   * the GPU, so switching costs one uniform update — no refetch, no re-decode,
   * and the node cache is untouched.
   */
  get colorMode(): ColorMode {
    return this._styleCtl.colorMode;
  }
  set colorMode(value: ColorMode) {
    this._styleCtl.colorMode = value;
  }

  /**
   * Classification codes to draw, or `undefined` to draw everything. Filtered
   * points are dropped in the vertex shader, so they still occupy GPU memory
   * — this hides points, it doesn't reclaim anything.
   */
  get classificationFilter(): number[] | undefined {
    return this._styleCtl.classificationFilter;
  }
  set classificationFilter(value: number[] | undefined) {
    this._styleCtl.classificationFilter = value;
  }

  /**
   * Raw LAS intensity values at the two ends of the `'intensity'` ramp.
   * Assigning `undefined` hands the range back to auto, which rebuilds it from
   * the nodes loaded from then on rather than the ones already resident.
   */
  get intensityRange(): [number, number] {
    return this._styleCtl.intensityRange;
  }
  set intensityRange(value: [number, number] | undefined) {
    this._styleCtl.intensityRange = value;
  }

  /**
   * Vertical offset in meters applied to every loaded point, for manually
   * correcting a geoid/vertical-datum mismatch between the point cloud and
   * the globe surface. Shared live by every loaded primitive (no reload
   * needed) — moves the model matrix, not the geometry.
   */
  get heightOffset(): number {
    return this._styleCtl.heightOffset;
  }
  set heightOffset(value: number) {
    this._styleCtl.heightOffset = value;
    // Moves every node's sphere with its points; the next pass reselects
    // against where they now are.
    this._spheres.heightOffset = this._styleCtl.heightOffset;
    this._lodDirty = true;
  }

  /**
   * Clipping planes in world (ECEF) coordinates; see
   * `CopcDataSourceOptions.clipPlanes`. Assign `undefined` or `[]` to clear.
   * The planes are copied on assignment, so mutating them afterwards has no
   * effect until they're assigned again.
   */
  get clipPlanes(): Cesium.Plane[] {
    return this._styleCtl.clipPlanes;
  }
  set clipPlanes(value: Cesium.Plane[] | undefined) {
    this._styleCtl.clipPlanes = value;
    this._lodDirty = true;
  }

  /**
   * Clipping boxes, each mapping the unit cube `[-0.5, 0.5]^3` to world
   * (ECEF); see `CopcDataSourceOptions.clipBoxes`. Assign `undefined` or
   * `[]` to clear. Copied on assignment, like `clipPlanes`.
   */
  get clipBoxes(): Cesium.Matrix4[] {
    return this._styleCtl.clipBoxes;
  }
  set clipBoxes(value: Cesium.Matrix4[] | undefined) {
    this._styleCtl.clipBoxes = value;
    this._lodDirty = true;
  }

  /** Which side of the clip regions is drawn. */
  get clipMode(): ClipMode {
    return this._styleCtl.clipMode;
  }
  set clipMode(value: ClipMode) {
    this._styleCtl.clipMode = value;
    this._lodDirty = true;
  }

  /** Screen-space error threshold (pixels) that triggers node subdivision. */
  get sseThreshold(): number {
    return this._options.sseThreshold;
  }
  set sseThreshold(value: number) {
    this._options.sseThreshold = value;
    this._lodDirty = true;
    void this._updateLoD();
  }

  /** Deepest octree level present in the loaded hierarchy so far — grows as
   *  sub-pages load, and is tracked incrementally by the pager rather than
   *  recomputed on every read. */
  get maxDepth(): number {
    return this._pager.maxDepth;
  }

  /** Total number of nodes in the loaded hierarchy (loaded or not). */
  get nodeCount(): number {
    return Object.keys(this._pager.nodes).length;
  }

  /**
   * Bytes spent and per-stage latency for this data source (#181).
   *
   * `transferredBytes` covers every path that touches the file — the
   * Range-support probe, the header, hierarchy pages, and node point data — so
   * `transferredBytes / fileBytes` is the defensible form of the streaming
   * claim rather than a point-data-only subset.
   */
  get stats(): CopcStats {
    return {
      fileBytes: this._counter.fileBytes,
      requestCount: this._counter.requestCount,
      transferredBytes: this._counter.transferredBytes,
      pendingNodes: this._scheduler.pendingCount,
      decodeQueue: { ...this._workerPool.timing, deferredLoads: this._scheduler.deferredCount },
      cache: {
        nodes: this._nodeCache.size,
        estimatedBytes: this._nodeCache.estimatedBytes,
        pinned: this._nodeCache.pinnedCount,
        evictions: this._nodeCache.evictionCount,
      },
      waste: this._counter.waste,
      fetch: this._stages.timing('fetch'),
      decode: this._stages.timing('decode'),
      upload: this._stages.timing('upload'),
    };
  }

  /** Number of nodes currently retained in the LRU cache. */
  get cacheSize(): number {
    return this._nodeCache.size;
  }

  /**
   * Finds the nearest currently-visible point under `windowPosition` (screen
   * coordinates, e.g. from a `ScreenSpaceEventHandler`) and returns its
   * position plus classification/intensity, or `undefined` if nothing is
   * under the cursor. `tolerancePixels` widens the search around the exact
   * pixel — points are near-zero-area dots, so an exact-pixel-only test
   * misses far more often than it would against a filled shape.
   *
   * WebGL2-only: identifying which point was hit reads `gl_VertexID`, and
   * fetching its attributes uses `gl.getBufferSubData`, both to avoid keeping
   * a full CPU copy of every loaded node around just in case it's picked. On
   * a WebGL1 fallback context (or a `Viewer` built with
   * `contextOptions: { requestWebgl1: true }`), this logs one warning and
   * always returns `undefined` — every other part of this library still
   * renders fine there; only picking needs WebGL2.
   *
   * Respects the current render set: a node hidden by `classificationFilter`,
   * culled by the view frustum, or not yet loaded can't be picked, matching
   * what's actually on screen. `nodeKey`/`pointIndex` on the result are only
   * meaningful while that node stays cached — see `PickedPoint`'s own doc
   * comment.
   */
  pickPoint(windowPosition: Cesium.Cartesian2, tolerancePixels = 4): PickedPoint | undefined {
    if (this._destroyed) return undefined;
    return this._picker.pick(
      {
        scene: this._viewer.scene,
        selectedKeys: this._selectedKeys,
        peekNode: (key) => this._nodeCache.peek(key),
        getSphere: this._getSphere,
      },
      windowPosition,
      tolerancePixels,
    );
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._removeUpdateListener();
    this._removeMoveEndListener();
    this._removeMoveStartListener();
    this._rangeFetcher.destroy();
    if (this._ownsPool) this._workerPool.destroy();
    this._nodeCache.destroy();
    this._edl.destroy();
    this._picker.destroy();
  }
}
