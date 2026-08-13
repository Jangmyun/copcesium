import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangeFetcher } from './RangeFetcher';

function fakeResponse(bytes: Uint8Array) {
  return { arrayBuffer: async () => bytes.buffer };
}

/** All bytes at index `i` equal `i`, so a slice's own content proves which
 *  offset range it came from. */
function makeSourceBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 256;
  return bytes;
}

describe('RangeFetcher', () => {
  afterEach(() => vi.unstubAllGlobals());

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
        opts.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
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
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

    const a = fetcher.fetch(0, 10);
    const b = fetcher.fetch(10, 20);

    await expect(a).rejects.toThrow('network down');
    await expect(b).rejects.toThrow('network down');
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
          opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
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
