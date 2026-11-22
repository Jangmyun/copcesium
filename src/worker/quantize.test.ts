/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { quantizePositions } from './quantize';

describe('quantizePositions', () => {
  it('rebuilds every offset to within half a step per axis', () => {
    const positions = new Float32Array([0, -5, 100, 12.345, 7.5, 100.25, 30, 2, 101]);
    const { values, quantization } = quantizePositions(positions);
    const { scale, offset } = quantization;

    expect(values).toBeInstanceOf(Uint16Array);
    expect(offset).toEqual([0, -5, 100]);
    for (let i = 0; i < positions.length; i++) {
      const a = i % 3;
      expect(Math.abs(values[i]! * scale[a]! + offset[a]! - positions[i]!)).toBeLessThanOrEqual(
        scale[a]! / 2 + 1e-6,
      );
    }
    // The extremes land on the ends of the range.
    expect(values[0]).toBe(0);
    expect(values[6]).toBe(65535);
  });

  it('maps a flat axis, or a node without points, to its offset', () => {
    const flat = quantizePositions(new Float32Array([1, 2, 3, 4, 2, 6]));
    expect(flat.quantization.scale[1]).toBe(0);
    expect(flat.quantization.offset[1]).toBe(2);
    expect(flat.values[1]).toBe(0);

    const empty = quantizePositions(new Float32Array(0));
    expect(empty.values).toHaveLength(0);
    expect(empty.quantization).toEqual({ scale: [0, 0, 0], offset: [0, 0, 0] });
  });
});
