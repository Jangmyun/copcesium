import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangeFetcher } from './RangeFetcher';

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

describe('RangeFetcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
