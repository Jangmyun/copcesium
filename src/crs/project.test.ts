/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import type { Converter } from 'proj4';
import { createProjector } from './project';

describe('createProjector', () => {
  it('treats x/y as lon/lat degrees directly when there is no converter (already-geographic CRS)', () => {
    const project = createProjector(null, 0, 1);

    const result = project(127, 37, 100);

    expect(result).toEqual(Cesium.Cartesian3.fromDegrees(127, 37, 100));
  });

  it('forwards x/y through the converter before building the Cartesian3', () => {
    const converter = {
      forward: (coords: number[]) => [coords[0] + 1, coords[1] + 2],
      inverse: (coords: number[]) => coords,
    } as unknown as Converter;
    const project = createProjector(converter, 0, 1);

    const result = project(126, 35, 100);

    expect(result).toEqual(Cesium.Cartesian3.fromDegrees(127, 37, 100));
  });

  it('applies zFactor and geoidOffset to the altitude', () => {
    const project = createProjector(null, 10, 0.3048);

    const result = project(127, 37, 100);

    expect(result).toEqual(Cesium.Cartesian3.fromDegrees(127, 37, 100 * 0.3048 + 10));
  });
});
