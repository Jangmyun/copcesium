/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Which bytes of a LAZ 1.4 layered chunk (point formats 6 and 7) copcesium
 * actually decodes.
 *
 * Such a chunk starts with its first point raw, a point count and the byte
 * size of every attribute layer, then the layers in a fixed order. The worker
 * reads only X/Y/Z, classification, intensity and RGB, so the flags, scan
 * angle, user data, point source and GPS time layers can be replaced with
 * zeros: laz-perf still decodes the used fields unchanged, since each layer is
 * compressed on its own.
 */

/** Byte range within a chunk, `end` exclusive. */
export interface Range {
  begin: number;
  end: number;
}

const POINT14 = [
  'xy',
  'z',
  'classification',
  'flags',
  'intensity',
  'scanAngle',
  'userData',
  'pointSource',
  'gpsTime',
];
const LAYERS: Record<number, string[]> = { 6: POINT14, 7: [...POINT14, 'rgb'] };
/** Size of the raw first point. */
const RAW_POINT: Record<number, number> = { 6: 30, 7: 36 };
const USED = new Set(['xy', 'z', 'classification', 'intensity', 'rgb']);
/** Small unused layers between used ones are kept rather than split around. */
const LAYER_GAP = 4096;

/**
 * The ranges of `chunk` the decoder needs, in order and merged across small
 * gaps, or null to keep the whole chunk: any other point format, a chunk too
 * short for its head, or layer sizes that don't add up to its length (which
 * also covers chunks carrying extra-byte layers).
 */
export function usedLayerRanges(chunk: Uint8Array, pointFormat: number): Range[] | null {
  const layers = LAYERS[pointFormat];
  if (!layers) return null;
  const headEnd = RAW_POINT[pointFormat]! + 4 + layers.length * 4;
  if (chunk.byteLength < headEnd) return null;

  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const want: Range[] = [{ begin: 0, end: headEnd }];
  let at = headEnd;
  for (let i = 0; i < layers.length; i++) {
    const size = view.getUint32(headEnd - (layers.length - i) * 4, true);
    if (USED.has(layers[i]!) && size > 0) want.push({ begin: at, end: at + size });
    at += size;
  }
  if (at !== chunk.byteLength) return null;

  const out: Range[] = [];
  for (const r of want) {
    const last = out[out.length - 1];
    if (last && r.begin - last.end <= LAYER_GAP) last.end = r.end;
    else out.push({ ...r });
  }
  return out;
}
