/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { detectCrs } from './detectCrs';

const SAMPLE_URL = 'https://example.com/sample.copc.laz';

describe('detectCrs', () => {
  it('returns null when wkt is missing', () => {
    expect(detectCrs(undefined, SAMPLE_URL)).toBeNull();
  });

  it('detects a plain geographic CRS as EPSG:4326', () => {
    const wkt =
      'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
      'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

    expect(detectCrs(wkt, SAMPLE_URL)).toEqual({
      proj: 'EPSG:4326',
      projDef: null,
      zFactor: 1.0,
      xyFactor: 111320,
    });
  });

  it('parses a well-formed projected WKT directly via proj4', () => {
    const wkt =
      'PROJCS["WGS 84 / UTM zone 33N",' +
      'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
      'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
      'PROJECTION["Transverse_Mercator"],' +
      'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",15],' +
      'PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],' +
      'PARAMETER["false_northing",0],UNIT["metre",1]]';

    const result = detectCrs(wkt, SAMPLE_URL);

    expect(result).not.toBeNull();
    expect(result!.projDef).toBe(wkt);
    expect(result!.zFactor).toBe(1);
    expect(result!.xyFactor).toBe(1);
  });

  it('falls back to the local EPSG table when the WKT cannot be parsed directly (meter units)', () => {
    // The GARBAGE token makes this invalid WKT syntax, so direct proj4 parsing
    // fails and it falls back to a local table lookup via ID[...] (EPSG:5186, meter unit).
    const wkt = 'PROJCS["Korea 2000 / Central Belt 2010", GARBAGE, ID["EPSG",5186]], UNIT["metre",1]';

    const result = detectCrs(wkt, SAMPLE_URL);

    expect(result).not.toBeNull();
    expect(result!.projDef).toBe(
      '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
    );
    expect(result!.zFactor).toBe(1);
    expect(result!.xyFactor).toBe(1);
  });

  it('falls back to the local EPSG table with US survey foot units', () => {
    const wkt =
      'PROJCS["NAD83 / California zone 5", GARBAGE, ID["EPSG",2229]], ' +
      'LENGTHUNIT["US survey foot",0.304800609601219]';

    const result = detectCrs(wkt, SAMPLE_URL);

    expect(result).not.toBeNull();
    expect(result!.zFactor).toBeCloseTo(0.3048006096, 8);
    expect(result!.xyFactor).toBeCloseTo(0.3048006096, 8);
  });

  it('extracts the horizontal CRS EPSG code from a COMPD_CS (horizontal + vertical) WKT', () => {
    const wkt =
      'COMPD_CS["NAD83 / UTM zone 17N + NAVD88 height", ' +
      'PROJCS["Horiz", GARBAGE, ID["EPSG",5186]], ' +
      'VERT_CS["Vert", GARBAGE, ID["EPSG",5703]]]';

    const result = detectCrs(wkt, SAMPLE_URL);

    expect(result).not.toBeNull();
    // 5186 (horizontal CRS) should be selected, not the 5703 (vertical CRS) definition.
    expect(result!.projDef).toBe(
      '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
    );
  });

  it('takes the projected CRS code, not the spheroid code that comes first in WKT1', () => {
    // GARBAGE keeps proj4 from parsing it, so this goes through the table
    // lookup; the first AUTHORITY in the string is the SPHEROID's (7019).
    const wkt =
      'PROJCS["Korea 2000 / Central Belt 2010",' +
      'GEOGCS["Korea 2000",DATUM["Geocentric_datum_of_Korea",' +
      'SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6737"]],' +
      'AUTHORITY["EPSG","4737"]],GARBAGE,AUTHORITY["EPSG","5186"]]';

    const result = detectCrs(wkt, SAMPLE_URL);

    expect(result).not.toBeNull();
    expect(result!.projDef).toBe(
      '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
    );
  });

  describe('datum shift', () => {
    const bessel = 'SPHEROID["Bessel 1841",6377397.155,299.1528128,AUTHORITY["EPSG","7004"]]';
    const tmerc = (lon0: number, y0: number) =>
      'PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",38],' +
      `PARAMETER["central_meridian",${lon0}],PARAMETER["scale_factor",1],` +
      `PARAMETER["false_easting",200000],PARAMETER["false_northing",${y0}],UNIT["metre",1]`;

    it('uses the local table definition when the WKT parses but leaves out a known TOWGS84', () => {
      // Korean 1985 / Modified Central Belt as many writers emit it: no
      // TOWGS84, so proj4 alone would apply no shift (~360 m off).
      const wkt =
        `PROJCS["Korean 1985 / Modified Central Belt",GEOGCS["Korean 1985",DATUM["Korean_Datum_1985",${bessel}],` +
        'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
        `${tmerc(127.0028902777778, 500000)},AUTHORITY["EPSG","5174"]]`;

      const result = detectCrs(wkt, SAMPLE_URL);

      expect(result!.projDef).toContain('+towgs84=-115.80,474.99,674.11');
      expect(result!.warning).toBeUndefined();
    });

    it('warns when the datum shift is in neither the WKT nor the local table', () => {
      const wkt =
        `PROJCS["Tokyo / Japan Plane Rectangular CS IX",GEOGCS["Tokyo",DATUM["Tokyo",${bessel}],` +
        'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
        `${tmerc(139.8333333333333, 0)},AUTHORITY["EPSG","30169"]]`;

      const result = detectCrs(wkt, SAMPLE_URL);

      expect(result!.projDef).toBe(wkt);
      expect(result!.warning).toMatch(/no datum shift/);
    });

    it('does not warn for a datum on the WGS84/GRS80 ellipsoid, which needs no shift', () => {
      const wkt =
        'PROJCS["Korea 2000 / Central Belt 2010",GEOGCS["Korea 2000",DATUM["Geocentric_datum_of_Korea",' +
        'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
        `${tmerc(127, 600000)},AUTHORITY["EPSG","5186"]]`;

      const result = detectCrs(wkt, SAMPLE_URL);

      expect(result!.projDef).toBe(wkt);
      expect(result!.warning).toBeUndefined();
    });
  });

  it('returns null when the CRS cannot be determined at all', () => {
    const wkt = 'NOT A REAL WKT STRING WITHOUT ANY EPSG MARKERS';

    expect(detectCrs(wkt, SAMPLE_URL)).toBeNull();
  });
});
