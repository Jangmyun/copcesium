import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const loadHierarchyPage = vi.fn();

vi.mock('copc', () => ({
  Copc: {
    create: (...args: unknown[]) => create(...args),
    loadHierarchyPage: (...args: unknown[]) => loadHierarchyPage(...args),
  },
}));

const { loadCopcHierarchy } = await import('./hierarchy');

// Every test exercises the Range-support probe first; default it to a
// well-behaved 206 response so tests unrelated to that probe don't have to
// know it exists, and override it in the ones that do.
const fetchMock = vi.fn();
/** A minimal stand-in for a `206` range response, including the
 *  `Content-Range` that discloses the file size (#181). */
function rangeResponse(total = 1_000_000, status = 206) {
  return {
    status,
    headers: { get: (name: string) => (name === 'Content-Range' ? `bytes 0-0/${total}` : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

beforeEach(() => {
  create.mockClear();
  loadHierarchyPage.mockClear();
  fetchMock.mockReset().mockResolvedValue(rangeResponse());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('loadCopcHierarchy', () => {
  it('extracts root center/half size from the cube and computes max depth', async () => {
    create.mockResolvedValueOnce({
      info: {
        cube: [-100, -50, 0, 100, 150, 40],
        rootHierarchyPage: { pageOffset: 0, pageLength: 100 },
      },
      wkt: undefined,
    });
    loadHierarchyPage.mockResolvedValueOnce({
      nodes: {
        '0-0-0-0': { pointCount: 10, pointDataOffset: 0, pointDataLength: 1 },
        '1-0-0-0': { pointCount: 5, pointDataOffset: 1, pointDataLength: 1 },
        '2-1-1-1': { pointCount: 3, pointDataOffset: 2, pointDataLength: 1 },
      },
      pages: {},
    });

    const result = await loadCopcHierarchy('https://example.com/sample.copc.laz');

    expect(result.rootCenter).toEqual({ x: 0, y: 50, z: 20 });
    expect(result.rootHalfSize).toBe(100);
    expect(result.maxDepth).toBe(2);
    expect(Object.keys(result.nodes)).toHaveLength(3);
  });

  it('returns the root page\'s unresolved sub-page entry points alongside its nodes', async () => {
    create.mockResolvedValueOnce({
      info: {
        cube: [0, 0, 0, 10, 10, 10],
        rootHierarchyPage: { pageOffset: 0, pageLength: 100 },
      },
      wkt: undefined,
    });
    loadHierarchyPage.mockResolvedValueOnce({
      nodes: { '0-0-0-0': { pointCount: 10, pointDataOffset: 0, pointDataLength: 1 } },
      pages: { '3-1-1-1': { pageOffset: 100, pageLength: 50 } },
    });

    const result = await loadCopcHierarchy('https://example.com/sample.copc.laz');

    expect(result.pages).toEqual({ '3-1-1-1': { pageOffset: 100, pageLength: 50 } });
  });

  it('raises a descriptive error when the COPC header cannot be read', async () => {
    create.mockRejectedValueOnce(new Error('Invalid header: too short'));

    await expect(loadCopcHierarchy('https://example.com/broken.copc.laz')).rejects.toThrow(
      /Failed to read the COPC header/,
    );
  });

  it('propagates unrelated errors unchanged', async () => {
    create.mockRejectedValueOnce(new Error('network error'));

    await expect(loadCopcHierarchy('https://example.com/sample.copc.laz')).rejects.toThrow('network error');
  });

  it('rejects with a clear error when the server ignores the Range header', async () => {
    fetchMock.mockResolvedValueOnce(rangeResponse(1_000_000, 200)); // whole file, not a 206 partial response

    await expect(loadCopcHierarchy('https://example.com/sample.copc.laz')).rejects.toThrow(
      /Range Request|206/,
    );
    expect(create).not.toHaveBeenCalled(); // fails fast, before ever trying to parse a header
  });

  it('probes with a 1-byte Range request before reading the header', async () => {
    create.mockResolvedValueOnce({
      info: { cube: [0, 0, 0, 1, 1, 1], rootHierarchyPage: { pageOffset: 0, pageLength: 1 } },
      wkt: undefined,
    });
    loadHierarchyPage.mockResolvedValueOnce({ nodes: { '0-0-0-0': { pointCount: 1 } }, pages: {} });

    await loadCopcHierarchy('https://example.com/sample.copc.laz');

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/sample.copc.laz', {
      headers: { Range: 'bytes=0-0' },
    });
  });

  it('skips the Range probe for a non-HTTP getter (e.g. a local file path)', async () => {
    create.mockResolvedValueOnce({
      info: { cube: [0, 0, 0, 1, 1, 1], rootHierarchyPage: { pageOffset: 0, pageLength: 1 } },
      wkt: undefined,
    });
    loadHierarchyPage.mockResolvedValueOnce({ nodes: { '0-0-0-0': { pointCount: 1 } }, pages: {} });

    await loadCopcHierarchy('/local/sample.copc.laz');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('computes max depth without a stack overflow on a large (~150k-key) node map (#126)', async () => {
    create.mockResolvedValueOnce({
      info: { cube: [0, 0, 0, 1, 1, 1], rootHierarchyPage: { pageOffset: 0, pageLength: 1 } },
      wkt: undefined,
    });
    const nodes: Record<string, { pointCount: number }> = {};
    for (let i = 0; i < 150_000; i++) {
      // Depths 0-6 so there's a definite max, spread across distinct keys.
      nodes[`${i % 7}-${i}-0-0`] = { pointCount: 1 };
    }
    loadHierarchyPage.mockResolvedValueOnce({ nodes, pages: {} });

    const result = await loadCopcHierarchy('https://example.com/sample.copc.laz');

    expect(result.maxDepth).toBe(6);
  });
});
