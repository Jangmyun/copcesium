import * as Cesium from 'cesium';
import proj4 from 'proj4';
import { Copc, type Hierarchy } from 'copc';
import type {
  ColorMode,
  CopcDataSourceOptions,
  CopcStats,
  LoadedNode,
  NodeRenderData,
  StageTiming,
} from './types';
import { loadCopcHierarchy } from './copc/hierarchy';
import { bucketKeysByDepth, findRelevantKeys, getDepth, type ParsedKey } from './copc/node';
import { isRetryable, RangeFetcher } from './copc/RangeFetcher';
import { createCountingGetter, type TransferCounter } from './copc/TransferCounter';
import { detectCrs } from './crs/detectCrs';
import { createProjector } from './crs/project';
import { getCullingVolume, getNodeBoundingSphere, isInFrustum, type ProjectToCartesian } from './lod/boundingVolume';
import { selectNodes } from './lod/selectNodes';
import { createNodePrimitive } from './loader/loadNode';
import type { PointStyle } from './renderer/PointCloudPrimitive';
import { COLOR_MODE, buildClassMask } from './renderer/shaders';
import { WorkerPool } from './worker/WorkerPool';
import type { NodeConversionPayload } from './worker/messages';
import { NodeCache } from './cache/NodeCache';
// Inlined into a Blob at build time (see vite.config.ts's `worker.format`)
// instead of emitted as a separate chunk with a runtime-constructed URL — a
// consumer's own bundler can't discover or copy an asset it never sees a
// static import for, and a URL baked in at our build time either 404s (file
// never shipped to the consumer's own output) or, once shipped, breaks under
// any deploy path other than the site root. See issue on worker 404s in
// consumer builds.
import CopcWorker from './worker/worker.ts?worker&inline';

export type { ColorMode, CopcDataSourceOptions };

/** Shared by the constructor and the live setter so an out-of-range or non-finite
 *  value can never slip in through either path. */
function validateOpacity(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`opacity must be between 0 and 1, got ${value}`);
  }
  return value;
}

/**
 * Options with every defaultable field filled in. `classificationFilter`,
 * `intensityRange`, `maxCacheBytes`, and `maxConcurrentRequests` stay optional
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
  | 'maxConcurrentRequests';

type ResolvedOptions = Required<Omit<CopcDataSourceOptions, OpenEndedOption>> &
  Pick<CopcDataSourceOptions, OpenEndedOption>;

const DEFAULT_OPTIONS: Required<Omit<CopcDataSourceOptions, OpenEndedOption>> = {
  proj: 'EPSG:4326',
  projDef: null,
  geoidOffset: 0,
  concurrency: 5,
  debounceMs: 100,
  maxCacheNodes: 150,
  maxVisibleNodes: 100,
  maxPoints: 5_000_000,
  pixelSize: 2,
  sseThreshold: 250,
  zFactor: 1,
  xyFactor: 1,
  autoFrame: true,
  colorMode: 'rgb',
  opacity: 1,
};

// Total attempts per hierarchy sub-page before giving up, mirroring
// RangeFetcher's MAX_ATTEMPTS for node-level Range Requests (#117): a page
// that keeps failing needs a bound so `onPageNeeded` doesn't refire the same
// request forever on every LoD pass.
const MAX_PAGE_LOAD_ATTEMPTS = 3;

// Retries here aren't paced by a timer of their own — a page is re-requested
// whenever the next LoD pass rediscovers it, which is as often as every
// `debounceMs` (100ms by default) while the camera moves, and immediately on
// `moveEnd`. Without a delay of its own, all three attempts can burn inside a
// few hundred milliseconds, so a one-second network blip would exhaust the
// budget and drop the subtree for good. These spread the attempts the way
// RangeFetcher's backoff does, but longer: a give-up here is permanent for the
// session, whereas a failed node load is simply re-requested by the next pass.
const PAGE_RETRY_BASE_MS = 1000;
// Failures far enough apart are unrelated incidents, not one page going bad:
// without this, three isolated blips across a long session would still add up
// to a permanent give-up.
const PAGE_FAILURE_RESET_MS = 60_000;

type StageName = 'fetch' | 'decode' | 'upload';

/** How many recent nodes each stage's percentiles are computed over. Bounded
 *  so a long session doesn't accumulate one sample per node forever; large
 *  enough that a single slow node can't drag the median. */
