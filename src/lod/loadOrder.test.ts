/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import * as Cesium from 'cesium';
import { describe, expect, it } from 'vitest';
import { orderForLoading } from './loadOrder';

/** Looks straight down -Z from z=100, so x/y offset is distance off-axis. */
const camera = {
  positionWC: new Cesium.Cartesian3(0, 0, 100),
  directionWC: new Cesium.Cartesian3(0, 0, -1),
} as unknown as Cesium.Camera;

function spheresAt(centers: Record<string, [number, number]>) {
  return (key: string) => {
    const [x, y] = centers[key]!;
    return new Cesium.BoundingSphere(new Cesium.Cartesian3(x, y, 0), 1);
  };
}

describe('orderForLoading', () => {
  it('puts shallower nodes first, even when a deeper one is more central', () => {
    const getSphere = spheresAt({ '3-0-0-0': [0, 0], '1-0-0-0': [80, 80], '2-0-0-0': [40, 40] });

    expect(orderForLoading(['3-0-0-0', '1-0-0-0', '2-0-0-0'], getSphere, camera)).toEqual([
      '1-0-0-0',
      '2-0-0-0',
      '3-0-0-0',
    ]);
  });

  it('orders nodes of one depth by closeness to the view axis', () => {
    const getSphere = spheresAt({ '2-0-0-0': [90, 0], '2-1-0-0': [5, 5], '2-2-0-0': [-30, 10] });

    expect(orderForLoading(['2-0-0-0', '2-1-0-0', '2-2-0-0'], getSphere, camera)).toEqual([
      '2-1-0-0',
      '2-2-0-0',
      '2-0-0-0',
    ]);
  });

  it('keeps the incoming order for nodes that tie', () => {
    const getSphere = spheresAt({ '1-0-0-0': [10, 0], '1-1-0-0': [-10, 0] });

    expect(orderForLoading(['1-1-0-0', '1-0-0-0'], getSphere, camera)).toEqual(['1-1-0-0', '1-0-0-0']);
  });

  it('treats a node centred on the camera as fully central', () => {
    const atEye = (key: string) =>
      new Cesium.BoundingSphere(
        key === '1-0-0-0' ? new Cesium.Cartesian3(0, 0, 100) : new Cesium.Cartesian3(50, 0, 0),
        1,
      );

    expect(orderForLoading(['1-1-0-0', '1-0-0-0'], atEye, camera)).toEqual(['1-0-0-0', '1-1-0-0']);
  });
});
