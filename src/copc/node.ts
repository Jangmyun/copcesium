/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun), 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { parseKey } from './key';

/** Extracts the depth (D) from a COPC hierarchy node key (VoxelKey, "D-X-Y-Z"). */
export function getDepth(key: string): number {
  // parseInt stops at the first '-', so this reads just the leading D component.
  return parseInt(key, 10);
}

/** A node key split into its integer parts, kept alongside the original
 *  string so callers don't have to re-parse it after a bucket lookup. */
export interface ParsedKey {
  key: string;
  x: number;
  y: number;
  z: number;
}

/** Groups `keys` by depth into pre-parsed integer tuples. Used to make
 *  repeated ancestor/descendant lookups (see `findRelevantKeys`) cheap: each
 *  key is split once here instead of being re-split by every comparison. */
export function bucketKeysByDepth(keys: Iterable<string>): Map<number, ParsedKey[]> {
  const buckets = new Map<number, ParsedKey[]>();
  for (const key of keys) {
    const [d, x, y, z] = parseKey(key);
    let bucket = buckets.get(d);
    if (!bucket) buckets.set(d, (bucket = []));
    bucket.push({ key, x, y, z });
  }
  return buckets;
}

/**
 * Returns the keys in `buckets` that are an ancestor or descendant of `key`
 * at any depth. A candidate at `key`'s own depth is skipped outright (neither
 * relationship is possible there); otherwise the deeper key's indices,
 * shifted right by the depth difference, must equal the shallower key's.
 */
export function findRelevantKeys(key: string, buckets: Map<number, ParsedKey[]>): string[] {
  const [d, x, y, z] = parseKey(key);
  const relevant: string[] = [];
  for (const [cd, candidates] of buckets) {
    if (cd === d) continue;
    const shift = cd > d ? cd - d : d - cd;
    for (const c of candidates) {
      const isRelevant =
        cd > d
          ? c.x >> shift === x && c.y >> shift === y && c.z >> shift === z
          : x >> shift === c.x && y >> shift === c.y && z >> shift === c.z;
      if (isRelevant) relevant.push(c.key);
    }
  }
  return relevant;
}
