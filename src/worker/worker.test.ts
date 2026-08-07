import { afterEach, describe, expect, it, vi } from 'vitest';
import type { View } from 'copc';

const loadPointDataView = vi.fn();
vi.mock('copc', () => ({
  Copc: {
    loadPointDataView: (...args: unknown[]) => loadPointDataView(...args),
  },
}));

const lazPerfCreate = vi.fn().mockResolvedValue({});
vi.mock('laz-perf/lib/worker', () => ({
  LazPerf: { create: (...args: unknown[]) => lazPerfCreate(...args) },
}));

const proj4Defs = vi.fn();
const proj4Forward = vi.fn((coord: [number, number]) => coord);
function proj4Mock(..._args: unknown[]) {
  return { forward: proj4Forward };
}
proj4Mock.defs = (...args: unknown[]) => proj4Defs(...args);
vi.mock('proj4', () => ({ default: proj4Mock }));

const { convertNode, lonLatAltToEcef } = await import('./worker');

/** Builds a fake `copc` View backed by plain arrays, matching the real
 * getter contract: throws for a dimension that wasn't supplied. */
function makeView(fields: Record<string, number[]>, pointCountOverride?: number): View {
  const pointCount = pointCountOverride ?? Object.values(fields)[0]?.length ?? 0;
  return {
    pointCount,
    dimensions: {},
    getter: (name: string) => {
      const arr = fields[name];
      if (!arr) throw new Error(`No extractor for dimension: ${name}`);
      return (i: number) => arr[i];
    },
  };
}

const BASE_PAYLOAD = {
  compressedBytes: new Uint8Array([1, 2, 3]),
  copc: {} as never,
  node: {} as never,
  proj: 'EPSG:4326',
  projDef: null,
  geoidOffset: 0,
  zFactor: 1,
  zMin: 0,
  zMax: 100,
};

