/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { CompressedBytesCache } from './CompressedBytesCache';

const bytes = (length: number, fill = 1) => new Uint8Array(length).fill(fill);

describe('CompressedBytesCache', () => {
  it('returns what was stored', () => {
    const cache = new CompressedBytesCache(100);
    cache.set('a', bytes(10, 7));

    expect(Array.from(cache.get('a')!)).toEqual(Array.from(bytes(10, 7)));
    expect(cache.get('missing')).toBeUndefined();
  });

  it('survives the caller transferring both the stored and the returned buffer', () => {
    const cache = new CompressedBytesCache(100);
    const source = bytes(10, 7);
    cache.set('a', source);
    structuredClone(source.buffer, { transfer: [source.buffer] });

    const first = cache.get('a')!;
    structuredClone(first.buffer, { transfer: [first.buffer] });

    expect(cache.get('a')!.byteLength).toBe(10);
  });

  it('evicts the least recently used entries once over budget', () => {
    const cache = new CompressedBytesCache(20);
    cache.set('a', bytes(10));
    cache.set('b', bytes(10));
    cache.get('a');
    cache.set('c', bytes(10));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.totalBytes).toBe(20);
  });

  it('counts a replaced entry only once', () => {
    const cache = new CompressedBytesCache(100);
    cache.set('a', bytes(10));
    cache.set('a', bytes(30));

    expect(cache.size).toBe(1);
    expect(cache.totalBytes).toBe(30);
  });

  it('skips an entry larger than the whole budget without evicting others', () => {
    const cache = new CompressedBytesCache(20);
    cache.set('a', bytes(10));
    cache.set('huge', bytes(21));

    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
  });

  it('stores nothing when the budget is 0', () => {
    const cache = new CompressedBytesCache(0);
    cache.set('a', bytes(10));

    expect(cache.size).toBe(0);
  });

  it('forgets everything on clear()', () => {
    const cache = new CompressedBytesCache(100);
    cache.set('a', bytes(10));
    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.totalBytes).toBe(0);
  });
});

describe('CompressedBytesCache with a layered point format', () => {
  // A point format 7 chunk: 36 B raw first point, u32 count, 10 u32 layer sizes, then the layers.
  const SIZES = [100, 50, 10, 10, 20, 5000, 10, 10, 5000, 60]; // xy z class flags intensity scan user psrc gps rgb
  function chunkPf7(): Uint8Array {
    const head = 36 + 4 + SIZES.length * 4;
    const out = new Uint8Array(head + SIZES.reduce((a, b) => a + b, 0));
    for (let i = 0; i < out.length; i++) out[i] = (i % 251) + 1; // never 0
    const dv = new DataView(out.buffer);
    SIZES.forEach((s, i) => dv.setUint32(40 + i * 4, s, true));
    return out;
  }

  it('keeps only the used layers and rebuilds the chunk with zeros elsewhere', () => {
    const cache = new CompressedBytesCache(1 << 20, 7);
    const chunk = chunkPf7();
    cache.set('a', chunk);
    // head 80 + xy..intensity 190 (flags merged as a small gap) + rgb 60
    expect(cache.totalBytes).toBe(330);
    const back = cache.get('a')!;
    expect(back.length).toBe(chunk.length);
    const rgbBegin = chunk.length - 60;
    for (let i = 0; i < chunk.length; i++) {
      const kept = i < 270 || i >= rgbBegin;
      expect(back[i]).toBe(kept ? chunk[i] : 0);
    }
  });

  it('keeps a chunk whole when its layer sizes do not add up, or when not layered', () => {
    const broken = chunkPf7();
    new DataView(broken.buffer).setUint32(40, 999999, true);
    const layered = new CompressedBytesCache(1 << 20, 7);
    layered.set('a', broken);
    expect(layered.totalBytes).toBe(broken.length);

    const plain = new CompressedBytesCache(1 << 20);
    plain.set('b', chunkPf7());
    expect(plain.totalBytes).toBe(chunkPf7().length);
  });
});
