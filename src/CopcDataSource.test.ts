import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from 'cesium';
import type { Hierarchy } from 'copc';
import type { NodeRenderData } from './types';

const create = vi.fn();
const loadHierarchyPage = vi.fn();

vi.mock('copc', () => ({
  Copc: {
    create: (...args: unknown[]) => create(...args),
    loadHierarchyPage: (...args: unknown[]) => loadHierarchyPage(...args),
  },
}));

// CopcDataSource wires up a real WorkerPool, which would otherwise construct
// an actual `new Worker(...)` immediately in its constructor — unavailable
// under jsdom. `run`/`destroy` are shared vi.fn()s so individual tests can
// configure per-call behavior (e.g. mockResolvedValueOnce) the same way they
// already do for the mocked `copc` module below.
const workerPoolRun = vi.fn();
const workerPoolDestroy = vi.fn();
vi.mock('./worker/WorkerPool', () => ({
  // `new`-able: mockImplementation's function must support construction, which
  // an arrow function cannot — returning an object from a regular function
  // constructor makes `new WorkerPool(...)` resolve to that object (per spec).
  WorkerPool: vi.fn().mockImplementation(function () {
    return {
      run: (...args: unknown[]) => workerPoolRun(...args),
      destroy: (...args: unknown[]) => workerPoolDestroy(...args),
    };
  }),
}));

// Mocked the same way as WorkerPool above, and for the same reason (a real
// RangeFetcher's .fetch() would need a real global `fetch`). Defaults to an
// already-resolved dummy byte range in the shared beforeEach below, so tests
// that don't care about the fetch stage can ignore it entirely.
const rangeFetcherFetch = vi.fn();
const rangeFetcherDestroy = vi.fn();
vi.mock('./copc/RangeFetcher', () => ({
  RangeFetcher: vi.fn().mockImplementation(function () {
    return {
      fetch: (...args: unknown[]) => rangeFetcherFetch(...args),
      destroy: (...args: unknown[]) => rangeFetcherDestroy(...args),
    };
  }),
}));

// The update-loop tests below only care whether CopcDataSource correctly wires
// selectNodes()'s output through WorkerPool -> NodeCache -> scene.primitives —
// selectNodes()'s own frustum/SSE geometry is already covered by
// lod/selectNodes.test.ts, so it's stubbed here to a fixed key rather than
// requiring a geometrically valid camera/frustum in every test.
const selectNodesMock = vi.fn<(...args: unknown[]) => string[]>();
vi.mock('./lod/selectNodes', () => ({
  selectNodes: (...args: unknown[]) => selectNodesMock(...args),
}));

// _updateVisibility() (the per-frame path) calls getCullingVolume/isInFrustum
// directly — independently of selectNodes(), which is mocked above — so it
// needs its own camera-frustum math stubbed out too. getNodeBoundingSphere is
// kept real: it's pure math (no camera needed) and _getSphere's caching is
// worth exercising for real.
const isInFrustumMock = vi.fn<(...args: unknown[]) => boolean>(() => true);
vi.mock('./lod/boundingVolume', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lod/boundingVolume')>();
  return {
    ...actual,
    getCullingVolume: vi.fn(() => ({})),
    isInFrustum: (...args: unknown[]) => isInFrustumMock(...args),
  };
});

const { CopcDataSource } = await import('./CopcDataSource');

/** A pending-forever cancellable promise, for tests that need to observe a
 *  load stuck mid-flight rather than resolving it. */
function makePendingCancellable<T>(): Promise<T> & { cancel: () => void } {
  const promise = new Promise<T>(() => {}) as Promise<T> & { cancel: () => void };
  promise.cancel = vi.fn();
  return promise;
}

function makeResolvedCancellable<T>(value: T): Promise<T> & { cancel: () => void } {
  const promise = Promise.resolve(value) as Promise<T> & { cancel: () => void };
  promise.cancel = vi.fn();
  return promise;
}

// loadCopcHierarchy() probes for Range support via a real `fetch()` before
// ever touching the mocked `copc` module above; default it to a well-behaved
// 206 response so tests unrelated to that probe don't have to know it exists.
const fetchMock = vi.fn();

