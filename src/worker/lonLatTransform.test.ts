/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import proj4 from 'proj4';
import { createLonLatTransform, isDirect, type ProjObject } from './lonLatTransform';

// Each CRS with a point near its origin, so the grid below stays in range.
const CASES: { name: string; def: string; x: number; y: number; direct: boolean }[] = [
  {
    name: 'TEST:utm10n',
    def: '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs',
    x: 500000,
    y: 4900000,
    direct: true,
  },
  {
    // Autzen's CRS: NAD83 with a zero shift, in feet.
    name: 'TEST:oregon-ft',
    def: '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 +x_0=399999.9999984 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=ft +no_defs',
    x: 1250000,
    y: 450000,
    direct: true,
  },
  {
    name: 'TEST:korea-grs80',
    def: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
    x: 200000,
    y: 550000,
    direct: true,
  },
  {
    // A 7-parameter shift to WGS84: has to stay on forward().
    name: 'TEST:korea-bessel',
    def: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43',
    x: 200000,
    y: 450000,
    direct: false,
  },
  {
    name: 'TEST:utm33n-wkt',
    def: 'PROJCS["WGS 84 / UTM zone 33N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",15],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1]]',
    x: 400000,
    y: 5500000,
    direct: true,
  },
];
for (const c of CASES) proj4.defs(c.name, c.def);

describe('createLonLatTransform', () => {
  for (const c of CASES) {
    it(`matches proj4 forward() bit for bit for ${c.name}`, () => {
      const forward = proj4(c.name, 'EPSG:4326');
      const toLonLat = createLonLatTransform(c.name);
      const out = new Float64Array(2);
      // A few km of grid, at sub-unit offsets so the inputs aren't round numbers.
      for (let i = 0; i < 40; i++) {
        for (let j = 0; j < 40; j++) {
          const x = c.x + i * 137.123;
          const y = c.y + j * 91.457;
          toLonLat(x, y, out);
          const [lon, lat] = forward.forward([x, y]);
          expect(out[0]).toBe(lon);
          expect(out[1]).toBe(lat);
        }
      }
    });

    it(`${c.direct ? 'skips' : 'keeps'} forward() for ${c.name}`, () => {
      const source = proj4.Proj(c.name) as unknown as ProjObject;
      const dest = proj4.Proj('EPSG:4326') as unknown as ProjObject;
      expect(isDirect(source, dest)).toBe(c.direct);
    });
  }

  it('throws on non-finite input, as forward() does', () => {
    const toLonLat = createLonLatTransform('TEST:utm10n');
    expect(() => toLonLat(NaN, 4900000, new Float64Array(2))).toThrow();
  });

  it('keeps a geographic source CRS on forward()', () => {
    const source = proj4.Proj('EPSG:4269') as unknown as ProjObject;
    const dest = proj4.Proj('EPSG:4326') as unknown as ProjObject;
    expect(isDirect(source, dest)).toBe(false);
  });
});