const STAGE_SAMPLE_WINDOW = 256;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

// Bounds `_sphereCache` independently of `maxCacheNodes`: every candidate the
// BFS selectNodes() pass touches while walking the hierarchy gets a sphere
// computed, not just currently-loaded/visible nodes, so this cache sees a much
// larger working set per LoD pass than NodeCache does. Sized generously above
// the default `maxCacheNodes` (150) to comfortably hold a pass's candidates
// without thrashing.
const MAX_SPHERE_CACHE_SIZE = 5000;

export class CopcDataSource {
  private readonly _url: string;
  private readonly _viewer: Cesium.Viewer;
  private readonly _copc: Copc;
  private readonly _nodes: Hierarchy.Node.Map;
  /** Tracked incrementally as nodes are merged in, rather than recomputed with
   *  `Math.max(...keys)` on every read — that spread blows the call stack once
   *  a multi-page hierarchy's node count passes ~124k (#126). */
  private _maxDepth: number;
  /** Sub-page entry points not yet merged into `_nodes`; shrinks as pages load. */
  private readonly _pages: Hierarchy.Page.Map;
  private readonly _pendingPages = new Set<string>();
  /** Failed attempts per hierarchy page key, with the timestamp of the last one
   *  so retries can be spaced out and stale counts discarded; cleared once a
   *  page loads. */
  private readonly _pageFailures = new Map<string, { count: number; at: number }>();
  private readonly _counter: TransferCounter;
  /** Shared status-checked, counting Getter for hierarchy sub-pages. Retry
   *  policy stays with `_loadPage()`, which already owns the attempt count and
   *  backoff — this getter makes exactly one attempt (#139). */
  private readonly _pageGetter: (begin: number, end: number) => Promise<Uint8Array>;
  /** Bounded rolling samples per pipeline stage; see `stats`. */
  private readonly _stageSamples: Record<StageName, number[]> = { fetch: [], decode: [], upload: [] };
  /** Monotonic completion counts. Kept apart from `_stageSamples` because that
   *  window is capped at `STAGE_SAMPLE_WINDOW` for the percentiles' sake, and
   *  reading its length back as a total silently pins every long session at
   *  that cap (#194). */
  private readonly _stageCounts: Record<StageName, number> = { fetch: 0, decode: 0, upload: 0 };
  /** Emitted `performance.measure` entries since the last clear; see `_recordStage`. */
  private readonly _measureCount: Record<StageName, number> = { fetch: 0, decode: 0, upload: 0 };
  private readonly _rootCenter: { x: number; y: number; z: number };
  private readonly _rootHalfSize: number;
  private readonly _options: ResolvedOptions;
  private readonly _project: ProjectToCartesian;
  private readonly _style: PointStyle;
  /** True while `intensityRange` is unpinned and grows with each node loaded. */
  private _autoIntensityRange: boolean;
  private readonly _nodeCache: NodeCache;
  private readonly _rangeFetcher: RangeFetcher;
  private readonly _workerPool: WorkerPool;
  private readonly _ownsPool: boolean;
  private readonly _pendingKeys = new Set<string>();
  private readonly _cancels = new Map<string, () => void>();
  private readonly _sphereCache = new Map<string, Cesium.BoundingSphere>();
  private _selectedKeys = new Set<string>();
  private _isUpdating = false;
  private _pendingUpdate = false;
  private _lastUpdateTime = 0;
  private _removeUpdateListener: () => void = () => {};
  private _removeMoveEndListener: () => void = () => {};
  private _destroyed = false;

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
    this._nodes = hierarchy.nodes;
    this._maxDepth = hierarchy.maxDepth;
    this._pages = hierarchy.pages;
    this._rootCenter = hierarchy.rootCenter;
    this._rootHalfSize = hierarchy.rootHalfSize;
    this._options = options;
    this._project = project;
    this._style = {
      pixelSize: options.pixelSize,
      colorMode: COLOR_MODE[options.colorMode],
      intensityRange: new Cesium.Cartesian2(options.intensityRange?.[0] ?? 0, options.intensityRange?.[1] ?? 1),
      classMask: buildClassMask(options.classificationFilter),
      heightOffset: 0,
      opacity: validateOpacity(options.opacity),
    };
    this._autoIntensityRange = options.intensityRange === undefined;
    this._nodeCache = new NodeCache(
      options.maxCacheNodes,
      (_key, node) => this._destroyLoadedNode(node),
      options.maxCacheBytes,
    );
    // Defaults to the worker pool's size, which keeps fetching from outrunning
    // decoding the way it did before any cap existed (#86) — but is settable
    // on its own, because the two stages saturate at different widths.
    this._counter = hierarchy.counter;
    this._pageGetter = createCountingGetter(url, this._counter);
    this._rangeFetcher = new RangeFetcher(
      url,
      undefined,
      undefined,
      options.maxConcurrentRequests ?? workerPool.concurrency,
      this._counter,
    );
    this._workerPool = workerPool;
    this._ownsPool = ownsPool;
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

