/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import type * as Cesium from 'cesium';
import { sameView, viewSignature } from './viewSignature';

function fakeCamera(x: number): Cesium.Camera {
  return {
    positionWC: { x, y: 2, z: 3 },
    directionWC: { x: 0, y: 1, z: 0 },
    upWC: { x: 0, y: 0, z: 1 },
    frustum: { fov: 1, aspectRatio: 2 },
  } as unknown as Cesium.Camera;
}

describe('viewSignature', () => {
  it('reads absent fields as NaN, which compares equal to itself', () => {
    const sig = viewSignature(fakeCamera(1), 800, 600);
    expect(sig.slice(0, 5)).toEqual([800, 600, 1, 2, 3]);
    expect(sameView(sig, viewSignature(fakeCamera(1), 800, 600))).toBe(true);
    expect(sameView(sig, viewSignature(fakeCamera(2), 800, 600))).toBe(false);
  });

  it('fills a given buffer in place and returns it, discarding stale contents', () => {
    const out = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
    const result = viewSignature(fakeCamera(1), 800, 600, out);
    expect(result).toBe(out);
    expect(out).toEqual(viewSignature(fakeCamera(1), 800, 600));
  });
});
