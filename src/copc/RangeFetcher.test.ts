/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangeFetcher } from './RangeFetcher';
import { TransferCounter } from './TransferCounter';

/** A successful Range response: 206, since every request this class makes
 *  carries a `Range` header. */
function fakeResponse(bytes: Uint8Array) {
  return { status: 206, arrayBuffer: async () => bytes.buffer };
}

/** A response the server answered with, but not a usable Range payload. */
function statusResponse(status: number, bytes = new Uint8Array(0)) {
  return { status, arrayBuffer: async () => bytes.buffer };
}

/** Fakes only `setTimeout`, so retry backoff is instant while the microtask
 *  queue `_scheduleFlush()` relies on keeps running for real. */
function useFakeBackoff() {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
}

/** All bytes at index `i` equal `i`, so a slice's own content proves which
 *  offset range it came from. */
function makeSourceBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 256;
  return bytes;
}

/** The grouping `RangeFetcher` used before the adaptive gap and tail
 *  bridging were added (1.4.1), as the Range headers it would send. */
function legacyRanges(requests: [number, number][], gapBytes: number, maxGroupBytes: number): string[] {
  const sorted = [...requests].sort((a, b) => a[0] - b[0]);
  const groups: [number, number][][] = [];
  for (const req of sorted) {
    const group = groups[groups.length - 1];
    const last = group?.[group.length - 1];
    const spanIfAdded = group ? req[1] - group[0]![0] : 0;
    if (last && req[0] - last[1] <= gapBytes && spanIfAdded <= maxGroupBytes) group.push(req);
    else groups.push([req]);
  }
  return groups.map((g) => `bytes=${g[0]![0]}-${g[g.length - 1]![1] - 1}`);
}