describe('lonLatAltToEcef', () => {
  it('places (0, 0, 0) on the equator at the WGS84 equatorial radius', () => {
    const [x, y, z] = lonLatAltToEcef(0, 0, 0);
    expect(x).toBeCloseTo(6378137.0, 3);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('adds altitude straight onto the radius at the equator', () => {
    const [x] = lonLatAltToEcef(0, 0, 1000);
    expect(x).toBeCloseTo(6378137.0 + 1000, 3);
  });
});

describe('convertNode', () => {
  it('passes X/Y through unchanged as lon/lat when proj is EPSG:4326', async () => {
    loadPointDataView.mockResolvedValueOnce(
      makeView({ X: [10], Y: [20], Z: [0], Red: [255], Green: [0], Blue: [0] }),
    );

    const result = await convertNode(BASE_PAYLOAD);

    expect(proj4Forward).not.toHaveBeenCalled();
    const [x, y, z] = lonLatAltToEcef(10, 20, 0);
    // The single point is the node origin, so its own offset is zero and the
    // absolute ECEF lives in `origin`.
    expect(result.origin[0]).toBeCloseTo(x, 6);
    expect(result.origin[1]).toBeCloseTo(y, 6);
    expect(result.origin[2]).toBeCloseTo(z, 6);
    expect(result.positions[0]).toBe(0);
    expect(result.positions[1]).toBe(0);
    expect(result.positions[2]).toBe(0);
  });

  it('emits points as Float32 offsets from the first point (the node origin)', async () => {
    // Two points a few meters apart, the scale of a real leaf node.
    loadPointDataView.mockResolvedValueOnce(makeView({ X: [10, 10.00001], Y: [20, 20], Z: [0, 5] }));

    const result = await convertNode(BASE_PAYLOAD);

    const p0 = lonLatAltToEcef(10, 20, 0);
    const p1 = lonLatAltToEcef(10.00001, 20, 5);
    expect(result.positions).toBeInstanceOf(Float32Array);
    expect(result.origin[0]).toBeCloseTo(p0[0], 6);
    expect(result.positions[0]).toBe(0);
    for (let c = 0; c < 3; c++) {
      // origin + offset reconstructs the absolute ECEF of the second point.
      expect(result.origin[c] + result.positions[3 + c]).toBeCloseTo(p1[c], 3);
    }
  });

  it('registers projDef once and transforms X/Y through proj4 for a non-4326 CRS', async () => {
    loadPointDataView.mockResolvedValue(makeView({ X: [200000], Y: [600000], Z: [0] }));
    proj4Forward.mockReturnValue([127, 38]);

    await convertNode({ ...BASE_PAYLOAD, proj: 'EPSG:5186', projDef: '+proj=tmerc ...' });
    await convertNode({ ...BASE_PAYLOAD, proj: 'EPSG:5186', projDef: '+proj=tmerc ...' });

    expect(proj4Defs).toHaveBeenCalledTimes(1);
    expect(proj4Defs).toHaveBeenCalledWith('EPSG:5186', '+proj=tmerc ...');
    expect(proj4Forward).toHaveBeenCalledWith([200000, 600000]);
  });

  it('throws when proj4 produces a non-finite coordinate', async () => {
    loadPointDataView.mockResolvedValueOnce(makeView({ X: [1], Y: [1], Z: [0] }));
    proj4Forward.mockReturnValueOnce([NaN, 38]);

    await expect(convertNode({ ...BASE_PAYLOAD, proj: 'EPSG:5186', projDef: '+x' })).rejects.toThrow(
      /non-finite/,
    );
  });

  it('applies zFactor and geoidOffset to Z before computing altitude', async () => {
    loadPointDataView.mockResolvedValueOnce(makeView({ X: [0], Y: [0], Z: [100] }));

    const result = await convertNode({ ...BASE_PAYLOAD, zFactor: 0.3048, geoidOffset: 10 });

    const expectedAlt = 100 * 0.3048 + 10;
    const [, , expectedZ] = lonLatAltToEcef(0, 0, expectedAlt);
    expect(result.origin[2]).toBeCloseTo(expectedZ, 3);
  });

  it('scales 16-bit RGB down to 0-255', async () => {
    loadPointDataView.mockResolvedValueOnce(
      makeView({ X: [0], Y: [0], Z: [0], Red: [65535], Green: [0], Blue: [32768] }),
    );

    const result = await convertNode(BASE_PAYLOAD);

    expect(result.colors[0]).toBe(255);
    expect(result.colors[1]).toBe(0);
    expect(result.colors[2]).toBeCloseTo(128, -1);
    expect(result.colors[3]).toBe(255);
  });

  it('falls back to a classification color when RGB is absent', async () => {
    loadPointDataView.mockResolvedValueOnce(makeView({ X: [0], Y: [0], Z: [0], Classification: [2] }));

    const result = await convertNode(BASE_PAYLOAD);

    expect([result.colors[0], result.colors[1], result.colors[2]]).toEqual([153, 111, 66]);
  });

  it('falls back to a flat color when RGB and Classification are both absent', async () => {
    loadPointDataView.mockResolvedValueOnce(makeView({ X: [0], Y: [0], Z: [0] }));

    const result = await convertNode(BASE_PAYLOAD);

    expect([result.colors[0], result.colors[1], result.colors[2]]).toEqual([200, 200, 200]);
  });

  it('ships raw Intensity and Classification as their own attributes, alongside the baked colour', async () => {
    // The styling API colours in the shader, so these have to survive decoding
    // even on a file that has RGB and never exercises the colour fallback.
    loadPointDataView.mockResolvedValueOnce(
      makeView({
        X: [0, 0],
        Y: [0, 0],
        Z: [0, 0],
        Red: [255, 0],
        Green: [0, 255],
        Blue: [0, 0],
        Intensity: [1000, 4095],
        Classification: [2, 6],
      }),
    );

    const result = await convertNode(BASE_PAYLOAD);

    expect(Array.from(result.intensities)).toEqual([1000, 4095]);
    expect(Array.from(result.classifications)).toEqual([2, 6]);
    expect(result.maxIntensity).toBe(4095);
    // The baked colour is still the file's RGB, unchanged.
    expect([result.colors[0], result.colors[1], result.colors[2]]).toEqual([255, 0, 0]);
  });

  it('leaves the new attributes zeroed when the file has no such dimensions', async () => {
    loadPointDataView.mockResolvedValueOnce(makeView({ X: [0], Y: [0], Z: [0] }));

    const result = await convertNode(BASE_PAYLOAD);

    expect(Array.from(result.intensities)).toEqual([0]);
    expect(Array.from(result.classifications)).toEqual([0]);
    expect(result.maxIntensity).toBe(0);
  });

  it('normalizes elevation over the header Z range, not the values present in the node', async () => {
    loadPointDataView.mockResolvedValueOnce(makeView({ X: [0, 0, 0], Y: [0, 0, 0], Z: [0, 50, 100] }));

    const result = await convertNode({ ...BASE_PAYLOAD, zMin: 0, zMax: 100 });

    expect(result.elevations[0]).toBe(0);
    expect(result.elevations[1]).toBe(32768); // rounds up from 32767.5
    expect(result.elevations[2]).toBe(65535);
  });

  it('normalizes elevation to zero when the header reports a flat dataset, instead of dividing by zero', async () => {
    loadPointDataView.mockResolvedValueOnce(makeView({ X: [0, 0], Y: [0, 0], Z: [5, 5] }));

    const result = await convertNode({ ...BASE_PAYLOAD, zMin: 5, zMax: 5 });

    expect(Array.from(result.elevations)).toEqual([0, 0]);
  });

  it('rejects an out-of-range pointCount instead of allocating huge buffers', async () => {
    loadPointDataView.mockResolvedValueOnce(makeView({ X: [], Y: [], Z: [] }, 20_000_000));

    await expect(convertNode(BASE_PAYLOAD)).rejects.toThrow(/pointCount/);
  });

  it('creates the LazPerf/WASM instance lazily and reuses it across conversions', async () => {
    // lazPerfPromise is module-level and shared by every test in this file, so
    // by this point some earlier test has already warmed it — assert against
    // that invariant instead of an exact call count, which would depend on
    // test execution order.
    loadPointDataView.mockResolvedValue(makeView({ X: [0], Y: [0], Z: [0] }));

    await convertNode(BASE_PAYLOAD);
    expect(lazPerfCreate).toHaveBeenCalled();

    const callsSoFar = lazPerfCreate.mock.calls.length;
    await convertNode(BASE_PAYLOAD);
    expect(lazPerfCreate.mock.calls.length).toBe(callsSoFar);
  });
});

describe('convertNode (buffer getter)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('decodes from the pre-fetched compressedBytes without making any network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Mimics what a real (unmocked) loadPointDataView does: pull bytes
    // through whatever getter it was given.
    let bytesSeenByGetter: Uint8Array | undefined;
    loadPointDataView.mockImplementationOnce(async (getter: (begin: number, end: number) => Promise<Uint8Array>) => {
      bytesSeenByGetter = await getter(0, 0);
      return makeView({ X: [0], Y: [0], Z: [0] });
    });

    await convertNode(BASE_PAYLOAD);

    expect(bytesSeenByGetter).toBe(BASE_PAYLOAD.compressedBytes);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('worker message handling', () => {
  it('ignores a cancel message instead of treating it as a conversion payload', async () => {
    const postMessageMock = vi.fn();
    vi.stubGlobal('postMessage', postMessageMock);

    await (self.onmessage as unknown as (e: MessageEvent) => Promise<void>)({
      data: { id: 999, cancel: true },
    } as MessageEvent);

    expect(postMessageMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
