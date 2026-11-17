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
