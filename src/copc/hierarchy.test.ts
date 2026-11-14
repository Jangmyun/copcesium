/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const loadHierarchyPage = vi.fn();

vi.mock('copc', () => ({
  Copc: {
    create: (...args: unknown[]) => create(...args),
    loadHierarchyPage: (...args: unknown[]) => loadHierarchyPage(...args),
  },
}));

const { emptyInvalidNodes, loadCopcHierarchy } = await import('./hierarchy');

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
      header: { pointCount: 1_000_000 },
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
      header: { pointCount: 1_000_000 },
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
    // The header read goes out alongside the probe and fails too on such a
    // server; the probe's explanation is still the one the caller sees.
    create.mockRejectedValueOnce(new Error('Invalid header'));

    await expect(loadCopcHierarchy('https://example.com/sample.copc.laz')).rejects.toThrow(
      /Range Request|206/,
    );
    expect(loadHierarchyPage).not.toHaveBeenCalled();
  });

  it('reads the header without waiting for the Range probe to come back', async () => {
    let answerProbe!: (r: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (answerProbe = resolve)));
    create.mockResolvedValueOnce({
      info: { cube: [0, 0, 0, 1, 1, 1], rootHierarchyPage: { pageOffset: 0, pageLength: 1 } },
      wkt: undefined,
    });
    loadHierarchyPage.mockResolvedValueOnce({ nodes: { '0-0-0-0': { pointCount: 1 } }, pages: {} });

    const loading = loadCopcHierarchy('https://example.com/sample.copc.laz');
    expect(create).toHaveBeenCalledTimes(1); // already in flight while the probe is pending

    answerProbe(rangeResponse());
    await expect(loading).resolves.toMatchObject({ maxDepth: 0 });
  });

  it('probes with a 1-byte Range request before reading the header', async () => {
    create.mockResolvedValueOnce({
      header: { pointCount: 1_000_000 },
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
      header: { pointCount: 1_000_000 },
      info: { cube: [0, 0, 0, 1, 1, 1], rootHierarchyPage: { pageOffset: 0, pageLength: 1 } },
      wkt: undefined,
    });
    loadHierarchyPage.mockResolvedValueOnce({ nodes: { '0-0-0-0': { pointCount: 1 } }, pages: {} });

    await loadCopcHierarchy('/local/sample.copc.laz');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('computes max depth without a stack overflow on a large (~150k-key) node map (#126)', async () => {
    create.mockResolvedValueOnce({
      header: { pointCount: 1_000_000 },
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

describe('emptyInvalidNodes', () => {
  it('empties entries that cannot hold real point data and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nodes = {
      '0-0-0-0': { pointCount: 10, pointDataOffset: 100, pointDataLength: 50 },
      '1-0-0-0': { pointCount: 5_000, pointDataOffset: 200, pointDataLength: 50 }, // more than the file
      '1-1-0-0': { pointCount: 3, pointDataOffset: 300, pointDataLength: 0 }, // points, no bytes
      '1-0-1-0': { pointCount: 0, pointDataOffset: 0, pointDataLength: 0 }, // empty is fine
    };

    expect(emptyInvalidNodes(nodes, 1_000, 'https://example.com/a.copc.laz')).toBe(2);

    expect(nodes['0-0-0-0']).toEqual({ pointCount: 10, pointDataOffset: 100, pointDataLength: 50 });
    // Emptied, not deleted: selection still walks through to their children.
    expect(nodes['1-0-0-0']).toEqual({ pointCount: 0, pointDataOffset: 0, pointDataLength: 0 });
    expect(nodes['1-1-0-0']).toEqual({ pointCount: 0, pointDataOffset: 0, pointDataLength: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ignored 2 hierarchy entries/));
    warn.mockRestore();
  });

  it('stays quiet when every entry is valid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nodes = { '0-0-0-0': { pointCount: 10, pointDataOffset: 100, pointDataLength: 50 } };

    expect(emptyInvalidNodes(nodes, 10, 'https://example.com/a.copc.laz')).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
