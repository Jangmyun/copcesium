import { describe, expect, it, vi } from 'vitest';
import { NodeCache } from './NodeCache';
import type { LoadedNode } from '../types';
import type { PointCloudPrimitive } from '../renderer/PointCloudPrimitive';

// The cache only ever holds `primitive` and hands it back to onEvict, so a bare
// stand-in is enough; a real PointCloudPrimitive would need a GPU context.
function makeNode(key: string, pointCount = 1): LoadedNode {
  return { key, primitive: {} as unknown as PointCloudPrimitive, pointCount };
}

describe('NodeCache', () => {
  it('returns undefined for a key that was never set', () => {
    const cache = new NodeCache(10, vi.fn());
    expect(cache.get('missing')).toBeUndefined();
  });

  it('returns the exact node that was set for a key', () => {
    const cache = new NodeCache(10, vi.fn());
    const node = makeNode('a');
    cache.set('a', node);
    expect(cache.get('a')).toBe(node);
  });

  it('evicts the least-recently-used entry once over budget', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(2, onEvict);
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');

    cache.set('a', a);
    cache.set('b', b);
    cache.set('c', c); // over budget by 1 -> evicts 'a' (oldest, untouched since insertion)

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('a', a);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(b);
    expect(cache.get('c')).toBe(c);
  });

  it('get() bumps recency so a subsequent insert evicts a different entry', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(2, onEvict);
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');

    cache.set('a', a);
    cache.set('b', b);
    cache.get('a'); // 'a' is now more recently used than 'b'
    cache.set('c', c); // should evict 'b', not 'a'

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('b', b);
    expect(cache.get('a')).toBe(a);
    expect(cache.get('c')).toBe(c);
  });

  it('set() on an existing key updates it and bumps recency', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(2, onEvict);
    const a = makeNode('a');
    const aUpdated = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');

    cache.set('a', a);
    cache.set('b', b);
    cache.set('a', aUpdated); // re-set 'a' -> evicts the replaced 'a', becomes most recent
    cache.set('c', c); // should evict 'b', not 'a'

    // The replaced node ('a') is torn down, then 'b' as the LRU over budget.
    expect(onEvict.mock.calls).toEqual([
      ['a', a],
      ['b', b],
    ]);
    expect(cache.get('a')).toBe(aUpdated);
  });

  it('hands the replaced node to onEvict when overwriting a key, so its primitive is not leaked', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(10, onEvict);
    const a = makeNode('a');
    const aReplacement = makeNode('a');

    cache.set('a', a);
    cache.set('a', aReplacement); // overwrite with a different LoadedNode

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('a', a);
    expect(cache.get('a')).toBe(aReplacement);
  });

  it('does not evict when the same node object is re-set (a pure recency bump)', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(10, onEvict);
    const a = makeNode('a');

    cache.set('a', a);
    cache.set('a', a); // identical object -> nothing to tear down

    expect(onEvict).not.toHaveBeenCalled();
    expect(cache.get('a')).toBe(a);
  });

  it('peek() returns a node without bumping its LRU recency', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(2, onEvict);
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');

    cache.set('a', a);
    cache.set('b', b);
    cache.peek('a'); // unlike get(), must NOT make 'a' more recent than 'b'
    cache.set('c', c); // over budget -> 'a' is still the LRU entry, evicted

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('a', a);
    expect(cache.peek('c')).toBe(c);
  });

  it('peek() returns undefined for a key that was never set', () => {
    const cache = new NodeCache(10, vi.fn());
    expect(cache.peek('missing')).toBeUndefined();
  });

  it('size reflects the number of currently cached nodes', () => {
    const cache = new NodeCache(10, vi.fn());
    expect(cache.size).toBe(0);

    cache.set('a', makeNode('a'));
    cache.set('b', makeNode('b'));
    expect(cache.size).toBe(2);

    cache.destroy();
    expect(cache.size).toBe(0);
  });

  it('never evicts a pinned node even if it is the least-recently-used one', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(2, onEvict);
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');

    cache.set('a', a);
    cache.pin(new Set(['a']));
    cache.set('b', b);
    cache.set('c', c); // 'a' is LRU but pinned -> 'b' evicted instead

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('b', b);
    expect(cache.get('a')).toBe(a);
  });

  it('stays over budget without evicting anything when every entry is pinned', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(1, onEvict);
    const a = makeNode('a');
    const b = makeNode('b');

    cache.pin(new Set(['a', 'b']));
    cache.set('a', a);
    cache.set('b', b);

    expect(onEvict).not.toHaveBeenCalled();
    expect(cache.get('a')).toBe(a);
    expect(cache.get('b')).toBe(b);
  });

  it('pin() replaces the previously pinned set rather than adding to it', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(1, onEvict);
    const a = makeNode('a');
    const b = makeNode('b');

    cache.pin(new Set(['a']));
    cache.set('a', a);
    cache.pin(new Set(['b'])); // 'a' is no longer protected
    cache.set('b', b); // over budget -> 'a' is now evictable

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('a', a);
  });

  it('pin() bumps the recency of the nodes it pins, so a node never selected since load goes first', () => {
    // Regression test for #68: pin() is the only signal of use the cache
    // gets (the per-frame path reads via peek()), so without it the Map
    // stays in insertion order and eviction is FIFO by load time.
    const onEvict = vi.fn();
    const cache = new NodeCache(2, onEvict);
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');

    cache.set('a', a);
    cache.set('b', b); // loaded at the same time as 'a', never selected after
    cache.pin(new Set(['a'])); // 'a' is on screen this pass
    cache.pin(new Set()); // a later pass: 'a' left the selection, unprotected
    cache.set('c', c); // over budget -> 'b' is the least recently selected

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('b', b);
    expect(cache.peek('a')).toBe(a);
  });

  it('pin() ignores keys that are not cached yet, without creating entries for them', () => {
    // _updateLoD() pins the whole selection, including nodes still in flight.
    const cache = new NodeCache(10, vi.fn());
    cache.set('a', makeNode('a'));

    cache.pin(new Set(['a', 'still-loading']));

    expect(cache.size).toBe(1);
    expect(cache.peek('still-loading')).toBeUndefined();
  });

  it('destroy() evicts every remaining node via onEvict', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(10, onEvict);
    const a = makeNode('a');
    const b = makeNode('b');
    cache.set('a', a);
    cache.set('b', b);

    cache.destroy();

    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(onEvict).toHaveBeenCalledWith('a', a);
    expect(onEvict).toHaveBeenCalledWith('b', b);
  });

  it('clears the cache on destroy(), so get() afterward returns undefined', () => {
    const cache = new NodeCache(10, vi.fn());
    cache.set('a', makeNode('a'));

    cache.destroy();

    expect(cache.get('a')).toBeUndefined();
  });

  it('is idempotent — calling destroy() twice does not evict twice', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(10, onEvict);
    cache.set('a', makeNode('a'));

    cache.destroy();
    cache.destroy();

    expect(onEvict).toHaveBeenCalledTimes(1);
  });

  it('immediately evicts anything set() after destroy() instead of dropping it silently', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(10, onEvict);
    cache.destroy();

    const late = makeNode('late');
    cache.set('late', late);

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('late', late);
    expect(cache.get('late')).toBeUndefined();
  });

  it('evicts by estimated byte size (pointCount * 21) once maxBytes is exceeded, even under the node-count cap', () => {
    const onEvict = vi.fn();
    // 21 bytes/point * 100 points = 2100 bytes/node; budget of 3000 fits one
    // node but not two.
    const cache = new NodeCache(10, onEvict, 3000);
    const a = makeNode('a', 100);
    const b = makeNode('b', 100);

    cache.set('a', a);
    cache.set('b', b); // still well under maxNodes, but over maxBytes -> evicts 'a'

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('a', a);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(b);
  });

  it('does not evict on byte size when maxBytes is undefined, however large pointCount gets', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(10, onEvict);
    const huge = makeNode('huge', 10_000_000);

    cache.set('huge', huge);

    expect(onEvict).not.toHaveBeenCalled();
    expect(cache.get('huge')).toBe(huge);
  });

  it('stops evicting once back under maxBytes, without over-evicting past it', () => {
    const onEvict = vi.fn();
    // Budget for exactly two 100-point (2100-byte) nodes.
    const cache = new NodeCache(10, onEvict, 4200);
    const a = makeNode('a', 100);
    const b = makeNode('b', 100);
    const c = makeNode('c', 100);

    cache.set('a', a);
    cache.set('b', b);
    cache.set('c', c); // over by one node's worth -> evicts only 'a'

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('a', a);
    expect(cache.get('b')).toBe(b);
    expect(cache.get('c')).toBe(c);
  });

  it('subtracts a node from the byte total once it is evicted, so freed bytes are not double-counted', () => {
    const onEvict = vi.fn();
    const cache = new NodeCache(10, onEvict, 2100);
    const a = makeNode('a', 100);
    const b = makeNode('b', 100);
    const c = makeNode('c', 100);

    cache.set('a', a);
    cache.set('b', b); // evicts 'a', leaving only 'b' (2100 bytes, at budget)
    cache.set('c', c); // evicts 'b', leaving only 'c'

    expect(onEvict.mock.calls).toEqual([
      ['a', a],
      ['b', b],
    ]);
    expect(cache.get('c')).toBe(c);
  });
});