    const hierarchy = await loadCopcHierarchy(url);

    // Run WKT detection unconditionally — even when the caller overrides
    // proj/projDef, the file's WKT may still be the only source of the true
    // zFactor/xyFactor (e.g. a compound CRS with foot-based vertical units).
    // proj/projDef and zFactor/xyFactor are therefore applied independently,
    // each only when the user did not explicitly set that particular field.
    const detected = detectCrs(hierarchy.copc.wkt, url);
    if (detected) {
      if (!resolved.projDef) {
        resolved.proj = detected.proj;
        resolved.projDef = detected.projDef;
      }
      // Check the raw `options` argument, not `resolved`, since `resolved`
      // already carries the (indistinguishable) default of 1.
      if (options.zFactor === undefined) resolved.zFactor = detected.zFactor;
      if (options.xyFactor === undefined) resolved.xyFactor = detected.xyFactor;
    }
    if (resolved.projDef && resolved.proj !== 'EPSG:4326') {
      proj4.defs(resolved.proj, resolved.projDef);
    }

    const converter = resolved.proj !== 'EPSG:4326' ? proj4(resolved.proj, 'EPSG:4326') : null;
    const project = createProjector(converter, resolved.geoidOffset, resolved.zFactor);

    const pool = workerPool ?? new WorkerPool(() => new CopcWorker(), resolved.concurrency);