// workerPoolRun/workerPoolDestroy/selectNodesMock/isInFrustumMock/
// rangeFetcherFetch are shared across every test in this file, so their state
// must be reset per test — otherwise toHaveBeenCalledTimes() assertions
// accumulate across unrelated tests and mockReturnValue() leaks between them.
beforeEach(() => {
  vi.clearAllMocks();
  isInFrustumMock.mockReturnValue(true);
  fetchMock.mockResolvedValue({ status: 206 });
  vi.stubGlobal('fetch', fetchMock);
  rangeFetcherFetch.mockImplementation(() => makeResolvedCancellable(new Uint8Array([0])));
});
afterEach(() => vi.unstubAllGlobals());

function makeFakeViewer() {
  let updateCallback: (() => void) | undefined;
  let moveEndCallback: (() => void) | undefined;
  const addPrimitive = vi.fn();
  const removePrimitive = vi.fn();
  const removeUpdateListener = vi.fn();
  const removeMoveEndListener = vi.fn();
  const requestRender = vi.fn();
  const viewer = {
    scene: {
      preRender: {
        addEventListener: vi.fn((cb: () => void) => {
          updateCallback = cb;
          return removeUpdateListener;
        }),
      },
      primitives: { add: addPrimitive, remove: removePrimitive },
      camera: {
        moveEnd: {
          addEventListener: vi.fn((cb: () => void) => {
            moveEndCallback = cb;
            return removeMoveEndListener;
          }),
        },
        // Resolves zoomTo()'s promise immediately (real geometry isn't needed —
        // that's covered by dedicated zoomTo tests further down).
        flyToBoundingSphere: vi.fn((_sphere: unknown, opts: { complete?: () => void }) => opts.complete?.()),
      },
      canvas: { clientHeight: 600 },
      requestRender,
    },
  } as unknown as Viewer;
  return {
    viewer,
    addPrimitive,
    removePrimitive,
    removeUpdateListener,
    removeMoveEndListener,
    requestRender,
    triggerUpdate: () => updateCallback!(),
    triggerMoveEnd: () => moveEndCallback!(),
  };
}

const fakeViewer = makeFakeViewer().viewer;

/**
 * @param extraNodes Additional non-root keys some update-loop tests stub
 *   selectNodes() to return (e.g. simulating a zoom to a child or
 *   grandchild) — without an entry here, _loadNode() fails looking up
 *   pointDataOffset/pointDataLength for a key the mocked selectNodes()
 *   invented but the hierarchy never actually had. Left empty by default so
 *   nodeCount/maxDepth assertions against the single real root node hold.
 */
function mockCopc(wkt: string | undefined, extraNodes: Record<string, Hierarchy.Node> = {}) {
  create.mockResolvedValueOnce({
    info: {
      cube: [0, 0, 0, 10, 10, 10],
      rootHierarchyPage: { pageOffset: 0, pageLength: 10 },
    },
    // The elevation colour ramp normalizes each point's Z over the header's
    // range, so _loadNode() reads header.min/max on every dispatch.
    header: { min: [0, 0, 0], max: [10, 10, 10] },
    wkt,
  });
  loadHierarchyPage.mockResolvedValueOnce({
    nodes: { '0-0-0-0': { pointCount: 1, pointDataOffset: 0, pointDataLength: 1 }, ...extraNodes },
    pages: {},
  });
}

/** Covers every non-root key the update-loop tests below stub selectNodes() to return. */
const EXTRA_NODES: Record<string, Hierarchy.Node> = {
  '1-0-0-0': { pointCount: 1, pointDataOffset: 1, pointDataLength: 1 },
  '1-1-1-1': { pointCount: 1, pointDataOffset: 2, pointDataLength: 1 },
  '2-0-0-0': { pointCount: 1, pointDataOffset: 3, pointDataLength: 1 },
};

