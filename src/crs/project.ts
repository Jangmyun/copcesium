/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import * as Cesium from 'cesium';
import type { Converter } from 'proj4';
import type { ProjectToCartesian } from '../lod/boundingVolume';

/**
 * Builds a `ProjectToCartesian` for `selectNodes()`/`getNodeBoundingSphere()`.
 *
 * This runs on the main thread, where (unlike inside the point-conversion
 * Worker) Cesium is available, so ellipsoid conversion is delegated to
 * `Cesium.Cartesian3.fromDegrees` instead of re-deriving the WGS84 math done
 * in `worker/worker.ts`'s `lonLatAltToEcef`.
 */
export function createProjector(
  converter: Converter | null,
  geoidOffset: number,
  zFactor: number,
): ProjectToCartesian {
  return (x: number, y: number, z: number) => {
    let lon: number;
    let lat: number;
    if (converter) {
      [lon, lat] = converter.forward([x, y]);
    } else {
      lon = x;
      lat = y;
    }
    return Cesium.Cartesian3.fromDegrees(lon, lat, z * zFactor + geoidOffset);
  };
}
