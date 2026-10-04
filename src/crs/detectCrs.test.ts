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

  it('returns null when the CRS cannot be determined at all', () => {
    const wkt = 'NOT A REAL WKT STRING WITHOUT ANY EPSG MARKERS';

    expect(detectCrs(wkt, SAMPLE_URL)).toBeNull();
  });
});