describe('CopcDataSource.load', () => {
  it('auto-detects CRS from WKT when the user does not provide one', async () => {
    const wkt =
      'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
      'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';
    mockCopc(wkt);

    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer);

    expect((ds as unknown as { _options: { proj: string; projDef: string | null } })._options).toMatchObject({
      proj: 'EPSG:4326',
      projDef: null,
    });
  });

  it('lets an explicit projDef option take priority over WKT auto-detection', async () => {
    mockCopc(undefined);

    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer, {
      proj: 'EPSG:5186',
      projDef: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
    });

    expect((ds as unknown as { _options: { proj: string; projDef: string | null } })._options).toMatchObject({
      proj: 'EPSG:5186',
    });
  });

  it('does not throw on destroy()', async () => {
    mockCopc(undefined);
    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer);
    expect(() => ds.destroy()).not.toThrow();
  });

  it('applies zFactor/xyFactor auto-detected from a non-meter WKT', async () => {
    const wkt =
      'PROJCS["NAD83 / California zone 5", GARBAGE, ID["EPSG",2229]], ' +
      'LENGTHUNIT["US survey foot",0.304800609601219]';
    mockCopc(wkt);

    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer);

    const opts = (ds as unknown as { _options: { zFactor: number; xyFactor: number } })._options;
    expect(opts.zFactor).toBeCloseTo(0.3048006096, 8);
    expect(opts.xyFactor).toBeCloseTo(0.3048006096, 8);
  });

  it('still detects zFactor/xyFactor from the WKT when the user provides an explicit proj/projDef', async () => {
    // Regression test for #38: a compound CRS can declare foot-based vertical
    // units even when the caller supplies its own horizontal proj/projDef
    // (e.g. the real Autzen COPC dataset — NAD83 Oregon Lambert (ft) + NAVD88
    // (ftUS)). zFactor/xyFactor detection must not be skipped just because
    // the caller overrode proj/projDef.
    const wkt =
      'PROJCS["NAD83 / California zone 5", GARBAGE, ID["EPSG",2229]], ' +
      'LENGTHUNIT["US survey foot",0.304800609601219]';
    mockCopc(wkt);

    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer, {
      proj: 'EPSG:5186',
      projDef: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
    });

    const opts = (ds as unknown as { _options: { proj: string; projDef: string; zFactor: number; xyFactor: number } })
      ._options;
    expect(opts.proj).toBe('EPSG:5186'); // explicit proj/projDef still wins
    expect(opts.zFactor).toBeCloseTo(0.3048006096, 8);
    expect(opts.xyFactor).toBeCloseTo(0.3048006096, 8);
  });

  it('lets explicit zFactor/xyFactor options take priority over auto-detection', async () => {
    const wkt =
      'PROJCS["NAD83 / California zone 5", GARBAGE, ID["EPSG",2229]], ' +
      'LENGTHUNIT["US survey foot",0.304800609601219]';
    mockCopc(wkt);

    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer, {
      zFactor: 1,
      xyFactor: 1,
    });

    const opts = (ds as unknown as { _options: { zFactor: number; xyFactor: number } })._options;
    expect(opts.zFactor).toBe(1);
    expect(opts.xyFactor).toBe(1);
  });

  it('defaults zFactor/xyFactor to 1 when there is no WKT to detect from', async () => {
    mockCopc(undefined);

    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer);

    const opts = (ds as unknown as { _options: { zFactor: number; xyFactor: number } })._options;
    expect(opts.zFactor).toBe(1);
    expect(opts.xyFactor).toBe(1);
  });

  it('flies the camera to the dataset by default (autoFrame)', async () => {
    mockCopc(undefined);
    const { viewer } = makeFakeViewer();

    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer);

    expect(viewer.scene.camera.flyToBoundingSphere).toHaveBeenCalledTimes(1);
  });

  it('skips camera framing when autoFrame is false', async () => {
    mockCopc(undefined);
    const { viewer } = makeFakeViewer();

    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { autoFrame: false });

    expect(viewer.scene.camera.flyToBoundingSphere).not.toHaveBeenCalled();
  });

  it('reuses an externally-provided WorkerPool instead of constructing its own', async () => {
    mockCopc(undefined);
    const { WorkerPool } = await import('./worker/WorkerPool');
    const externalRun = vi.fn();
    const externalDestroy = vi.fn();
    const externalPool = { run: externalRun, destroy: externalDestroy } as unknown as InstanceType<
      typeof WorkerPool
    >;
    const constructCallsBefore = vi.mocked(WorkerPool).mock.calls.length;

    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer, {}, externalPool);
    ds.destroy();

    expect(vi.mocked(WorkerPool).mock.calls.length).toBe(constructCallsBefore); // no new pool constructed
    expect(externalDestroy).not.toHaveBeenCalled(); // destroy() must not tear down a borrowed pool
  });
});

