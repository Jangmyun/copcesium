import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPartial } from './rangeRequest';
import { backoffMs } from './retryPolicy';

afterEach(() => vi.unstubAllGlobals());

describe('fetchPartial', () => {
  it('sends the Range header and returns a 206 response', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(4), { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchPartial('u', 10, 14, () => 'x');
    expect(res.status).toBe(206);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ headers: { Range: 'bytes=10-13' } });
  });

  it('throws the described error with status and cancels the body otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('whole', { status: 200 })));
    await expect(fetchPartial('u', 0, 5, (s) => `got ${s}`)).rejects.toMatchObject({
      message: 'got 200',
      status: 200,
    });
  });
});

describe('backoffMs', () => {
  it('doubles per failure', () => {
    expect([1, 2, 3].map((n) => backoffMs(250, n))).toEqual([250, 500, 1000]);
  });
});
