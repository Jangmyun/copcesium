/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun), 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadScheduler, type LoadSchedulerDeps } from './LoadScheduler';

// A fetch that never resolves until cancelled, so a load stays pending.
function makeScheduler(prefetchLookaheadMs: number | undefined) {
  const cancel = vi.fn();
  const fetch = vi.fn(() => Object.assign(new Promise<Uint8Array>(() => {}), { cancel }));
  const scheduler = new LoadScheduler({
    options: {
      decodeBackpressure: false,
      prefetchIdleOnly: false,
      proj: 'EPSG:4326',
      projDef: null,
      geoidOffset: 0,
      zFactor: 1,
      prefetchLookaheadMs,
    },
    nodes: { k: { pointCount: 1, pointDataOffset: 0, pointDataLength: 1 } },
    rangeFetcher: { fetch },
    workerPool: { concurrency: 5, backlog: 0 },
    nodeCache: { peek: () => undefined },
    stages: { record: () => {} },
    isDestroyed: () => false,
    isSelected: () => false,
  } as unknown as LoadSchedulerDeps);
  scheduler.commit(new Set(), [], new Set(['k'])); // starts the prefetch load of "k"
  return { scheduler, cancel };
}

describe('LoadScheduler prefetch cancel grace', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps a briefly-dropped prefetch load and cancels it after the grace period', () => {
    const { scheduler, cancel } = makeScheduler(250);
    expect(scheduler.isPending('k')).toBe(true);

    scheduler.cancelStale(new Set(), new Set()); // first absence starts the clock
    vi.advanceTimersByTime(200);
    scheduler.cancelStale(new Set(), new Set());
    expect(cancel).not.toHaveBeenCalled();

    scheduler.cancelStale(new Set(), new Set(['k'])); // back in the set: clock resets
    vi.advanceTimersByTime(200);
    scheduler.cancelStale(new Set(), new Set());
    vi.advanceTimersByTime(200);
    scheduler.cancelStale(new Set(), new Set());
    expect(cancel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200); // 400 ms absent
    scheduler.cancelStale(new Set(), new Set());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels immediately when the option is off', () => {
    const { scheduler, cancel } = makeScheduler(undefined);
    scheduler.cancelStale(new Set(), new Set());
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('LoadScheduler eye-dome lighting', () => {
  it('hands the shared EDL to every node primitive it creates', async () => {
    const loadNode = await import('./loadNode');
    const primitive = { show: false, destroy: vi.fn() };
    const create = vi.spyOn(loadNode, 'createNodePrimitive').mockResolvedValue(primitive as never);
    const edl = {};
    const done = Object.assign(Promise.resolve(new Uint8Array(1)), { cancel: () => {} });
    const decoded = Object.assign(Promise.resolve({ pointCount: 1, maxIntensity: 0 }), {
      cancel: () => {},
    });
    const scheduler = new LoadScheduler({
      options: {
        decodeBackpressure: false,
        prefetchIdleOnly: false,
        preUploadHidden: false,
        proj: 'EPSG:4326',
        projDef: null,
        geoidOffset: 0,
        zFactor: 1,
      },
      viewer: { scene: { primitives: { add: vi.fn() }, requestRender: vi.fn() } },
      copc: { header: { min: [0, 0, 0], max: [0, 0, 1] } },
      nodes: { k: { pointCount: 1, pointDataOffset: 0, pointDataLength: 1 } },
      rangeFetcher: { fetch: () => done },
      workerPool: { run: () => decoded },
      nodeCache: { set: vi.fn() },
      stages: { record: () => {} },
      style: { style: {}, growAutoIntensityRange: () => {} },
      edl,
      getSphere: () => ({}),
      isDestroyed: () => false,
      isSelected: () => true,
    } as unknown as LoadSchedulerDeps);

    await scheduler.load('k');

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][4]).toMatchObject({ edl });
    create.mockRestore();
  });
});

describe('LoadScheduler compressed-bytes cache', () => {
  // Decode ends the load with an AbortError, so only the fetch path is exercised.
  function makeLoader(cached: Uint8Array | undefined) {
    const fetch = vi.fn(() =>
      Object.assign(Promise.resolve(new Uint8Array([1, 2, 3])), { cancel: vi.fn() }),
    );
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const run = vi.fn(() => Object.assign(Promise.reject(abort), { cancel: vi.fn() }));
    const compressedBytes = { get: vi.fn(() => cached), set: vi.fn() };
    const scheduler = new LoadScheduler({
      options: {
        decodeBackpressure: false,
        prefetchIdleOnly: false,
        proj: 'EPSG:4326',
        projDef: null,
        geoidOffset: 0,
        zFactor: 1,
      },
      copc: { header: { min: [0, 0, 0], max: [1, 1, 1] }, eb: [] },
      nodes: { k: { pointCount: 1, pointDataOffset: 10, pointDataLength: 3 } },
      rangeFetcher: { fetch },
      workerPool: { concurrency: 5, backlog: 0, run },
      nodeCache: { peek: () => undefined },
      compressedBytes,
      stages: { record: () => {} },
      isDestroyed: () => false,
      isSelected: () => false,
    } as unknown as LoadSchedulerDeps);
    return { scheduler, fetch, run, compressedBytes };
  }

  it('decodes a cached node without a request', async () => {
    const { scheduler, fetch, run, compressedBytes } = makeLoader(new Uint8Array([9, 9, 9]));
    await scheduler.load('k');
    expect(fetch).not.toHaveBeenCalled();
    expect(compressedBytes.set).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.compressedHits).toBe(1);
  });

  it('fetches and stores a node the cache does not have', async () => {
    const { scheduler, fetch, compressedBytes } = makeLoader(undefined);
    await scheduler.load('k');
    expect(fetch).toHaveBeenCalledWith(10, 13);
    expect(compressedBytes.set).toHaveBeenCalledWith('k', new Uint8Array([1, 2, 3]));
    expect(scheduler.compressedHits).toBe(0);
  });
});
