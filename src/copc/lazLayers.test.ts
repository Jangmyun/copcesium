/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { usedLayerRanges } from './lazLayers';

/** A layered chunk: raw first point, u32 count, one u32 size per layer, then the layers. */
function chunk(rawPoint: number, sizes: number[]): Uint8Array {
  const head = rawPoint + 4 + sizes.length * 4;
  const out = new Uint8Array(head + sizes.reduce((a, b) => a + b, 0));
  const dv = new DataView(out.buffer);
  sizes.forEach((s, i) => dv.setUint32(rawPoint + 4 + i * 4, s, true));
  return out;
}

describe('usedLayerRanges', () => {
  it('keeps the head and the used layers of a format 6 chunk, merging small gaps', () => {
    // xy z class flags intensity scan user psrc gps
    const c = chunk(30, [100, 50, 10, 10, 20, 5000, 10, 10, 5000]);
    // head 70; xy..intensity ends at 260 (flags is a small gap); nothing used after it.
    expect(usedLayerRanges(c, 6)).toEqual([{ begin: 0, end: 260 }]);
  });

  it('adds the RGB layer at the end of a format 7 chunk as its own range', () => {
    const c = chunk(36, [100, 50, 10, 10, 20, 5000, 10, 10, 5000, 60]);
    expect(usedLayerRanges(c, 7)).toEqual([
      { begin: 0, end: 270 },
      { begin: c.length - 60, end: c.length },
    ]);
  });

  it('merges across a skipped layer no larger than 4 KiB', () => {
    const c = chunk(36, [100, 50, 10, 10, 20, 4000, 0, 0, 0, 60]);
    expect(usedLayerRanges(c, 7)).toEqual([{ begin: 0, end: c.length }]);
  });

  it('returns null for other point formats, short chunks and sizes that do not add up', () => {
    const c = chunk(36, [100, 50, 10, 10, 20, 5000, 10, 10, 5000, 60]);
    expect(usedLayerRanges(c, 8)).toBeNull();
    expect(usedLayerRanges(c.subarray(0, 50), 7)).toBeNull();
    // Extra-byte layers follow RGB, so the listed sizes fall short of the length.
    const withExtra = new Uint8Array(c.length + 16);
    withExtra.set(c);
    expect(usedLayerRanges(withExtra, 7)).toBeNull();
  });

  it('reads sizes relative to the view, not the underlying buffer', () => {
    const c = chunk(36, [100, 50, 10, 10, 20, 5000, 10, 10, 5000, 60]);
    const padded = new Uint8Array(c.length + 8);
    padded.set(c, 8);
    expect(usedLayerRanges(padded.subarray(8), 7)).toEqual(usedLayerRanges(c, 7));
  });
});