    const dataSource = new CopcDataSource(url, viewer, hierarchy, resolved, project, pool, !workerPool);

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
    this._removeUpdateListener = this._viewer.scene.preRender.addEventListener(() => this._onPreRender());
    this._removeMoveEndListener = this._viewer.scene.camera.moveEnd.addEventListener(() => this._onMoveEnd());
  }

  /** Flies the camera to the loaded dataset's root bounding sphere. */
  async zoomTo(): Promise<void> {
    const rootSphere = this._getSphere('0-0-0-0');
    const camera = this._viewer.scene.camera;
    const fovy =
      (camera.frustum instanceof Cesium.PerspectiveFrustum ? camera.frustum.fovy : undefined) ??
      Cesium.Math.toRadians(60);
    const sseScale = this._viewer.scene.canvas.clientHeight / (2 * Math.tan(fovy / 2));
    const initRange = (rootSphere.radius * sseScale) / (this._options.sseThreshold * 2);

    return new Promise<void>((resolve) => {
      camera.flyToBoundingSphere(rootSphere, {
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), initRange),
        complete: resolve,
      });
    });
  }

  /** LRU-cached, capped at `MAX_SPHERE_CACHE_SIZE`. Unlike `_nodeCache`, no
   *  pinning is needed: a `Cesium.BoundingSphere` is pure arithmetic (no I/O,
   *  no GPU work), so evicting even a currently-visible node's sphere is
   *  safe — it's simply recomputed on the next call. */
  private _getSphere(key: string): Cesium.BoundingSphere {
    const cached = this._sphereCache.get(key);
    if (cached) {
      // Bump recency: delete + re-insert moves this key to the end of the
      // Map's iteration order, which the eviction below relies on.
      this._sphereCache.delete(key);
      this._sphereCache.set(key, cached);
      return cached;
    }
    const sphere = getNodeBoundingSphere(
      key,
      this._rootCenter,
      this._rootHalfSize,
      this._project,
      this._options.xyFactor,
    );
    this._sphereCache.set(key, sphere);
    if (this._sphereCache.size > MAX_SPHERE_CACHE_SIZE) {
      // Iterates in insertion (= least-recently-used-first) order.
      const oldestKey = this._sphereCache.keys().next().value;
      if (oldestKey !== undefined) this._sphereCache.delete(oldestKey);
    }
    return sphere;
  }

  /** Runs on every `Scene.preRender`: a cheap visibility pass every frame, an
   *  expensive LoD pass throttled to `debounceMs`. */
  private _onPreRender(): void {
    if (this._destroyed) return;
    this._updateVisibility();

    const now = performance.now();
    if (now - this._lastUpdateTime < this._options.debounceMs) return;
    this._lastUpdateTime = now;
    void this._updateLoD();
  }

  /** Camera has come to rest — run the LoD pass immediately rather than
   *  possibly losing the final refinement to debounce timing. */
  private _onMoveEnd(): void {
    if (this._destroyed) return;
    this._lastUpdateTime = performance.now();
    void this._updateLoD();
  }

  /** Cheap: re-tests the current selection's cached nodes against the live
   *  frustum and toggles `show` — no BFS, no allocation, no loading. Catches
   *  camera changes that happen between (throttled) `_updateLoD()` passes. */
  private _updateVisibility(): void {
    if (this._selectedKeys.size === 0) return;
    const cullingVolume = getCullingVolume(this._viewer.scene.camera);
    let changed = false;
    for (const key of this._selectedKeys) {
      const node = this._nodeCache.peek(key);
      if (!node) continue; // still loading
      const primitive = node.primitive;
      const show = isInFrustum(this._getSphere(key), cullingVolume);
      if (primitive.show !== show) {
        primitive.show = show;
        changed = true;
      }
    }
    if (changed) this._viewer.scene.requestRender();
  }

  /** Expensive: BFS reselection, then reconciles the render set (`show`)
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
    try {
      const neededPages = new Set<string>();
      const newSelectedKeys = new Set(
        selectNodes({
          nodes: this._nodes,
          pages: this._pages,
          onPageNeeded: (key) => neededPages.add(key),
          getSphere: (key) => this._getSphere(key),
          camera: this._viewer.scene.camera,
          viewportHeight: this._viewer.scene.canvas.clientHeight,
          sseThreshold: this._options.sseThreshold,
          maxVisibleNodes: this._options.maxVisibleNodes,
          maxPoints: this._options.maxPoints,
        }),
      );

      this._dispatchPageLoads(neededPages);
      this._cancelStaleLoads(newSelectedKeys);

      let sceneChanged = false;

      // Show/load the new selection first, so a just-arrived replacement
      // already counts as "ready" when the hide pass below checks for it.
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
        if (this._pendingKeys.has(key)) continue;
        void this._loadNode(key);
      }

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

      this._nodeCache.pin(stillShown);
      this._selectedKeys = stillShown;
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
      if (!this._pendingPages.has(key)) void this._loadPage(key);
    }
  }

  /** A load still in flight for a key the camera has since moved past is
   *  decoding data nobody will show; cancel it so its worker slot frees up
   *  for the current selection instead (#86). */
  private _cancelStaleLoads(newSelectedKeys: Set<string>): void {
    for (const key of this._pendingKeys) {
      if (!newSelectedKeys.has(key)) this._cancels.get(key)?.();
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

  private async _loadNode(key: string): Promise<void> {
    this._pendingKeys.add(key);
    try {
      // selectNodes() only ever returns keys it found present in this._nodes.
      const node = this._nodes[key]!;

      // Queued alongside every other node this same _updateLoD() pass just
      // selected — RangeFetcher merges same-tick requests for adjacent byte
      // ranges (exactly what sibling nodes are) into one HTTP request (#86).
      const rangeTask = this._rangeFetcher.fetch(node.pointDataOffset, node.pointDataOffset + node.pointDataLength);
      this._cancels.set(key, rangeTask.cancel);
      const fetchStart = performance.now();
      const compressedBytes = await rangeTask;
      this._recordStage('fetch', fetchStart);
      if (this._destroyed) return;

      const payload: NodeConversionPayload = {
        compressedBytes,
        copc: this._copc,
        node,
        proj: this._options.proj,
        projDef: this._options.projDef,
        geoidOffset: this._options.geoidOffset,
        zFactor: this._options.zFactor,
        zMin: this._copc.header.min[2],
        zMax: this._copc.header.max[2],
      };
      const task = this._workerPool.run<NodeRenderData>(payload, [compressedBytes.buffer]);
      this._cancels.set(key, task.cancel);
      const decodeStart = performance.now();
      const renderData = await task;
      this._recordStage('decode', decodeStart);
      if (this._destroyed) return;

      const boundingSphere = this._getSphere(key);
      this._growAutoIntensityRange(renderData.maxIntensity);
      // Timed from inside the primitive rather than around this call: the GPU
      // work happens on the first frame the node is drawn, because that is
      // when `frameState.context` exists. Wrapping the constructor measured
      // object allocation and duly reported 0 ms (#194).
      const primitive = await createNodePrimitive(renderData, boundingSphere, this._style, (start, end) => {
        if (!this._destroyed) this._recordStage('upload', start, end);
      });
      if (this._destroyed) {
        primitive.destroy();
        return;
      }
      // The selection may have moved on while this node was decoding; only
      // show it if it's still wanted, but keep it cached either way.
      primitive.show = this._selectedKeys.has(key);
      this._viewer.scene.primitives.add(primitive);
      this._nodeCache.set(key, { key, primitive, pointCount: renderData.pointCount });
      // Required under `requestRenderMode: true` for the new primitive to actually
      // appear; harmless (no-op) under continuous rendering otherwise.
      this._viewer.scene.requestRender();
    } catch (err) {
      if (this._destroyed) return;
      // Cancelled because the selection moved on (see the deselect loop in
      // _updateLoD) — expected, not a failure worth logging.
      if ((err as Error).name === 'AbortError') return;
      console.error(`[CopcDataSource] Failed to load node "${key}":`, err);
    } finally {
      this._pendingKeys.delete(key);
      this._cancels.delete(key);
    }
  }

  /** Loads a hierarchy sub-page, merges its nodes/pages into the live maps,
   *  and re-runs LoD selection so the newly revealed depth can be picked up. */
  private async _loadPage(key: string): Promise<void> {
    const page = this._pages[key];
    if (!page) return;
    const failure = this._pageFailures.get(key);
    // Still inside this attempt's backoff — skip the pass rather than spend an
    // attempt on it. The next LoD pass to rediscover the page picks it up once
    // the delay has elapsed.
    if (failure && performance.now() - failure.at < PAGE_RETRY_BASE_MS * 2 ** (failure.count - 1)) {
      return;
    }
    this._pendingPages.add(key);
    try {
      const { nodes, pages } = await Copc.loadHierarchyPage(this._pageGetter, page);
      if (this._destroyed) return;
      Object.assign(this._nodes, nodes);
      for (const nodeKey of Object.keys(nodes)) {
        const depth = getDepth(nodeKey);
        if (depth > this._maxDepth) this._maxDepth = depth;
      }
      delete this._pages[key];
      Object.assign(this._pages, pages);
      this._pageFailures.delete(key);
      void this._updateLoD();
    } catch (err) {
      const now = performance.now();
      const recent = failure && now - failure.at < PAGE_FAILURE_RESET_MS;
      const attempts = recent ? failure.count + 1 : 1;
      this._pageFailures.set(key, { count: attempts, at: now });
      // A settled 4xx (e.g. 404 on a removed page, 416 on a bad range) never
      // succeeds on retry, so it gives up on the first attempt instead of
      // burning MAX_PAGE_LOAD_ATTEMPTS and their backoff delays (#139).
      if (attempts >= MAX_PAGE_LOAD_ATTEMPTS || !isRetryable(err)) {
        // Give up: drop the entry point so `onPageNeeded` never fires for it
        // again, and log an error once here rather than on every attempt so a
        // transient outage doesn't scroll the console.
        delete this._pages[key];
        this._pageFailures.delete(key);
        console.error(
          `[CopcDataSource] Giving up on hierarchy page "${key}" after ${attempts} attempt${attempts === 1 ? '' : 's'}:`,
          err,
        );
      } else {
        // Not silent before the cap: a page that eventually loads leaves no
        // error behind, so without this the failures that a field report would
        // need to explain a stall would be invisible.
        console.warn(
          `[CopcDataSource] Hierarchy page "${key}" failed (attempt ${attempts}/${MAX_PAGE_LOAD_ATTEMPTS}), will retry:`,
          err,
        );
      }
    } finally {
      this._pendingPages.delete(key);
    }
  }

  private _destroyLoadedNode(node: LoadedNode): void {
    this._viewer.scene.primitives.remove(node.primitive);
    this._viewer.scene.requestRender();
  }

  /** Widens the auto intensity range as nodes arrive; a no-op once pinned. */
  private _growAutoIntensityRange(maxIntensity: number): void {
    if (!this._autoIntensityRange) return;
    if (maxIntensity <= this._style.intensityRange.y) return;
    this._style.intensityRange.y = maxIntensity;
  }

  /** Point size in pixels, shared live by every loaded primitive (no reload needed). */
  get pixelSize(): number {
    return this._style.pixelSize;
  }
  set pixelSize(value: number) {
    this._style.pixelSize = value;
    this._viewer.scene.requestRender();
  }

  /**
   * Alpha multiplier applied to every point's colour, shared live by every
   * loaded primitive (no reload needed). Below `1`, the primitive switches to
   * alpha blending with no per-point depth sort, so overlapping points may
   * blend out of order.
   */
  get opacity(): number {
    return this._style.opacity;
  }
  set opacity(value: number) {
    this._style.opacity = validateOpacity(value);
    this._viewer.scene.requestRender();
  }

  /**
   * How points are coloured. Every mode reads attributes already uploaded to
   * the GPU, so switching costs one uniform update — no refetch, no re-decode,
   * and the node cache is untouched.
   */
  get colorMode(): ColorMode {
    return this._options.colorMode;
  }
  set colorMode(value: ColorMode) {
    this._options.colorMode = value;
    this._style.colorMode = COLOR_MODE[value];
    this._viewer.scene.requestRender();
  }

  /**
   * Classification codes to draw, or `undefined` to draw everything. Filtered
   * points are dropped in the vertex shader, so they still occupy GPU memory
   * — this hides points, it doesn't reclaim anything.
   */
  get classificationFilter(): number[] | undefined {
    return this._options.classificationFilter;
  }
  set classificationFilter(value: number[] | undefined) {
    // Built before either field is assigned, so an out-of-range code throws
    // without leaving the filter half-applied.
    const mask = buildClassMask(value);
    this._options.classificationFilter = value;
    this._style.classMask = mask;
    this._viewer.scene.requestRender();
  }

  /**
   * Raw LAS intensity values at the two ends of the `'intensity'` ramp.
   * Assigning `undefined` hands the range back to auto, which rebuilds it from
   * the nodes loaded from then on rather than the ones already resident.
   */
  get intensityRange(): [number, number] {
    return [this._style.intensityRange.x, this._style.intensityRange.y];
  }
  set intensityRange(value: [number, number] | undefined) {
    this._autoIntensityRange = value === undefined;
    this._options.intensityRange = value;
    this._style.intensityRange.x = value?.[0] ?? 0;
    this._style.intensityRange.y = value?.[1] ?? 1;
    this._viewer.scene.requestRender();
  }

  /**
   * Vertical offset in meters applied to every loaded point, for manually
   * correcting a geoid/vertical-datum mismatch between the point cloud and
   * the globe surface. Shared live by every loaded primitive (no reload
   * needed) — moves the model matrix, not the geometry.
   */
  get heightOffset(): number {
    return this._style.heightOffset;
  }
  set heightOffset(value: number) {
    this._style.heightOffset = value;
    this._viewer.scene.requestRender();
  }

  /** Screen-space error threshold (pixels) that triggers node subdivision. */
  get sseThreshold(): number {
    return this._options.sseThreshold;
  }
  set sseThreshold(value: number) {
    this._options.sseThreshold = value;
    void this._updateLoD();
  }

  /** Deepest octree level present in the loaded hierarchy so far — grows as
   *  sub-pages load, and is tracked incrementally in `_loadPage()` rather than
   *  recomputed on every read (see `_maxDepth`). */
  get maxDepth(): number {
    return this._maxDepth;
  }

  /** Total number of nodes in the loaded hierarchy (loaded or not). */
  get nodeCount(): number {
    return Object.keys(this._nodes).length;
  }

  /** Number of nodes currently retained in the LRU cache. */
  /** Records one stage's elapsed time, and emits a `performance.measure` so
   *  the same breakdown appears on DevTools' Performance timeline without the
   *  caller wiring anything up. Measured from timestamps rather than paired
   *  marks, so there are no marks left to clean up. */
  private _recordStage(stage: StageName, startedAt: number, endedAt = performance.now()): void {
    const end = endedAt;
    this._stageCounts[stage]++;
    const samples = this._stageSamples[stage];
    samples.push(end - startedAt);
    if (samples.length > STAGE_SAMPLE_WINDOW) samples.shift();

    const name = `copcesium ${stage}`;
    try {
      performance.measure(name, { start: startedAt, end });
      // The User Timing buffer has no default cap, so three entries per node
      // would accumulate for the page's lifetime — tens of MB over a long
      // session on a large dataset, never reclaimed. Dropping our own
      // measures periodically bounds that. A DevTools *recording* still
      // captures them as they happen; only post-hoc `getEntriesByType()`
      // sees just the recent window, which is what `stats` is for anyway.
      if (++this._measureCount[stage] >= STAGE_SAMPLE_WINDOW) {
        this._measureCount[stage] = 0;
        performance.clearMeasures(name);
      }
    } catch {
      // User Timing is unavailable in some embedders; the samples above
      // remain the source of truth for `stats`.
    }
  }

  private _stageTiming(stage: StageName): StageTiming {
    const sorted = [...this._stageSamples[stage]].sort((a, b) => a - b);
    return { count: this._stageCounts[stage], p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
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
      pendingNodes: this._pendingKeys.size,
      fetch: this._stageTiming('fetch'),
      decode: this._stageTiming('decode'),
      upload: this._stageTiming('upload'),
    };
  }

  get cacheSize(): number {
    return this._nodeCache.size;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._removeUpdateListener();
    this._removeMoveEndListener();
    this._rangeFetcher.destroy();
    if (this._ownsPool) this._workerPool.destroy();
    this._nodeCache.destroy();
  }
}
