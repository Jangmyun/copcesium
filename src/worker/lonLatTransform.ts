/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Projected X/Y to WGS84 lon/lat for `convertNode()`'s per-point loop.
 *
 * `proj4(proj, 'EPSG:4326').forward()` was most of the decode stage: around
 * 0.5-0.6 s per million points, against 0.6-0.75 s for the LAZ decode itself.
 * Almost none of that is the projection math. Each call clones the point,
 * checks it, allocates a fresh object at every step of `transformInternal`,
 * and runs the datum step even when it ends up doing nothing. For the common
 * case — a projected CRS on a datum that needs no shift to WGS84 — this runs
 * the same arithmetic directly: scale to meters, the projection's own
 * `inverse()`, radians to degrees. Everything else still goes through
 * `forward()`, so results never differ, only the cost.
 */
import proj4 from 'proj4';

// proj4's lib/constants/values.js. R2D must be the same double as there for the
// fast path to land on the same doubles as `forward()`.
const PJD_3PARAM = 1;
const PJD_7PARAM = 2;
const PJD_GRIDSHIFT = 3;
const PJD_NODATUM = 5;
const R2D = 57.29577951308232;

/** The fields of a proj4 `Proj` that `transformInternal` reads. */
interface ProjDatum {
  datum_type: number;
  datum_params?: number[];
  a: number;
  es: number;
}
export interface ProjObject {
  projName?: string;
  datumCode?: string;
  to_meter?: number;
  from_greenwich?: number;
  datum?: ProjDatum;
  inverse: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null | undefined;
}

/** Writes `[lon, lat]` in degrees into `out`; NaN where the CRS can't map the point. */
export type LonLatTransform = (x: number, y: number, out: Float64Array) => void;

const hasParams = (type: number): boolean => type === PJD_3PARAM || type === PJD_7PARAM;

/** proj4's `compareDatums` (lib/datumUtils.js). */
function sameDatum(s: ProjDatum, d: ProjDatum): boolean {
  if (s.datum_type !== d.datum_type) return false;
  if (s.a !== d.a || Math.abs(s.es - d.es) > 0.00000000005) return false;
  const sp = s.datum_params ?? [];
  const dp = d.datum_params ?? [];
  if (s.datum_type === PJD_3PARAM) return sp[0] === dp[0] && sp[1] === dp[1] && sp[2] === dp[2];
  if (s.datum_type === PJD_7PARAM) return sp.every((v, i) => v === dp[i]);
  return true;
}

/**
 * True when `transformInternal(source, dest, …)` would do nothing beyond the
 * source projection's `inverse()` and the radians-to-degrees step. Mirrors
 * its branches: the WGS84 detour (`checkNotWGS`), prime meridians, and every
 * early return of `datum_transform`.
 */
export function isDirect(source: ProjObject, dest: ProjObject): boolean {
  if (source.projName === 'longlat' || dest.projName !== 'longlat') return false;
  if (source.from_greenwich || dest.from_greenwich) return false;
  const s = source.datum;
  const d = dest.datum;
  if (!s || !d) return false;
  const shifted = (t: number): boolean => hasParams(t) || t === PJD_GRIDSHIFT;
  if (
    (shifted(s.datum_type) && dest.datumCode !== 'WGS84') ||
    (shifted(d.datum_type) && source.datumCode !== 'WGS84')
  ) {
    return false;
  }
  if (sameDatum(s, d)) return true;
  if (s.datum_type === PJD_NODATUM || d.datum_type === PJD_NODATUM) return true;
  if (s.datum_type === PJD_GRIDSHIFT || d.datum_type === PJD_GRIDSHIFT) return false;
  return s.es === d.es && s.a === d.a && !hasParams(s.datum_type) && !hasParams(d.datum_type);
}

/** `proj` must already be registered with `proj4.defs` (or be built in). */
export function createLonLatTransform(proj: string): LonLatTransform {
  const converter = proj4(proj, 'EPSG:4326');
  const slow: LonLatTransform = (x, y, out) => {
    const [lon, lat] = converter.forward([x, y]);
    out[0] = lon;
    out[1] = lat;
  };

  const source = proj4.Proj(proj) as unknown as ProjObject;
  const dest = proj4.Proj('EPSG:4326') as unknown as ProjObject;
  if (!isDirect(source, dest)) return slow;

  const toMeter = source.to_meter;
  const point = { x: 0, y: 0, z: 0 };
  return (x, y, out) => {
    // proj4's checkSanity throws on these; let it, with its own message.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return slow(x, y, out);
    point.x = toMeter ? x * toMeter : x;
    point.y = toMeter ? y * toMeter : y;
    point.z = 0;
    const p = source.inverse(point);
    out[0] = p ? p.x * R2D : NaN;
    out[1] = p ? p.y * R2D : NaN;
  };
}