const renderData: NodeRenderData = {
  positions: new Float32Array([0, 0, 0]),
  origin: [6378137, 0, 0],
  colors: new Uint8Array([255, 0, 0, 255]),
  intensities: new Uint16Array([1000]),
  classifications: new Uint8Array([2]),
  elevations: new Uint16Array([32768]),
  pointCount: 1,
  maxIntensity: 1000,
};

describe('CopcDataSource update loop', () => {
  beforeEach(() => {
    selectNodesMock.mockReturnValue(['0-0-0-0']);
  });

  it('loads a selected node through the worker pool and adds its primitive to the scene', async () => {
    mockCopc(undefined);
    workerPoolRun.mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, requestRender, triggerUpdate } = makeFakeViewer();

    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));

    expect(workerPoolRun).toHaveBeenCalledWith(
      expect.objectContaining({ compressedBytes: expect.any(Uint8Array), proj: 'EPSG:4326' }),
      expect.anything(),
    );
    // Required under `requestRenderMode: true` for the new primitive to actually
    // appear; harmless (no-op) under continuous rendering otherwise.
    expect(requestRender).toHaveBeenCalled();
    // Newly-loaded, still-selected nodes must actually be shown.
    expect(addPrimitive.mock.calls[0][0].show).toBe(true);
  });

  it('does not re-dispatch a node that is already cached on a later update', async () => {
    mockCopc(undefined);
    workerPoolRun.mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, triggerUpdate } = makeFakeViewer();

    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));

    triggerUpdate();

    expect(workerPoolRun).toHaveBeenCalledTimes(1);
    expect(addPrimitive).toHaveBeenCalledTimes(1);
  });

  it('hides a cached node when it drops out of the LoD selection, and re-shows it without re-dispatching if reselected', async () => {
    mockCopc(undefined);
    workerPoolRun.mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, removePrimitive, triggerUpdate } = makeFakeViewer();

    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));
    const primitive = addPrimitive.mock.calls[0][0];
    expect(primitive.show).toBe(true);

    selectNodesMock.mockReturnValue([]); // nothing selected anymore
    triggerUpdate();
    expect(primitive.show).toBe(false);
    expect(removePrimitive).not.toHaveBeenCalled(); // hidden, not evicted from the cache/scene

    selectNodesMock.mockReturnValue(['0-0-0-0']); // selected again
    triggerUpdate();
    expect(primitive.show).toBe(true);
    expect(workerPoolRun).toHaveBeenCalledTimes(1); // never re-dispatched to the worker
  });

  it('cancels a still-pending byte-range fetch when its key drops out of the LoD selection', async () => {
    mockCopc(undefined);
    const pending = makePendingCancellable<Uint8Array>();
    rangeFetcherFetch.mockReturnValueOnce(pending);
    const { viewer, triggerUpdate } = makeFakeViewer();

    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate(); // dispatches the load for '0-0-0-0'; its byte fetch never resolves

    selectNodesMock.mockReturnValue([]); // camera moved on before it finished
    triggerUpdate();

    expect(pending.cancel).toHaveBeenCalledTimes(1);
    expect(workerPoolRun).not.toHaveBeenCalled(); // never even reached the worker stage
  });

  it('cancels a still-pending decode when its key drops out of the LoD selection after its bytes arrived', async () => {
    mockCopc(undefined);
    const pending = makePendingCancellable<NodeRenderData>();
    workerPoolRun.mockReturnValueOnce(pending);
    const { viewer, triggerUpdate } = makeFakeViewer();

    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(workerPoolRun).toHaveBeenCalledTimes(1)); // bytes fetched, now decoding

    selectNodesMock.mockReturnValue([]); // camera moved on before it finished
    triggerUpdate();

    expect(pending.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not log an error for a load cancelled by the selection moving on', async () => {
    mockCopc(undefined);
    let reject!: (err: Error) => void;
    const pending = new Promise<NodeRenderData>((_resolve, rej) => {
      reject = rej;
    }) as Promise<NodeRenderData> & { cancel: () => void };
    pending.cancel = () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      reject(err);
    };
    workerPoolRun.mockReturnValueOnce(pending);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { viewer, triggerUpdate } = makeFakeViewer();

    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(workerPoolRun).toHaveBeenCalledTimes(1));

    selectNodesMock.mockReturnValue([]);
    triggerUpdate(); // triggers pending.cancel(), rejecting with AbortError
    await pending.catch(() => {}); // let _loadNode's catch/finally settle

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('hides a selected node when it falls out of the live frustum, without re-dispatching or evicting it', async () => {
    mockCopc(undefined);
    workerPoolRun.mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, removePrimitive, triggerUpdate } = makeFakeViewer();

    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));
    const primitive = addPrimitive.mock.calls[0][0];
    expect(primitive.show).toBe(true);

    // Exercises the cheap per-frame path directly rather than the throttled
    // preRender hook, so this isn't sensitive to debounceMs vs. real elapsed
    // time (both driven off the same _onPreRender() call otherwise).
    isInFrustumMock.mockReturnValue(false);
    (ds as unknown as { _updateVisibility(): void })._updateVisibility();

    expect(primitive.show).toBe(false);
    expect(workerPoolRun).toHaveBeenCalledTimes(1);
    expect(removePrimitive).not.toHaveBeenCalled();
  });

  it('keeps a node visible until its replacement children are ready, instead of leaving a gap (zoom in)', async () => {
    mockCopc(undefined, EXTRA_NODES);
    workerPoolRun.mockResolvedValueOnce(renderData).mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, removePrimitive, triggerUpdate } = makeFakeViewer();

    selectNodesMock.mockReturnValue(['0-0-0-0']);
    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));
    const parentPrimitive = addPrimitive.mock.calls[0][0];
    expect(parentPrimitive.show).toBe(true);

    // Camera "zooms in": a child of '0-0-0-0' is selected instead of the
    // parent. The child isn't cached yet (the worker hasn't resolved), so
    // the parent must stay visible rather than leaving a gap.
    selectNodesMock.mockReturnValue(['1-0-0-0']);
    triggerUpdate();

    expect(parentPrimitive.show).toBe(true);
    expect(removePrimitive).not.toHaveBeenCalled();

    // Once the child finishes loading (which itself calls requestRender(),
    // triggering the next preRender in a real requestRenderMode viewer), the
    // following LoD pass finally hides the parent.
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(2));
    const childPrimitive = addPrimitive.mock.calls[1][0];
    expect(childPrimitive.show).toBe(true);
    triggerUpdate();
    expect(parentPrimitive.show).toBe(false);
  });

  it('keeps children visible until the merged parent replacement is ready, instead of leaving a gap (zoom out)', async () => {
    mockCopc(undefined, EXTRA_NODES);
    workerPoolRun.mockResolvedValueOnce(renderData).mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, removePrimitive, triggerUpdate } = makeFakeViewer();

    selectNodesMock.mockReturnValue(['1-0-0-0']);
    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));
    const childPrimitive = addPrimitive.mock.calls[0][0];
    expect(childPrimitive.show).toBe(true);

    // Camera "zooms out": the parent '0-0-0-0' is selected instead of the
    // child. The parent isn't cached (e.g. evicted earlier), so the child
    // must stay visible rather than leaving a gap.
    selectNodesMock.mockReturnValue(['0-0-0-0']);
    triggerUpdate();

    expect(childPrimitive.show).toBe(true);
    expect(removePrimitive).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(2));
    const parentPrimitive = addPrimitive.mock.calls[1][0];
    expect(parentPrimitive.show).toBe(true);
    triggerUpdate();
    expect(childPrimitive.show).toBe(false);
  });

  it('keeps a node visible when the selection jumps straight to its grandchild (fast zoom in)', async () => {
    // Regression test for #66: one mouse wheel notch is worth roughly 1-1.5
    // levels of screen-space error and debounceMs collapses several notches
    // into one LoD pass, so a cut that moves two levels at once is the normal
    // case, not an edge case. A grandchild covers the outgoing node's area
    // just as a direct child does, so the same "wait for the replacement"
    // rule has to apply.
    mockCopc(undefined, EXTRA_NODES);
    workerPoolRun.mockResolvedValue(renderData);
    const { viewer, addPrimitive, removePrimitive, triggerUpdate } = makeFakeViewer();

    selectNodesMock.mockReturnValue(['0-0-0-0']);
    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));
    const rootPrimitive = addPrimitive.mock.calls[0][0];
    expect(rootPrimitive.show).toBe(true);

    selectNodesMock.mockReturnValue(['2-0-0-0']);
    triggerUpdate();

    expect(rootPrimitive.show).toBe(true);
    expect(removePrimitive).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(2));
    expect(addPrimitive.mock.calls[1][0].show).toBe(true);
    triggerUpdate();
    expect(rootPrimitive.show).toBe(false);
  });

  it('keeps a node visible when the selection jumps straight to its grandparent (fast zoom out)', async () => {
    mockCopc(undefined, EXTRA_NODES);
    workerPoolRun.mockResolvedValue(renderData);
    const { viewer, addPrimitive, removePrimitive, triggerUpdate } = makeFakeViewer();

    selectNodesMock.mockReturnValue(['2-0-0-0']);
    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));
    const deepPrimitive = addPrimitive.mock.calls[0][0];
    expect(deepPrimitive.show).toBe(true);

    selectNodesMock.mockReturnValue(['0-0-0-0']);
    triggerUpdate();

    expect(deepPrimitive.show).toBe(true);
    expect(removePrimitive).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(2));
    expect(addPrimitive.mock.calls[1][0].show).toBe(true);
    triggerUpdate();
    expect(deepPrimitive.show).toBe(false);
  });

  it('hides a deselected node immediately when nothing in the new selection replaces it (e.g. it left the frustum)', async () => {
    mockCopc(undefined, EXTRA_NODES);
    workerPoolRun.mockResolvedValueOnce(renderData).mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, triggerUpdate } = makeFakeViewer();

    selectNodesMock.mockReturnValue(['1-1-1-1']);
    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));
    const primitive = addPrimitive.mock.calls[0][0];
    expect(primitive.show).toBe(true);

    // '1-0-0-0' is a sibling, not a parent or child of '1-1-1-1' -- nothing
    // in the new selection will visually cover '1-1-1-1''s absence.
    selectNodesMock.mockReturnValue(['1-0-0-0']);
    triggerUpdate();

    expect(primitive.show).toBe(false);
  });

  it('camera.moveEnd runs the LoD pass immediately, bypassing the debounce', async () => {
    mockCopc(undefined);
    workerPoolRun.mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, triggerMoveEnd } = makeFakeViewer();

    await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 1_000_000 });
    triggerMoveEnd();

    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));
  });

  it('destroy() tears down the worker pool and node cache, and removes both listeners', async () => {
    mockCopc(undefined);
    workerPoolRun.mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, removePrimitive, removeUpdateListener, removeMoveEndListener, triggerUpdate } =
      makeFakeViewer();

    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    // Wait for the node to actually reach NodeCache (right after scene.primitives.add),
    // not just for the worker to resolve, so destroy() has something to tear down.
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));

    ds.destroy();

    expect(removeUpdateListener).toHaveBeenCalledTimes(1);
    expect(removeMoveEndListener).toHaveBeenCalledTimes(1);
    expect(workerPoolDestroy).toHaveBeenCalledTimes(1);
    expect(rangeFetcherDestroy).toHaveBeenCalledTimes(1);
    expect(removePrimitive).toHaveBeenCalledTimes(1);
  });
});

