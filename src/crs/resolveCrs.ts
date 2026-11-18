/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Settles the coordinate reference system for a load: merges what the file's
 * WKT says with what the caller passed, refuses data whose CRS cannot be
 * used, registers the projection with proj4, and returns the point projector.
 */
import proj4 from 'proj4';
import type { Copc } from 'copc';
import type { CopcDataSourceOptions } from '../types';
import type { ProjectToCartesian } from '../lod/boundingVolume';
import { detectCrs } from './detectCrs';
import { createProjector } from './project';

/** The option fields this step reads and, where the file knows better, fills in. */
export interface CrsSettings {
  proj: string;
  projDef: string | null;
  geoidOffset: number;
  zFactor: number;
  xyFactor: number;
}

/**
 * Mutates `resolved` in place with the detected CRS and unit factors, and
 * returns the projector built from the result. `options` is the caller's raw
 * argument, kept apart because `resolved` already carries defaults that are
 * indistinguishable from an explicit choice.
 */
export function resolveCrs(
  url: string,
  copc: Copc,
  options: CopcDataSourceOptions,
  resolved: CrsSettings,
): ProjectToCartesian {
  // Run WKT detection unconditionally — even when the caller overrides
  // proj/projDef, the file's WKT may still be the only source of the true
  // zFactor/xyFactor (e.g. a compound CRS with foot-based vertical units).
  // proj/projDef and zFactor/xyFactor are therefore applied independently,
  // each only when the user did not explicitly set that particular field.
  const detected = detectCrs(copc.wkt, url);
  if (detected) {
    if (!resolved.projDef) {
      resolved.proj = detected.proj;
      resolved.projDef = detected.projDef;
    }
    // Check the raw `options` argument, not `resolved`, since `resolved`
    // already carries the (indistinguishable) default of 1.
    if (options.zFactor === undefined) resolved.zFactor = detected.zFactor;
    if (options.xyFactor === undefined) resolved.xyFactor = detected.xyFactor;
    if (detected.warning && !options.projDef) console.warn(`[CopcDataSource] ${url}: ${detected.warning}`);
  }
  // Without a CRS the coordinates are read as degrees. For projected data
  // (meters or feet) that puts every point off the globe or in the wrong
  // place with no error at all, so refuse it while it can still be told
  // apart: longitude/latitude never leave ±180/±90.
  if (resolved.proj === 'EPSG:4326') {
    const { min, max } = copc.header;
    if ([min[0], max[0]].some((x) => Math.abs(x) > 180) || [min[1], max[1]].some((y) => Math.abs(y) > 90)) {
      throw new Error(
        `[CopcDataSource] ${url}: no CRS could be determined from the file, and its extent ` +
          `(x ${min[0]}..${max[0]}, y ${min[1]}..${max[1]}) is not longitude/latitude. ` +
          'Pass `proj` and `projDef` for its coordinate system.',
      );
    }
  }
  if (resolved.projDef && resolved.proj !== 'EPSG:4326') {
    proj4.defs(resolved.proj, resolved.projDef);
  }

  const converter = resolved.proj !== 'EPSG:4326' ? proj4(resolved.proj, 'EPSG:4326') : null;
  const project = createProjector(converter, resolved.geoidOffset, resolved.zFactor);

  // A CRS proj4 can define but not evaluate here — most often a +nadgrids
  // definition whose grid file was never registered — turns every point
  // into NaN and fails each node's decode one by one. Try the middle of
  // the data once, up front, and say why instead.
  if (converter) {
    const { min, max } = copc.header;
    const [lon, lat] = converter.forward([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new Error(
        `[CopcDataSource] ${url}: the CRS "${resolved.proj}" cannot transform this file's coordinates to WGS84 ` +
          '(a +nadgrids definition needs its grid registered with proj4.nadgrid() first). ' +
          'Pass a usable `projDef`.',
      );
    }
  }

  // A compound CRS gives heights against a vertical datum, which for
  // nearly every survey is a geoid; Cesium places them on the WGS84
  // ellipsoid. Without `geoidOffset` the cloud floats or sinks by the local
  // geoid height, tens of meters in much of the world.
  if (options.geoidOffset === undefined && /\b(?:VERT_CS|VERTCRS|VERTICALCRS)\s*[[(]/i.test(copc.wkt ?? '')) {
    console.warn(
      `[CopcDataSource] ${url}: heights are relative to a vertical datum (usually a geoid), not the WGS84 ` +
        'ellipsoid Cesium uses. Pass `geoidOffset` (the local geoid height in meters) to place them correctly.',
    );
  }
  return project;
}
