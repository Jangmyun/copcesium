import { describe, expect, it } from 'vitest';
import {
  bucketKeysByDepth,
  findRelevantKeys,
  getChildKeys,
  getDepth,
  getParentKey,
  isAncestorOf,
} from './node';

describe('getParentKey', () => {
  it('returns null for the root key', () => {
    expect(getParentKey('0-0-0-0')).toBeNull();
  });

  it('returns the parent key one level up', () => {
    expect(getParentKey('1-1-1-1')).toBe('0-0-0-0');
    expect(getParentKey('1-0-0-0')).toBe('0-0-0-0');
  });

  it('rounds each coordinate down (integer division by 2), not just strips the low bit', () => {
    expect(getParentKey('2-3-3-3')).toBe('1-1-1-1');
  });

  it('is the exact inverse of getChildKeys for every child', () => {
    const parent = '2-3-5-1';
    for (const child of getChildKeys(parent)) {
      expect(getParentKey(child)).toBe(parent);
    }
  });
});

describe('isAncestorOf', () => {
  it('recognises a direct parent', () => {
    expect(isAncestorOf('0-0-0-0', '1-1-1-1')).toBe(true);
    for (const child of getChildKeys('2-3-5-1')) {
      expect(isAncestorOf('2-3-5-1', child)).toBe(true);
    }
  });

  it('recognises an ancestor several levels up', () => {
    expect(isAncestorOf('0-0-0-0', '3-7-7-7')).toBe(true);
    expect(isAncestorOf('1-1-1-1', '3-7-7-7')).toBe(true);
    expect(isAncestorOf('1-1-1-1', '3-4-4-4')).toBe(true);
  });

  it('rejects a node that is outside the ancestor cell at the same depth', () => {
    expect(isAncestorOf('1-0-0-0', '3-7-7-7')).toBe(false);
    expect(isAncestorOf('1-1-1-1', '3-3-4-4')).toBe(false); // x falls in the sibling cell
  });

  it('rejects siblings, self, and the reverse direction (proper ancestors only)', () => {
    expect(isAncestorOf('1-0-0-0', '1-1-1-1')).toBe(false);
    expect(isAncestorOf('1-1-1-1', '1-1-1-1')).toBe(false);
    expect(isAncestorOf('3-7-7-7', '0-0-0-0')).toBe(false);
  });

  it('agrees with walking up via getParentKey', () => {
    let key = '4-9-13-2';
    while (true) {
      const parent = getParentKey(key);
      if (!parent) break;
      expect(isAncestorOf(parent, '4-9-13-2')).toBe(true);
      key = parent;
    }
  });
});

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
    const parent = getParentKey(key)!;
    const sibling = getChildKeys(parent).find((k) => k !== key)!;
    const descendant = getChildKeys(key)[0]!;
    const buckets = bucketKeysByDepth([sibling, descendant]);
    expect(findRelevantKeys(key, buckets)).toEqual([descendant]);
  });

  it('finds ancestors/descendants several levels away, but not a disjoint branch', () => {
    const key = '1-0-0-0';
    const ancestor = getParentKey(key)!; // depth 0
    const grandchild = getChildKeys(getChildKeys(key)[0]!)[0]!; // depth 3 descendant
    const disjointSibling = getChildKeys(ancestor).find((k) => k !== key)!; // depth 1 sibling
    const disjointBranch = getChildKeys(disjointSibling)[0]!; // under the sibling, not under key

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
      frontier = frontier.flatMap((k) => getChildKeys(k));
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

describe('getDepth / getChildKeys (existing coverage sanity check)', () => {
  it('getDepth extracts the leading depth component', () => {
    expect(getDepth('3-1-2-4')).toBe(3);
  });

  it('getChildKeys returns 8 keys one level deeper', () => {
    expect(getChildKeys('0-0-0-0')).toHaveLength(8);
    expect(getChildKeys('0-0-0-0')).toContain('1-1-1-1');
  });
});
