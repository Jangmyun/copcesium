/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { bucketKeysByDepth, findRelevantKeys, getDepth } from './node';
import { parseKey } from './key';

// Test-only key helpers, independent of the implementation under test.
function parentOf(key: string): string {
  const [d, x, y, z] = parseKey(key);
  return `${d - 1}-${x >> 1}-${y >> 1}-${z >> 1}`;
}

function childrenOf(key: string): string[] {
  const [d, x, y, z] = parseKey(key);
  const children: string[] = [];
  for (let i = 0; i < 8; i++) {
    children.push(`${d + 1}-${x * 2 + (i & 1)}-${y * 2 + ((i >> 1) & 1)}-${z * 2 + (i >> 2)}`);
  }
  return children;
}

/** True when `ancestorKey` is a proper ancestor of `key`. */
function isAncestorOf(ancestorKey: string, key: string): boolean {
  const [ad, ax, ay, az] = parseKey(ancestorKey);
  const [d, x, y, z] = parseKey(key);
  const shift = d - ad;
  if (shift <= 0) return false;
  return x >> shift === ax && y >> shift === ay && z >> shift === az;
}

describe('findRelevantKeys', () => {
  // Brute-force reference implementation matching the pre-optimization
  // CopcDataSource._isReplacementReady() scan, for comparison below.
  function bruteForceRelevantKeys(key: string, candidates: Set<string>): string[] {
    const relevant: string[] = [];
    for (const candidate of candidates) {
      if (isAncestorOf(key, candidate) || isAncestorOf(candidate, key)) relevant.push(candidate);
    }
    return relevant;
  }

  it('finds a direct parent', () => {
    const buckets = bucketKeysByDepth(['0-0-0-0']);
    expect(findRelevantKeys('1-0-0-0', buckets)).toEqual(['0-0-0-0']);
  });

  it('finds a descendant, but skips a same-depth sibling outright', () => {
    const key = '1-1-1-1';
    const parent = parentOf(key);
    const sibling = childrenOf(parent).find((k) => k !== key)!;
    const descendant = childrenOf(key)[0]!;
    const buckets = bucketKeysByDepth([sibling, descendant]);
    expect(findRelevantKeys(key, buckets)).toEqual([descendant]);
  });

  it('finds ancestors/descendants several levels away, but not a disjoint branch', () => {
    const key = '1-0-0-0';
    const ancestor = parentOf(key); // depth 0
    const grandchild = childrenOf(childrenOf(key)[0]!)[0]!; // depth 3 descendant
    const disjointSibling = childrenOf(ancestor).find((k) => k !== key)!; // depth 1 sibling
    const disjointBranch = childrenOf(disjointSibling)[0]!; // under the sibling, not under key

    const buckets = bucketKeysByDepth([ancestor, grandchild, disjointSibling, disjointBranch]);
    expect(findRelevantKeys(key, buckets).sort()).toEqual([ancestor, grandchild].sort());
  });

  it('agrees with the brute-force isAncestorOf scan across a range of key sets', () => {
    // Generate a small tree of keys up to depth 3 and, for every key in it,
    // check that the bucketed lookup returns exactly the same relevant set
    // (order-independent) as the original O(n) per-call isAncestorOf scan.
    let allKeys: string[] = ['0-0-0-0'];
    let frontier = allKeys;
    for (let depth = 0; depth < 3; depth++) {
      frontier = frontier.flatMap((k) => childrenOf(k));
      allKeys = allKeys.concat(frontier);
    }

    const candidateSet = new Set(allKeys);
    const buckets = bucketKeysByDepth(candidateSet);

    for (const key of allKeys) {
      const expected = bruteForceRelevantKeys(key, candidateSet).sort();
      const actual = findRelevantKeys(key, buckets).sort();
      expect(actual).toEqual(expected);
    }
  });
});

describe('getDepth', () => {
  it('extracts the leading depth component', () => {
    expect(getDepth('3-1-2-4')).toBe(3);
  });
});
