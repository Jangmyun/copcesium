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
 * Extracts the EPSG code from a WKT string.
 */
function extractEpsgCode(wkt: string): string | null {
  const idMatches = [...wkt.matchAll(/\bID\s*\[\s*"EPSG"\s*,\s*(\d+)/gi)];
  if (idMatches.length > 0) return idMatches[idMatches.length - 1][1];
  const authMatch = wkt.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"/i);
  if (authMatch) return authMatch[1];
  return null;
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

  try {
    proj4.defs(proj, crsWkt);
    proj4(proj, 'EPSG:4326', [0, 0]);
    return { proj, projDef: crsWkt, zFactor, xyFactor: zFactor };
  } catch {
    // WKT2 or an unsupported format → fall through to step 2
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