/** Small deterministic PRNG, so a failing case can be replayed. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

describe('RangeFetcher', () => {
  describe('with the network options off', () => {
    afterEach(() => vi.unstubAllGlobals());

    for (const gapBytes of [0, 4096]) {
      it(`sends exactly the 1.4.1 requests for random batches (gapBytes ${gapBytes})`, async () => {
        const rand = lcg(20261114 + gapBytes);
        for (let round = 0; round < 50; round++) {
          const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { headers: { Range: string } }) => {
            const [, from, to] = init.headers.Range.match(/bytes=(\d+)-(\d+)/)!;
            return fakeResponse(new Uint8Array(Number(to) - Number(from) + 1));
          });
          vi.stubGlobal('fetch', fetchMock);
          // Same constructor arguments CopcDataSource passes with both options off.
          const fetcher = new RangeFetcher('https://example.com/f.copc.laz', gapBytes, undefined, 1000);
          const requests: [number, number][] = [];
          let at = 0;
          for (let i = 0; i < 1 + Math.floor(rand() * 30); i++) {
            at += Math.floor(rand() * 3) === 0 ? 0 : Math.floor(rand() * 8192);
            const length = 1 + Math.floor(rand() * 200_000);
            requests.push([at, at + length]);
            at += length;
          }
          // Asked in a shuffled order; a slack end is passed for half of them
          // and must change nothing while tailGapBytes is 0.
          const asked = [...requests].sort(() => rand() - 0.5);
          await Promise.all(asked.map(([b, e]) => (rand() < 0.5 ? fetcher.fetch(b, e, e + 50_000) : fetcher.fetch(b, e))));

          // Same ranges as 1.4.1; their dispatch order is request order since #249.
          const sent = fetchMock.mock.calls.map((call) => call[1].headers.Range as string);
          expect([...sent].sort()).toEqual([...legacyRanges(requests, gapBytes, 512 * 1024)].sort());
        }
      });
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('ranges inside other ranges, and empty ranges', () => {
    /** Serves whatever range is asked for out of one source buffer. */
    function serve(length: number) {
      const source = makeSourceBytes(length);
      const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { headers: { Range: string } }) => {
        const [, from, to] = init.headers.Range.match(/bytes=(\d+)-(\d+)/)!;
        if (Number(to) < Number(from)) return statusResponse(416);
        return fakeResponse(source.slice(Number(from), Number(to) + 1));
      });
      vi.stubGlobal('fetch', fetchMock);
      return { source, fetchMock };
    }

    it('fetches to the furthest end when one request lies inside another', async () => {
      const { source, fetchMock } = serve(100);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const [outer, inner] = await Promise.all([fetcher.fetch(0, 100), fetcher.fetch(20, 30)]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1].headers.Range).toBe('bytes=0-99');
      expect(Array.from(outer)).toEqual(Array.from(source));
      expect(Array.from(inner)).toEqual(Array.from(source.slice(20, 30)));
    });

    it('measures the gap to the next request from the furthest end, not the inner one', async () => {
      const { source, fetchMock } = serve(110);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const [outer, , after] = await Promise.all([
        fetcher.fetch(0, 100),
        fetcher.fetch(20, 30),
        fetcher.fetch(100, 110), // contiguous with the outer range
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1].headers.Range).toBe('bytes=0-109');
      expect(Array.from(outer)).toEqual(Array.from(source.slice(0, 100)));
      expect(Array.from(after)).toEqual(Array.from(source.slice(100, 110)));
    });

    it('resolves an empty range without a request', async () => {
      const { fetchMock } = serve(100);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      await expect(fetcher.fetch(50, 50)).resolves.toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('leaves the other requests of a batch alone when one of them is empty', async () => {
      const { source, fetchMock } = serve(40);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const [a, empty, b] = await Promise.all([fetcher.fetch(0, 20), fetcher.fetch(20, 20), fetcher.fetch(20, 40)]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1].headers.Range).toBe('bytes=0-39');
      expect(Array.from(a)).toEqual(Array.from(source.slice(0, 20)));
      expect(empty).toHaveLength(0);
      expect(Array.from(b)).toEqual(Array.from(source.slice(20, 40)));
    });

    // The fix only changes batches with a range inside another (or an empty
    // one). Everything else must still group exactly as 1.4.1 did.
    for (const gapBytes of [0, 4096]) {
      it(`groups non-overlapping batches exactly as before (gapBytes ${gapBytes})`, async () => {
        let s = 20261114 + gapBytes;
        const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
        for (let round = 0; round < 50; round++) {
          const { fetchMock } = serve(0);
          fetchMock.mockImplementation(async (_url: string, init: { headers: { Range: string } }) => {
            const [, from, to] = init.headers.Range.match(/bytes=(\d+)-(\d+)/)!;
            return fakeResponse(new Uint8Array(Number(to) - Number(from) + 1));
          });
          const fetcher = new RangeFetcher('https://example.com/f.copc.laz', gapBytes, undefined, 1000);
          const requests: [number, number][] = [];
          let at = 0;
          for (let i = 0; i < 1 + Math.floor(rand() * 30); i++) {
            at += Math.floor(rand() * 3) === 0 ? 0 : Math.floor(rand() * 8192);
            const length = 1 + Math.floor(rand() * 200_000);
            requests.push([at, at + length]);
            at += length;
          }
          await Promise.all([...requests].sort(() => rand() - 0.5).map(([b, e]) => fetcher.fetch(b, e)));

          // 1.4.1's grouping: offset order, next gap measured from the last member.
          const legacy: string[] = [];
          let group: [number, number][] = [];
          for (const req of [...requests].sort((x, y) => x[0] - y[0])) {
            const last = group[group.length - 1];
            if (last && req[0] - last[1] <= gapBytes && req[1] - group[0]![0] <= 512 * 1024) group.push(req);
            else {
              if (group.length) legacy.push(`bytes=${group[0]![0]}-${group[group.length - 1]![1] - 1}`);
              group = [req];
            }
          }
          legacy.push(`bytes=${group[0]![0]}-${group[group.length - 1]![1] - 1}`);

          // Same groups; their dispatch order is request order now, not offset order.
          const sent = fetchMock.mock.calls.map((call) => call[1].headers.Range as string);
          expect([...sent].sort()).toEqual([...legacy].sort());
          vi.unstubAllGlobals();
        }
      });
    }
  });

  it('merges two adjacent requests queued in the same tick into one HTTP request', async () => {
    const source = makeSourceBytes(20);
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(source.slice(0, 20)));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

    const a = fetcher.fetch(0, 10);
    const b = fetcher.fetch(10, 20);
    const [aBytes, bBytes] = await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.copc.laz', {
      headers: { Range: 'bytes=0-19' },
      signal: expect.any(AbortSignal),
    });
    expect(Array.from(aBytes)).toEqual(Array.from(source.slice(0, 10)));
    expect(Array.from(bBytes)).toEqual(Array.from(source.slice(10, 20)));
  });

  it('does not merge requests separated by more than the gap threshold', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(makeSourceBytes(10)))
      .mockResolvedValueOnce(fakeResponse(makeSourceBytes(10)));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0); // no gap tolerance

    await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(1000, 1010)]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.copc.laz', {
      headers: { Range: 'bytes=0-9' },
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.copc.laz', {
      headers: { Range: 'bytes=1000-1009' },
      signal: expect.any(AbortSignal),
    });
  });

  it('merges requests within the configured gap threshold', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(makeSourceBytes(30)));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 10); // tolerate a 10-byte gap

    await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(15, 25)]); // 5-byte gap, within tolerance

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.copc.laz', {
      headers: { Range: 'bytes=0-24' },
      signal: expect.any(AbortSignal),
    });
  });

  it('splits a group once merging would exceed the configured max group size', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(makeSourceBytes(10)))
      .mockResolvedValueOnce(fakeResponse(makeSourceBytes(10)));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, 10); // 10-byte cap

    // adjacent (gap 0, would normally merge) but their combined span (15) exceeds the 10-byte cap
    await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(10, 15)]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.copc.laz', {
      headers: { Range: 'bytes=0-9' },
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.copc.laz', {
      headers: { Range: 'bytes=10-14' },
      signal: expect.any(AbortSignal),
    });
  });

  it('still fetches a single request that alone exceeds the max group size', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(makeSourceBytes(20)));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, 10); // 10-byte cap

    const bytes = await fetcher.fetch(0, 20); // a lone 20-byte request, already over the cap

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('merges requests queued out of offset order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(makeSourceBytes(20)));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

    // dispatched later-offset-first, as a LoD pass might for a re-ordered node list
    const [, aBytes] = await Promise.all([fetcher.fetch(10, 20), fetcher.fetch(0, 10)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Array.from(aBytes)).toEqual(Array.from(makeSourceBytes(20).slice(0, 10)));
  });

  it('rejects a cancelled request without waiting for a network round trip, when cancelled before the batch flushes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(makeSourceBytes(10)));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

    const cancelled = fetcher.fetch(0, 10);
    cancelled.cancel();
    const kept = fetcher.fetch(20, 30);

    await expect(cancelled).rejects.toThrow(/cancelled/);
    await expect(kept).resolves.toBeInstanceOf(Uint8Array);
    // the cancelled request never went into a merge group or a fetch at all
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.copc.laz', {
      headers: { Range: 'bytes=20-29' },
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects a request cancelled after its group fetch already started, without affecting or aborting for its still-wanted siblings', async () => {
    let resolveFetch!: (value: ReturnType<typeof fakeResponse>) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

    const cancelled = fetcher.fetch(0, 10);
    const kept = fetcher.fetch(10, 20);
    await Promise.resolve(); // let the microtask-scheduled flush dispatch the merged fetch
    cancelled.cancel(); // one sibling still wants this group's result, so the fetch itself must keep going
    resolveFetch(fakeResponse(makeSourceBytes(20)));

    await expect(cancelled).rejects.toThrow(/cancelled/);
    await expect(kept).resolves.toBeInstanceOf(Uint8Array);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one shared request for both, never aborted
  });

  it('aborts an in-flight group fetch once every one of its members has been cancelled', async () => {
    const fetchMock = vi.fn((_url: string, opts: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

    const a = fetcher.fetch(0, 10);
    const b = fetcher.fetch(10, 20);
    await Promise.resolve(); // let the microtask-scheduled flush dispatch the merged fetch

    a.cancel(); // one sibling still wanted -> must not abort yet
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(false);
    b.cancel(); // the last live member drops out -> nobody wants this group's bytes anymore

    await expect(a).rejects.toThrow(/AbortError|aborted/i);
    await expect(b).rejects.toThrow(/AbortError|aborted/i);
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it('rejects every request in a group when its fetch fails', async () => {
    useFakeBackoff(); // a network-level failure is retried; skip the backoff waits
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

    const a = fetcher.fetch(0, 10);
    const b = fetcher.fetch(10, 20);
    // Attached before the timers run: `runAllTimersAsync()` settles the
    // rejection, and a handler added only afterwards arrives too late to
    // count as handled.
    const rejections = Promise.all([
      expect(a).rejects.toThrow('network down'),
      expect(b).rejects.toThrow('network down'),
    ]);
    await vi.runAllTimersAsync();

    await rejections;
  });

  describe('waste accounting', () => {
    const url = 'https://example.com/file.copc.laz';

    it('counts merge-gap bytes as received but unused', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(makeSourceBytes(30))));
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 10, undefined, undefined, counter);

      await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(20, 30)]);

      expect(counter.transferredBytes).toBe(30);
      expect(counter.waste.unusedBytes).toBe(10);
    });

    it('counts overlapping members once', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(makeSourceBytes(30))));
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, counter);

      await Promise.all([fetcher.fetch(0, 20), fetcher.fetch(10, 30)]);

      expect(counter.waste.unusedBytes).toBe(0);
    });

    it('counts the slice of a member cancelled while its group was in flight as unused', async () => {
      let respond!: () => void;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValue(
          new Promise((resolve) => {
            respond = () => resolve(fakeResponse(makeSourceBytes(20)));
          }),
        ),
      );
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, counter);

      const a = fetcher.fetch(0, 10);
      const b = fetcher.fetch(10, 20);
      await Promise.resolve();
      b.cancel();
      const rejected = expect(b).rejects.toThrow(/cancelled/);
      respond();

      await a;
      await rejected;
      expect(counter.waste.unusedBytes).toBe(10);
      expect(counter.waste.abortedRequests).toBe(0);
    });

    it('counts a fetch aborted before its headers arrived', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, opts: { signal: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }),
      );
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, counter);

      const request = fetcher.fetch(0, 100);
      await Promise.resolve();
      request.cancel();

      await expect(request).rejects.toThrow(/aborted/i);
      expect(counter.waste).toMatchObject({ abortedRequests: 1, abortedAfterHeaders: 0, abortedBytes: 100 });
      expect(counter.requestCount).toBe(0);
    });

    it('counts a fetch aborted while its body was downloading', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, opts: { signal: AbortSignal }) => ({
          status: 206,
          arrayBuffer: () =>
            new Promise((_resolve, reject) => {
              opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            }),
        })),
      );
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, counter);

      const request = fetcher.fetch(0, 100);
      await new Promise((resolve) => setTimeout(resolve, 0));
      request.cancel();

      await expect(request).rejects.toThrow(/aborted/i);
      expect(counter.waste).toMatchObject({ abortedRequests: 1, abortedAfterHeaders: 1, abortedBytes: 100 });
    });

    it('counts each failed attempt and each retry, next to the one response that delivered', async () => {
      useFakeBackoff();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(statusResponse(503))
          .mockRejectedValueOnce(new Error('network down'))
          .mockResolvedValueOnce(fakeResponse(makeSourceBytes(10))),
      );
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, counter);

      const request = fetcher.fetch(0, 10);
      await vi.runAllTimersAsync();

      await expect(request).resolves.toHaveLength(10);
      expect(counter.waste).toMatchObject({ failedRequests: 2, failedBytes: 20, retries: 2 });
      expect(counter.requestCount).toBe(1);
    });

    it('does not count a retry that a cancellation during the backoff stopped from being sent', async () => {
      useFakeBackoff();
      const fetchMock = vi.fn().mockResolvedValue(statusResponse(503));
      vi.stubGlobal('fetch', fetchMock);
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, counter);

      const request = fetcher.fetch(0, 10);
      const rejected = expect(request).rejects.toThrow(/cancelled/);
      await vi.waitFor(() => expect(counter.waste.failedRequests).toBe(1));
      request.cancel(); // during the first backoff
      await vi.runAllTimersAsync();

      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(counter.waste).toMatchObject({ failedRequests: 1, retries: 0, abortedRequests: 0 });
    });

    it('keeps the totals it already had when no fetch goes wrong', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(makeSourceBytes(20))));
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, counter);

      await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(10, 20)]);

      expect(counter.requestCount).toBe(1);
      expect(counter.transferredBytes).toBe(20);
      expect(counter.waste).toEqual({
        abortedRequests: 0,
        abortedAfterHeaders: 0,
        abortedBytes: 0,
        failedRequests: 0,
        failedBytes: 0,
        retries: 0,
        unusedBytes: 0,
        cancelledBeforeSend: 0,
      });
    });

    it('does not count a retry for a failure that is not retried', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(statusResponse(404)));
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, counter);

      await expect(fetcher.fetch(0, 10)).rejects.toThrow(/404/);

      expect(counter.waste).toMatchObject({ failedRequests: 1, retries: 0 });
    });

    it('counts requests cancelled before any fetch was made, at no byte cost', async () => {
      const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal('fetch', fetchMock);
      const counter = new TransferCounter();
      const fetcher = new RangeFetcher(url, 0, undefined, 1, counter);

      fetcher.fetch(0, 10); // takes the only slot
      const queued = fetcher.fetch(1000, 1010);
      const unflushed = fetcher.fetch(5000, 5010);
      unflushed.cancel(); // before the flush
      await Promise.resolve();
      queued.cancel(); // flushed, waiting for the slot

      await expect(queued).rejects.toThrow(/cancelled/);
      await expect(unflushed).rejects.toThrow(/cancelled/);
      expect(counter.waste).toMatchObject({ cancelledBeforeSend: 2, abortedRequests: 0, abortedBytes: 0 });
    });
  });

  describe('response status', () => {
    it('rejects a non-206 response instead of decoding the error body as data', async () => {
      const fetchMock = vi.fn().mockResolvedValue(statusResponse(403));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      // The status has to reach the caller — the whole point of #117 is that
      // it previously surfaced as an opaque LAZ decode error much further down.
      await expect(fetcher.fetch(0, 100)).rejects.toThrow(/403/);
    });

    it('rejects a 200 whole-file response rather than slicing it at range offsets', async () => {
      // A server that ignores Range answers 200 with the entire file. `ok` is
      // true, so an `ok`-only check would slice these bytes at range-relative
      // offsets and hand back data from the wrong part of the file.
      const wholeFile = makeSourceBytes(5000);
      const fetchMock = vi.fn().mockResolvedValue(statusResponse(200, wholeFile));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      await expect(fetcher.fetch(1000, 1010)).rejects.toThrow(/200/);
    });

    it('does not retry a 4xx — an expired URL or bad range will not fix itself', async () => {
      useFakeBackoff();
      const fetchMock = vi.fn().mockResolvedValue(statusResponse(416));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const request = fetcher.fetch(0, 10);
      const rejection = expect(request).rejects.toThrow(/416/);
      await vi.runAllTimersAsync();

      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('stalled and short responses', () => {
    /** A fetch that never answers until its signal aborts, like a dead connection. */
    function hangingFetch() {
      return (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
    }

    /** A 206 whose body arrives as `chunks`, one every `everyMs`. */
    function trickleResponse(chunks: Uint8Array[], everyMs: number) {
      let i = 0;
      return {
        status: 206,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            return new Promise<void>((resolve) =>
              setTimeout(() => {
                if (i < chunks.length) controller.enqueue(chunks[i++]!);
                else controller.close();
                resolve();
              }, everyMs),
            );
          },
        }),
      };
    }

    it('abandons an attempt the server stops answering, and retries it', async () => {
      useFakeBackoff();
      const source = makeSourceBytes(10);
      const fetchMock = vi.fn().mockImplementationOnce(hangingFetch()).mockResolvedValueOnce(fakeResponse(source));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, undefined, undefined, 1000);

      const request = fetcher.fetch(0, 10);
      await vi.runAllTimersAsync();

      expect(Array.from(await request)).toEqual(Array.from(source));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects with a TimeoutError once every attempt stalls', async () => {
      useFakeBackoff();
      const fetchMock = vi.fn().mockImplementation(hangingFetch());
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, undefined, undefined, 1000);

      const request = fetcher.fetch(0, 10);
      const rejection = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.runAllTimersAsync();

      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not cut off a body that keeps arriving, however long it takes in total', async () => {
      useFakeBackoff();
      const source = makeSourceBytes(30);
      // 600 ms between chunks against a 1000 ms idle limit: 2.4 s in total.
      const chunks = [source.slice(0, 10), source.slice(10, 20), source.slice(20, 30)];
      const fetchMock = vi.fn().mockResolvedValue(trickleResponse(chunks, 600));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, undefined, undefined, 1000);

      const request = fetcher.fetch(0, 30);
      await vi.runAllTimersAsync();

      expect(Array.from(await request)).toEqual(Array.from(source));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('cancels the body of a non-206 response instead of leaving it streaming', async () => {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, body: { cancel } });
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      await expect(fetcher.fetch(0, 10)).rejects.toThrow(/200/);
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('rejects a body shorter than the range instead of handing on a truncated chunk', async () => {
      useFakeBackoff();
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse(makeSourceBytes(6)));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const request = fetcher.fetch(0, 10);
      const rejection = expect(request).rejects.toThrow(/expected 10 bytes.*received 6/);
      await vi.runAllTimersAsync();

      await rejection;
    });
  });

  describe('retry', () => {
    it('retries a 5xx and resolves once an attempt succeeds', async () => {
      useFakeBackoff();
      const source = makeSourceBytes(10);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(statusResponse(503))
        .mockResolvedValueOnce(fakeResponse(source));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const request = fetcher.fetch(0, 10);
      await vi.runAllTimersAsync();

      expect(Array.from(await request)).toEqual(Array.from(source));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after 3 attempts on a persistent 5xx', async () => {
      useFakeBackoff();
      const fetchMock = vi.fn().mockResolvedValue(statusResponse(503));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const request = fetcher.fetch(0, 10);
      const rejection = expect(request).rejects.toThrow(/503/);
      await vi.runAllTimersAsync();

      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('stops retrying once the group is cancelled mid-backoff', async () => {
      useFakeBackoff();
      const fetchMock = vi.fn().mockResolvedValue(statusResponse(503));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const request = fetcher.fetch(0, 10);
      const rejection = expect(request).rejects.toThrow(/AbortError|cancelled/i);
      await vi.advanceTimersByTimeAsync(0); // first attempt runs, then backs off
      expect(fetchMock).toHaveBeenCalledTimes(1);

      request.cancel();
      // No further timer advancement — see the next test for why that's the
      // point: runAllTimersAsync() here would fast-forward through the
      // backoff regardless of whether cancellation actually short-circuits
      // it, so it can't tell a real fix from delay() still waiting out the
      // full RETRY_BASE_MS underneath.
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1); // never attempted again
    });

    it('frees its maxConcurrent slot immediately when cancelled mid-backoff, without waiting out the delay', async () => {
      // Review on #123: delay() originally ignored `signal`, so a cancelled
      // group sat on its maxConcurrent slot for the rest of the backoff —
      // freed only in _fetchGroup()'s finally, once _fetchRange() actually
      // returns — instead of letting _pump() dispatch the next queued group
      // right away.
      useFakeBackoff();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(statusResponse(503))
        .mockResolvedValueOnce(fakeResponse(makeSourceBytes(10)));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, 1); // 1 concurrent slot

      const a = fetcher.fetch(0, 10); // takes the only slot; 503s, then backs off
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const b = fetcher.fetch(1000, 1010); // queued: a still holds the only slot
      await Promise.resolve(); // let b's own flush queue it, separately from a's group

      a.cancel();
      // No timer is ever advanced from here on. If delay() only resolved via
      // setTimeout, a would keep its slot for the rest of RETRY_BASE_MS and
      // these awaits would hang until the test times out, rather than b
      // reaching fetch() right away.
      await expect(a).rejects.toThrow(/cancelled/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expect(b).resolves.toBeInstanceOf(Uint8Array);
    });
  });

  describe('maxConcurrent', () => {
    it('does not start more than maxConcurrent group fetches at once', async () => {
      const fetchMock = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, 2);

      // 4 far-apart (non-mergeable) requests -> 4 separate groups, cap of 2
      fetcher.fetch(0, 10);
      fetcher.fetch(1000, 1010);
      fetcher.fetch(2000, 2010);
      fetcher.fetch(3000, 3010);
      await Promise.resolve(); // let the flush run

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('dispatches a queued group once an active one finishes, up to the cap', async () => {
      let resolveFirst!: (value: ReturnType<typeof fakeResponse>) => void;
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
        .mockResolvedValue(fakeResponse(makeSourceBytes(10)));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, 1);

      const a = fetcher.fetch(0, 10);
      const b = fetcher.fetch(1000, 1010); // must wait for a's slot
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      resolveFirst(fakeResponse(makeSourceBytes(10)));
      await a;
      await b; // resolves only once the queued group got its turn

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('dispatches groups in request order rather than file offset order', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => fakeResponse(makeSourceBytes(10)));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, 1);

      await Promise.all([fetcher.fetch(2000, 2010), fetcher.fetch(0, 10), fetcher.fetch(1000, 1010)]);

      expect(fetchMock.mock.calls.map(([, init]) => init.headers.Range)).toEqual([
        'bytes=2000-2009',
        'bytes=0-9',
        'bytes=1000-1009',
      ]);
    });

    it('places a merged group by its earliest requested member', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => fakeResponse(makeSourceBytes(20)));
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, 1);

      await Promise.all([
        fetcher.fetch(500, 510),
        fetcher.fetch(10, 20),
        fetcher.fetch(1000, 1010),
        fetcher.fetch(0, 10),
      ]);

      expect(fetchMock.mock.calls.map(([, init]) => init.headers.Range)).toEqual([
        'bytes=500-509',
        'bytes=0-19',
        'bytes=1000-1009',
      ]);
    });

    it('drops a queued group entirely (no fetch) once every member is cancelled before it gets a slot', async () => {
      const fetchMock = vi.fn().mockReturnValue(new Promise(() => {})); // the occupying group never resolves
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, 1);

      fetcher.fetch(0, 10); // occupies the only slot
      const queued = fetcher.fetch(1000, 1010);
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      queued.cancel();

      await expect(queued).rejects.toThrow(/cancelled/);
      expect(fetchMock).toHaveBeenCalledTimes(1); // the queued group never actually fetched
    });
  });

  describe('tail bridging', () => {
    const url = 'https://example.com/file.copc.laz';

    /** Serves whatever range is asked for out of one source buffer. */
    function serveSource() {
      const source = makeSourceBytes(1000);
      const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { headers: { Range: string } }) => {
        const [, from, to] = init.headers.Range.match(/bytes=(\d+)-(\d+)/)!;
        return fakeResponse(source.slice(Number(from), Number(to) + 1));
      });
      vi.stubGlobal('fetch', fetchMock);
      return { source, fetchMock };
    }

    it('re-fetches a skipped tail to keep its neighbor in the same request', async () => {
      const { source, fetchMock } = serveSource();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, undefined, undefined, undefined, 32);

      // A chunk at [0, 30) read only up to 10, then the next chunk.
      const [a, b] = await Promise.all([fetcher.fetch(0, 10, 30), fetcher.fetch(30, 40)]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1].headers.Range).toBe('bytes=0-39');
      expect(Array.from(a)).toEqual(Array.from(source.slice(0, 10)));
      expect(Array.from(b)).toEqual(Array.from(source.slice(30, 40)));
    });

    it('bridges the hole between one chunk’s two ranges the same way', async () => {
      const { fetchMock } = serveSource();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, undefined, undefined, undefined, 64);

      await Promise.all([fetcher.fetch(0, 10, 100), fetcher.fetch(50, 100)]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('leaves an equally small gap alone when it is not a skipped tail', async () => {
      const { fetchMock } = serveSource();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, undefined, undefined, undefined, 32);

      await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(30, 40)]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('leaves a tail wider than tailGapBytes alone', async () => {
      const { fetchMock } = serveSource();
      const fetcher = new RangeFetcher(url, 0, undefined, undefined, undefined, undefined, undefined, 32);

      await Promise.all([fetcher.fetch(0, 10, 100), fetcher.fetch(100, 110)]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('ignores slack when tailGapBytes is left at 0', async () => {
      const { fetchMock } = serveSource();
      const fetcher = new RangeFetcher(url);

      await Promise.all([fetcher.fetch(0, 10, 30), fetcher.fetch(30, 40)]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('adaptive gap', () => {
    const url = 'https://example.com/file.copc.laz';

    /** A fake link: every response takes `ttfbMs` to its headers and
     *  `bodyMs` more to its body, on a clock the fetcher reads. */
    function fakeLink(ttfbMs: number, bodyMs: number) {
      let t = 0;
      const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { headers: { Range: string } }) => {
        const [, from, to] = init.headers.Range.match(/bytes=(\d+)-(\d+)/)!;
        const length = Number(to) - Number(from) + 1;
        t += ttfbMs;
        return {
          status: 206,
          arrayBuffer: async () => {
            t += bodyMs;
            return new Uint8Array(length).buffer;
          },
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      return { fetchMock, now: () => t };
    }

    /** Four timed 20 KB responses, one after another. */
    async function warmUp(fetcher: RangeFetcher) {
      for (let i = 0; i < 4; i++) await fetcher.fetch(i * 1_000_000, i * 1_000_000 + 20_000);
    }

    it('uses the fixed gapBytes until enough responses have been timed', async () => {
      const { fetchMock, now } = fakeLink(100, 10);
      const fetcher = new RangeFetcher(url, 0, undefined, 1, undefined, undefined, { now });

      expect(fetcher.currentGapBytes).toBe(0);
      await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(20, 30)]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sizes the gap from time to first byte and link rate', async () => {
      const { now } = fakeLink(100, 10); // 2,000 B/ms per response
      const fetcher = new RangeFetcher(url, 0, undefined, 1, undefined, undefined, { now });

      await warmUp(fetcher);

      expect(fetcher.network!.ready).toBe(true);
      expect(fetcher.currentGapBytes).toBe(200_000);
    });

    it('splits the link rate across maxConcurrent slots', async () => {
      const { now } = fakeLink(100, 10); // one at a time, so 2,000 B/ms is the whole link
      const fetcher = new RangeFetcher(url, 0, undefined, 4, undefined, undefined, { now });

      await warmUp(fetcher);

      expect(fetcher.currentGapBytes).toBe(50_000);
    });

    it('clamps the gap to maxGapBytes', async () => {
      const { now } = fakeLink(100, 10);
      const fetcher = new RangeFetcher(url, 0, undefined, 1, undefined, undefined, { now, maxGapBytes: 50_000 });

      await warmUp(fetcher);

      expect(fetcher.currentGapBytes).toBe(50_000);
    });

    it('merges across a gap when the batch would otherwise queue for a slot', async () => {
      const { fetchMock, now } = fakeLink(100, 10);
      const fetcher = new RangeFetcher(url, 0, undefined, 1, undefined, undefined, { now });
      await warmUp(fetcher);
      fetchMock.mockClear();

      const [a, b] = await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(1000, 1010)]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1].headers.Range).toBe('bytes=0-1009');
      expect(a.length).toBe(10);
      expect(b.length).toBe(10);
    });

    it('leaves gaps unbridged when every group fits in a free slot', async () => {
      const { fetchMock, now } = fakeLink(100, 10);
      const fetcher = new RangeFetcher(url, 0, undefined, 6, undefined, undefined, { now });
      await warmUp(fetcher);
      fetchMock.mockClear();

      await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(1000, 1010)]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not bridge a gap wider than the measured one', async () => {
      const { fetchMock, now } = fakeLink(100, 10); // gap 200,000
      const fetcher = new RangeFetcher(url, 0, undefined, 1, undefined, undefined, { now });
      await warmUp(fetcher);
      fetchMock.mockClear();

      await Promise.all([fetcher.fetch(0, 10), fetcher.fetch(300_010, 300_020)]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('lets a bridged group grow past the default 512 KiB cap', async () => {
      const { fetchMock, now } = fakeLink(100, 10);
      const fetcher = new RangeFetcher(url, 0, undefined, 1, undefined, undefined, { now });
      await warmUp(fetcher);
      fetchMock.mockClear();

      // Three 300 KB chunks 100 KB apart: 1.1 MB span, under the 4 MiB adaptive cap.
      await Promise.all([
        fetcher.fetch(0, 300_000),
        fetcher.fetch(400_000, 700_000),
        fetcher.fetch(800_000, 1_100_000),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not time a failed response', async () => {
      let t = 0;
      const now = () => t;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => {
          t += 100;
          return statusResponse(404);
        }),
      );
      const fetcher = new RangeFetcher(url, 0, undefined, 1, undefined, undefined, { now });

      await expect(fetcher.fetch(0, 20_000)).rejects.toThrow(/404/);

      expect(Number.isNaN(fetcher.network!.ttfbMs)).toBe(true);
    });

    it('reports no network estimate when not adaptive', () => {
      const fetcher = new RangeFetcher(url, 4096);
      expect(fetcher.network).toBeNull();
      expect(fetcher.currentGapBytes).toBe(4096);
    });
  });

  describe('destroy()', () => {
    it('rejects requests still queued (not yet flushed to a fetch)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const pending = fetcher.fetch(0, 10);
      fetcher.destroy();

      await expect(pending).rejects.toThrow(/destroyed/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a group that flushed but is still waiting behind maxConcurrent for a slot', async () => {
      const fetchMock = vi.fn().mockReturnValue(new Promise(() => {})); // the occupying group never resolves
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz', 0, undefined, 1);

      fetcher.fetch(0, 10); // occupies the only slot
      const queued = fetcher.fetch(1000, 1010);
      await Promise.resolve();

      fetcher.destroy();

      await expect(queued).rejects.toThrow(/destroyed/);
      expect(fetchMock).toHaveBeenCalledTimes(1); // never got its own fetch call
    });

    it('aborts a fetch already in flight', async () => {
      const fetchMock = vi.fn((_url: string, opts: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

      const inFlight = fetcher.fetch(0, 10);
      await Promise.resolve(); // let the flush dispatch the fetch
      fetcher.destroy();

      await expect(inFlight).rejects.toThrow(/aborted/i);
    });
  });
});
