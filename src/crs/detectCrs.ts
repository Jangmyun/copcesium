/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import proj4 from 'proj4';
import { lookupEpsg } from './projections';
import type { CrsDetectionResult } from '../types';

/**
 * Extracts the inner PROJCS/GEOGCS block from a
 * COMPD_CS["...", PROJCS[...], VERT_CS[...]] string via bracket counting.
 * Returns the input unchanged for any other format.
 */
function extractInnerCrs(wkt: string): string {
  const upper = wkt.trim().toUpperCase();
  if (!upper.startsWith('COMPD_CS')) return wkt;

  // Look for the start position of a PROJCS or GEOGCS block
  for (const kw of ['PROJCS[', 'GEOGCS[', 'PROJCRS[', 'GEOGCRS[']) {
    const idx = upper.indexOf(kw);
    if (idx < 0) continue;
    let depth = 0;
    for (let i = idx; i < wkt.length; i++) {
      if (wkt[i] === '[') depth++;
      else if (wkt[i] === ']') {
        depth--;
        if (depth === 0) return wkt.slice(idx, i + 1);
      }
    }
  }
  return wkt;
}

/**
 * Extracts the linear unit factor (m/unit) from a WKT string.
 */
function extractLinearUnit(wkt: string): number {
  const lenMatch = wkt.match(/LENGTHUNIT\s*\[\s*"[^"]*"\s*,\s*([\d.]+(?:[eE][+-]?\d+)?)/i);
  if (lenMatch) {
    const f = parseFloat(lenMatch[1]);
    if (f > 0) return f;
  }
  const allUnits = [...wkt.matchAll(/\bUNIT\s*\[\s*"[^"]*"\s*,\s*([\d.]+(?:[eE][+-]?\d+)?)/gi)];
  for (let i = allUnits.length - 1; i >= 0; i--) {
    const f = parseFloat(allUnits[i][1]);
    if (f >= 0.05) return f;
  }
  return 1.0;
}

/**
 * Extracts the CRS's own EPSG code from a WKT string: an ID[...] (WKT2) or
 * AUTHORITY[...] (WKT1) that is a direct child of the root node. Nested ones
 * belong to its datum, spheroid, units and so on — in WKT1 the SPHEROID's
 * AUTHORITY (e.g. 7019) is the first one in the string.
 */
function extractEpsgCode(wkt: string): string | null {
  let depth = 0;
  let found: string | null = null;
  for (let i = 0; i < wkt.length; i++) {
    const c = wkt[i];
    if (c === '"') {
      // Names are quoted and may contain brackets; skip them whole.
      const close = wkt.indexOf('"', i + 1);
      if (close < 0) break;
      i = close;
    } else if (c === '[' || c === '(') {
      depth++;
    } else if (c === ']' || c === ')') {
      depth--;
    } else if (depth === 1 && !/[A-Za-z_]/.test(wkt[i - 1] ?? '')) {
      const m = /^(?:ID|AUTHORITY)\s*[[(]\s*"EPSG"\s*,\s*"?(\d+)/i.exec(wkt.slice(i, i + 48));
      if (m) found = m[1];
    }
  }
  return found;
}

// proj4's PJD_NODATUM: the WKT named a datum proj4 doesn't know and gave no
// TOWGS84, so proj4 converts with no datum shift at all.
const PJD_NODATUM = 5;
const WGS84_A = 6378137;

/** True for a proj4 definition string that carries a non-zero datum shift. */
function hasDatumShift(def: string): boolean {
  const m = /\+towgs84=([^\s]+)/.exec(def);
  return !!m && m[1].split(',').some((v) => parseFloat(v) !== 0);
}

/**
 * proj4 applies no shift for a datum it doesn't know when the WKT gives no
 * TOWGS84. On a WGS84/GRS80 ellipsoid that is within a couple of meters
 * (NAD83, ETRS89, Korea 2000…); on any other ellipsoid it is hundreds of
 * meters off (Tokyo, Korean 1985, DHDN).
 */
function lacksDatumShift(proj: string): boolean {
  const datum = (proj4.Proj(proj) as unknown as { datum?: { datum_type: number; a: number } }).datum;
  return !!datum && datum.datum_type === PJD_NODATUM && datum.a !== WGS84_A;
}

/**
 * Auto-detects the CRS and unit from a COPC file's WKT VLR.
 * Returns null if there's no WKT or the CRS can't be determined — the caller
 * then decides whether to fall back to the default (EPSG:4326).
 *
 * @param wkt WKT string from the COPC info VLR
 * @param url COPC URL, used to build a temporary CRS name to register with proj4
 */
export function detectCrs(wkt: string | undefined, url: string): CrsDetectionResult | null {
  if (!wkt) return null;
  const trimmed = wkt.trim();

  const crsWkt = extractInnerCrs(trimmed);
  const crsUpper = crsWkt.toUpperCase();

  if (/^GEOG(?:CS|CRS)\b/.test(crsUpper) || /^GEOGRAPHICCRS\b/.test(crsUpper) || /^GEODCRS\b/.test(crsUpper)) {
    return { proj: 'EPSG:4326', projDef: null, zFactor: 1.0, xyFactor: 111320 };
  }

  const zFactor = extractLinearUnit(trimmed);
  const proj = `CRS:${url.replace(/\W+/g, '_')}`;

  let parsed = false;
  try {
    proj4.defs(proj, crsWkt);
    proj4(proj, 'EPSG:4326', [0, 0]);
    parsed = true;
  } catch {
    // WKT2 or an unsupported format → fall through to step 2
  }
  if (parsed) {
    if (!lacksDatumShift(proj)) return { proj, projDef: crsWkt, zFactor, xyFactor: zFactor };
    // The WKT parsed but left the datum shift out. The local table carries
    // the published TOWGS84 for some of these (Korean 1985, RD New…).
    const tableDef = lookupEpsg(extractEpsgCode(crsWkt) ?? '');
    if (tableDef && hasDatumShift(tableDef)) {
      proj4.defs(proj, tableDef);
      return { proj, projDef: tableDef, zFactor, xyFactor: zFactor };
    }
    return {
      proj,
      projDef: crsWkt,
      zFactor,
      xyFactor: zFactor,
      warning:
        'The CRS datum has no TOWGS84 in the file and none is known locally, so it is converted to WGS84 ' +
        'with no datum shift; positions may be off by up to several hundred meters. ' +
        'Pass `projDef` with the datum shift (e.g. +towgs84=...) to correct it.',
    };
  }

  // For a COMPD_CS (horizontal + vertical CRS composite), searching the full
  // `trimmed` string could pick up the last ID[...] as the vertical CRS's
  // EPSG code (e.g. NAVD88) instead. Search only within the already-extracted
  // horizontal CRS block (crsWkt) to avoid that.
  const epsgCode = extractEpsgCode(crsWkt);
  if (epsgCode) {
    const proj4Def = lookupEpsg(epsgCode);
    if (proj4Def) {
      proj4.defs(proj, proj4Def);
      return { proj, projDef: proj4Def, zFactor, xyFactor: zFactor };
    }
  }

  return null;
}
