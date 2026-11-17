/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun), 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import type { Hierarchy } from 'copc';
import { selectNodes } from './selectNodes';
import { getNodeBoundingSphere } from './boundingVolume';

// A full 3-level octree (1 + 8 + 64 + 512 nodes) with every 5th node empty, so the
// walk exercises heap ordering, empty-node descent, budgets and prefetch together.
function makeOctree(): Hierarchy.Node.Map {
  const nodes: Hierarchy.Node.Map = {};
  let n = 0;
  for (let d = 0; d <= 3; d++) {
    const side = 1 << d;
    for (let z = 0; z < side; z++)
      for (let y = 0; y < side; y++)
        for (let x = 0; x < side; x++) {
          nodes[`${d}-${x}-${y}-${z}`] = {
            pointCount: d > 0 && n++ % 5 === 0 ? 0 : 10 + d,
            pointDataOffset: 0,
            pointDataLength: 1,
          };
        }
  }
  return nodes;
}

function run(extra: object): { selected: string[]; prefetch: string[] } {
  const position = new Cesium.Cartesian3(3, 2, 40);
  const direction = Cesium.Cartesian3.normalize(
    new Cesium.Cartesian3(0.1, 0.05, -1),
    new Cesium.Cartesian3(),
  );
  const up = new Cesium.Cartesian3(0, 1, 0);
  const camera = {
    position,
    direction,
    up,
    positionWC: position,
    directionWC: direction,
    upWC: up,
    frustum: new Cesium.PerspectiveFrustum({
      fov: Cesium.Math.toRadians(40),
      aspectRatio: 1.5,
      near: 1,
      far: 1e9,
    }),
  } as unknown as Cesium.Camera;
  const prefetch: string[] = [];
  const selected = selectNodes({
    nodes: makeOctree(),
    getSphere: (key) =>
      getNodeBoundingSphere(
        key,
        { x: 0, y: 0, z: 0 },
        10,
        (x, y, z) => new Cesium.Cartesian3(x, y, z),
      ),
    camera,
    viewportHeight: 800,
    sseThreshold: 8,
    maxVisibleNodes: 60,
    prefetchFrustumFactor: 1.5,
    maxPrefetchNodes: 12,
    onPrefetchCandidate: (k) => prefetch.push(k),
    incumbents: new Set(['1-0-0-0', '2-1-1-1']),
    incumbentBonus: 1.3,
    viewAxisBias: 0.5,
    ...extra,
  });
  return { selected, prefetch };
}

describe('selectNodes regression (recorded output)', () => {
  it('matches the recorded selection and prefetch order', () => {
    const r = run({});
    expect(r).toEqual({
      selected: [
        '0-0-0-0',
        '1-1-1-1',
        '1-1-1-0',
        '1-0-1-1',
        '1-0-0-1',
        '1-1-0-0',
        '1-0-1-0',
        '2-3-2-3',
        '2-2-2-3',
        '2-3-3-3',
        '2-3-2-2',
        '2-3-1-3',
        '2-2-1-3',
        '2-1-1-1',
        '2-2-3-2',
        '2-1-3-3',
        '2-3-1-2',
        '2-1-1-3',
        '2-2-1-2',
        '2-3-3-1',
        '2-3-0-3',
        '2-2-2-1',
        '2-2-0-3',
        '2-1-2-2',
        '2-2-3-1',
        '2-1-3-2',
        '2-3-1-1',
        '2-3-2-0',
        '2-3-3-0',
        '2-0-2-3',
        '2-3-0-2',
        '2-1-0-3',
        '2-0-3-3',
        '2-2-0-2',
        '2-2-2-0',
        '2-1-2-1',
        '2-0-0-3',
        '2-2-3-0',
        '2-1-3-1',
        '2-0-2-2',
        '2-2-1-0',
        '2-3-0-1',
        '2-1-0-2',
        '2-0-3-2',
        '2-2-0-1',
        '2-1-2-0',
        '2-0-1-2',
        '2-1-3-0',
        '2-0-2-1',
        '2-1-1-0',
        '2-3-0-0',
        '2-0-3-1',
        '2-0-1-1',
        '3-6-5-7',
        '2-0-2-0',
        '2-1-0-0',
        '3-6-4-7',
        '2-0-0-1',
        '2-0-1-0',
        '3-6-6-7',
      ],
      prefetch: [
        '3-5-1-7',
        '3-4-1-7',
        '3-3-1-7',
        '3-6-0-7',
        '3-7-0-7',
        '3-4-0-7',
        '3-3-0-7',
        '3-6-0-6',
        '3-0-4-7',
        '3-0-3-7',
        '3-5-0-6',
        '3-1-1-7',
      ],
    });
  });
  it('matches with a point budget and no bias', () => {
    const r = run({ maxPoints: 400, viewAxisBias: 0, prefetchFrustumFactor: undefined });
    expect(r).toEqual({
      selected: [
        '0-0-0-0',
        '1-1-1-1',
        '1-0-1-1',
        '1-0-0-1',
        '1-1-1-0',
        '1-1-0-0',
        '1-0-1-0',
        '2-2-2-3',
        '2-3-2-3',
        '2-2-1-3',
        '2-3-1-3',
        '2-1-1-1',
        '2-1-1-3',
        '2-3-3-3',
        '2-1-3-3',
        '2-2-0-3',
        '2-0-2-3',
        '2-3-0-3',
        '2-1-0-3',
        '2-0-3-3',
        '2-0-0-3',
        '2-3-2-2',
        '2-2-1-2',
        '2-2-3-2',
        '2-1-2-2',
        '2-3-1-2',
        '2-1-3-2',
        '2-2-0-2',
        '2-3-0-2',
        '2-0-2-2',
        '2-1-0-2',
        '2-0-1-2',
        '2-0-3-2',
        '2-2-2-1',
      ],
      prefetch: [],
    });
  });
});
