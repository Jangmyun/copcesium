import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCountingGetter, parseContentRangeTotal, TransferCounter } from './TransferCounter';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function rangeResponse(total = 1_000_000, status = 206, bodyLength = 0) {
  return {
    status,
    headers: { get: (name: string) => (name === 'Content-Range' ? `bytes 0-0/${total}` : null) },
    arrayBuffer: async () => new ArrayBuffer(bodyLength),
  };
}

describe('parseContentRangeTotal', () => {
  it('reads the total after the slash', () => {
    expect(parseContentRangeTotal('bytes 0-1023/26520151628')).toBe(26520151628);
  });

  it('returns undefined for a missing header', () => {
    expect(parseContentRangeTotal(null)).toBeUndefined();
  });

  it('returns undefined when the total is "*"', () => {
    // What a server answers with when it can't state the length — treating
    // that as a size would report a file of NaN bytes.
    expect(
      parseContentRangeTotal('bytes */26520151628'.replace('26520151628', '*')),
    ).toBeUndefined();
  });

  it('returns undefined for a header it cannot parse', () => {
    expect(parseContentRangeTotal('garbage')).toBeUndefined();
  });
});

describe('TransferCounter', () => {
  it('sums requested spans and counts one request per record', () => {
    const counter = new TransferCounter();
    counter.record(0, 100);
    counter.record(500, 700);

    expect(counter.requestCount).toBe(2);
    expect(counter.transferredBytes).toBe(300);
  });

  it('starts at zero so a file whose size was never disclosed reads as unknown, not wrong', () => {
    const counter = new TransferCounter();
    expect(counter.fileBytes).toBe(0);
    expect(counter.transferredBytes).toBe(0);
  });
});

describe('createCountingGetter', () => {
  it('counts the bytes it fetched and records the file size from Content-Range', async () => {
    const counter = new TransferCounter();
    fetchMock.mockResolvedValue(rangeResponse(26520151628));
    const get = createCountingGetter('https://example.com/f.copc.laz', counter);

    await get(0, 1024);

    expect(counter.requestCount).toBe(1);
    expect(counter.transferredBytes).toBe(1024);
    expect(counter.fileBytes).toBe(26520151628);
  });

  it('sends a half-open range as an inclusive HTTP Range header', async () => {
    const counter = new TransferCounter();
    fetchMock.mockResolvedValue(rangeResponse());
    const get = createCountingGetter('https://example.com/f.copc.laz', counter);

    await get(100, 200);

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/f.copc.laz', {
      headers: { Range: 'bytes=100-199' },
    });
  });

  it('throws with the status attached on a non-206, so isRetryable() can classify it', async () => {
    const counter = new TransferCounter();
    fetchMock.mockResolvedValue(rangeResponse(1000, 404));
    const get = createCountingGetter('https://example.com/f.copc.laz', counter);

    await expect(get(0, 10)).rejects.toMatchObject({ status: 404 });
    // A failed response delivered no usable bytes — counting it would inflate
    // the very number this exists to make defensible.
    expect(counter.requestCount).toBe(0);
    expect(counter.transferredBytes).toBe(0);
  });

  it('keeps the first file size it learned instead of re-reading it every request', async () => {
    const counter = new TransferCounter();
    fetchMock
      .mockResolvedValueOnce(rangeResponse(26520151628))
      .mockResolvedValueOnce(rangeResponse(999));
    const get = createCountingGetter('https://example.com/f.copc.laz', counter);

    await get(0, 10);
    await get(10, 20);

    expect(counter.fileBytes).toBe(26520151628);
    expect(counter.requestCount).toBe(2);
  });

  it('tolerates a response with no headers at all', async () => {
    // Not something a real fetch produces, but the size read is opportunistic
    // — an embedder that omits headers should still get working transfers.
    const counter = new TransferCounter();
    fetchMock.mockResolvedValue({ status: 206, arrayBuffer: async () => new ArrayBuffer(0) });
    const get = createCountingGetter('https://example.com/f.copc.laz', counter);

    await expect(get(0, 42)).resolves.toBeInstanceOf(Uint8Array);
    expect(counter.transferredBytes).toBe(42);
    expect(counter.fileBytes).toBe(0);
  });
});
