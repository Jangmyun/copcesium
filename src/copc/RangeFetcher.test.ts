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

  it('rejects a request cancelled after its group fetch already started, without affecting its siblings', async () => {
    let resolveFetch!: (value: ReturnType<typeof fakeResponse>) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RangeFetcher('https://example.com/file.copc.laz');

    const cancelled = fetcher.fetch(0, 10);
    const kept = fetcher.fetch(10, 20);
    await Promise.resolve(); // let the microtask-scheduled flush dispatch the merged fetch
    cancelled.cancel(); // too late to stop the network request, but should still suppress its own result
    resolveFetch(fakeResponse(makeSourceBytes(20)));

    await expect(cancelled).rejects.toThrow(/cancelled/);
    await expect(kept).resolves.toBeInstanceOf(Uint8Array);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one shared request for both
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
