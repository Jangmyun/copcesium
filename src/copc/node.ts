/** Extracts the depth (D) from a COPC hierarchy node key (VoxelKey, "D-X-Y-Z"). */
export function getDepth(key: string): number {
  return parseInt(key.split('-')[0]);
}

/**
 * Returns the parent key of a node key, or `null` for the root (depth 0).
 * D-X-Y-Z → (D-1)-(X>>1)-(Y>>1)-(Z>>1)
 */
export function getParentKey(key: string): string | null {
  const [d, x, y, z] = key.split('-').map(Number);
  if (d === 0) return null;
  return `${d - 1}-${x >> 1}-${y >> 1}-${z >> 1}`;
}

/**
 * True when `ancestorKey` is a proper ancestor of `key` — `key`'s cell lies
 * inside `ancestorKey`'s cell, at any depth below it. Shifting `key`'s indices
 * right by the depth difference yields its ancestor's indices at that depth.
 */
export function isAncestorOf(ancestorKey: string, key: string): boolean {
  const [ad, ax, ay, az] = ancestorKey.split('-').map(Number);
  const [d, x, y, z] = key.split('-').map(Number);
  const shift = d - ad;
  if (shift <= 0) return false;
  return x >> shift === ax && y >> shift === ay && z >> shift === az;
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
    const [d, x, y, z] = key.split('-').map(Number);
    let bucket = buckets.get(d);
    if (!bucket) buckets.set(d, (bucket = []));
    bucket.push({ key, x, y, z });
  }
  return buckets;
}

/**
 * Returns the keys in `buckets` that are an ancestor or descendant of `key`
 * at any depth -- equivalent to scanning every candidate with two
 * `isAncestorOf()` calls apiece, but without re-parsing `buckets`' keys on
 * every call, and skipping candidates at `key`'s own depth outright (neither
 * relationship is possible there, since `isAncestorOf` requires a depth
 * difference).
 */
export function findRelevantKeys(key: string, buckets: Map<number, ParsedKey[]>): string[] {
  const [d, x, y, z] = key.split('-').map(Number);
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

/**
 * Returns the 8 child keys of a node key.
 * D-X-Y-Z → (D+1)-(2X+dx)-(2Y+dy)-(2Z+dz), dx/dy/dz ∈ {0,1}
 */
export function getChildKeys(key: string): string[] {
  const [d, x, y, z] = key.split('-').map(Number);
  const nd = d + 1,
    nx = x * 2,
    ny = y * 2,
    nz = z * 2;
  return [
    `${nd}-${nx}-${ny}-${nz}`,
    `${nd}-${nx + 1}-${ny}-${nz}`,
    `${nd}-${nx}-${ny + 1}-${nz}`,
    `${nd}-${nx + 1}-${ny + 1}-${nz}`,
    `${nd}-${nx}-${ny}-${nz + 1}`,
    `${nd}-${nx + 1}-${ny}-${nz + 1}`,
    `${nd}-${nx}-${ny + 1}-${nz + 1}`,
    `${nd}-${nx + 1}-${ny + 1}-${nz + 1}`,
  ];
}