describe('CopcDataSource runtime API', () => {
  beforeEach(() => {
    selectNodesMock.mockReturnValue([]);
  });

  it('pixelSize get/set writes the shared ref and requests a render', async () => {
    mockCopc(undefined);
    const { viewer, requestRender } = makeFakeViewer();
    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { pixelSize: 2 });
    requestRender.mockClear(); // ignore the render(s) requested during load()

    expect(ds.pixelSize).toBe(2);
    ds.pixelSize = 5;
    expect(ds.pixelSize).toBe(5);
    expect(requestRender).toHaveBeenCalled();
  });

  it('heightOffset get/set writes the shared ref and requests a render', async () => {
    mockCopc(undefined);
    const { viewer, requestRender } = makeFakeViewer();
    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', viewer);
    requestRender.mockClear(); // ignore the render(s) requested during load()

    expect(ds.heightOffset).toBe(0);
    ds.heightOffset = -12.5;
    expect(ds.heightOffset).toBe(-12.5);
    expect(requestRender).toHaveBeenCalled();
  });

  it('sseThreshold get/set triggers an immediate LoD pass', async () => {
    mockCopc(undefined);
    const { viewer } = makeFakeViewer();
    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, {
      sseThreshold: 250,
      debounceMs: 1_000_000,
    });
    selectNodesMock.mockClear();

    expect(ds.sseThreshold).toBe(250);
    ds.sseThreshold = 100;
    expect(ds.sseThreshold).toBe(100);
    expect(selectNodesMock).toHaveBeenCalledWith(expect.objectContaining({ sseThreshold: 100 }));
  });

  it('changes colorMode without re-dispatching any node to the worker', async () => {
    // The whole point of the styling API: colour lives in a uniform, so the
    // cached nodes and their GPU buffers are untouched by a mode switch.
    mockCopc(undefined);
    selectNodesMock.mockReturnValue(['0-0-0-0']);
    workerPoolRun.mockResolvedValueOnce(renderData);
    const { viewer, addPrimitive, requestRender, triggerUpdate } = makeFakeViewer();
    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));

    const dispatchesBefore = workerPoolRun.mock.calls.length;
    requestRender.mockClear();
    expect(ds.colorMode).toBe('rgb');

    ds.colorMode = 'intensity';

    expect(ds.colorMode).toBe('intensity');
    expect(workerPoolRun.mock.calls.length).toBe(dispatchesBefore);
    expect(ds.cacheSize).toBe(1);
    expect(requestRender).toHaveBeenCalled();
  });

  it('applies classificationFilter to the shared style, and rejects a non-classification value', async () => {
    mockCopc(undefined);
    const { viewer, requestRender } = makeFakeViewer();
    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', viewer);

    expect(ds.classificationFilter).toBeUndefined();
    ds.classificationFilter = [2, 6];
    expect(ds.classificationFilter).toEqual([2, 6]);
    expect(requestRender).toHaveBeenCalled();

    // The mask is built before anything is assigned, so a bad value leaves the
    // previous filter in place rather than half-applying the new one.
    expect(() => (ds.classificationFilter = [2, 999])).toThrow(RangeError);
    expect(ds.classificationFilter).toEqual([2, 6]);
  });

  it('grows the intensity range as nodes load, and stops once the caller pins it', async () => {
    mockCopc(undefined, EXTRA_NODES);
    selectNodesMock.mockReturnValue(['0-0-0-0']);
    workerPoolRun.mockResolvedValueOnce({ ...renderData, maxIntensity: 4095 });
    const { viewer, addPrimitive, triggerUpdate } = makeFakeViewer();
    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', viewer, { debounceMs: 0 });

    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(1));

    // LAS producers rarely fill the 16-bit span, so a fixed 0-65535 mapping
    // would render this file nearly black.
    expect(ds.intensityRange).toEqual([0, 4095]);

    ds.intensityRange = [0, 1000];
    expect(ds.intensityRange).toEqual([0, 1000]);

    // A later, brighter node must not widen a range the caller pinned.
    selectNodesMock.mockReturnValue(['0-0-0-0', '1-0-0-0']);
    workerPoolRun.mockResolvedValueOnce({ ...renderData, maxIntensity: 60000 });
    triggerUpdate();
    await vi.waitFor(() => expect(addPrimitive).toHaveBeenCalledTimes(2));
    expect(ds.intensityRange).toEqual([0, 1000]);
  });

  it('honours colorMode/classificationFilter/intensityRange passed to load()', async () => {
    mockCopc(undefined);
    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer, {
      colorMode: 'classification',
      classificationFilter: [2],
      intensityRange: [10, 500],
    });

    expect(ds.colorMode).toBe('classification');
    expect(ds.classificationFilter).toEqual([2]);
    expect(ds.intensityRange).toEqual([10, 500]);
  });

  it('exposes maxDepth/nodeCount/cacheSize as read-only state', async () => {
    mockCopc(undefined);
    const ds = await CopcDataSource.load('https://example.com/sample.copc.laz', fakeViewer);

    expect(ds.nodeCount).toBe(1); // the single '0-0-0-0' node from mockCopc()'s fixture
    expect(ds.maxDepth).toBe(0);
    expect(ds.cacheSize).toBe(0); // nothing loaded yet
  });
});
