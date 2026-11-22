/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import type { PositionQuantization } from '../types';

/**
 * Positions as uint16 per axis over the node's own extent: 6 bytes per point
 * instead of 12. The vertex shader rebuilds each Float32 offset as
 * `q * scale + offset`, so the model matrix stays a pure translation and the
 * relative-to-eye math is unchanged. The error per axis is at most half a
 * step, `extent / 65535 / 2`.
 */
export function quantizePositions(positions: Float32Array): {
  values: Uint16Array;
  quantization: PositionQuantization;
} {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const scale: [number, number, number] = [0, 0, 0];
  const offset: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    // No points: leave the axis at 0.
    if (!Number.isFinite(min[a]!)) min[a] = max[a] = 0;
    offset[a] = min[a]!;
    scale[a] = (max[a]! - min[a]!) / 65535;
  }
  const values = new Uint16Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      // A flat axis (scale 0) maps every point to its offset.
      values[i + a] = scale[a] === 0 ? 0 : Math.round((positions[i + a]! - offset[a]!) / scale[a]!);
    }
  }
  return { values, quantization: { scale, offset } };
}
