/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Owns the live hierarchy maps and the loading of its sub-pages: which pages
 * are in flight, how often each has failed, and when to give up on one.
 * `nodes` and `pages` are mutated in place as pages arrive, so the `selectNodes`
 * walk always sees the current state.
 */
import { Copc } from 'copc';
import type { Hierarchy } from 'copc';
import { emptyInvalidNodes, maxNodeDepth, type CopcHierarchy } from './hierarchy';
import { isRetryable } from './RangeFetcher';
import { backoffMs, MAX_PAGE_LOAD_ATTEMPTS, PAGE_RETRY_BASE_MS } from './retryPolicy';
import { createCountingGetter } from './TransferCounter';

// MAX_PAGE_LOAD_ATTEMPTS (from retryPolicy.ts) is the total attempts per
// hierarchy sub-page before giving up, mirroring RangeFetcher's MAX_ATTEMPTS
// for node-level Range Requests (#117): a page that keeps failing needs a bound
// so `onPageNeeded` doesn't refire the same request forever on every LoD pass.

// Retries here aren't paced by a timer of their own — a page is re-requested
// whenever the next LoD pass rediscovers it, which is as often as every
// `debounceMs` (100ms by default) while the camera moves, and immediately on
// `moveEnd`. Without a delay of its own, all three attempts can burn inside a
// few hundred milliseconds, so a one-second network blip would exhaust the
// budget and drop the subtree for good. These spread the attempts the way
// RangeFetcher's backoff does, but longer: a give-up here is permanent for the
// session, whereas a failed node load is simply re-requested by the next pass.
// (PAGE_RETRY_BASE_MS lives in retryPolicy.ts.)
// Failures far enough apart are unrelated incidents, not one page going bad:
// without this, three isolated blips across a long session would still add up
// to a permanent give-up.
const PAGE_FAILURE_RESET_MS = 60_000;

export class HierarchyPager {
  readonly nodes: Hierarchy.Node.Map;
  /** Sub-page entry points not yet merged into `nodes`; shrinks as pages load. */
  readonly pages: Hierarchy.Page.Map;
  /** Tracked incrementally as nodes are merged in, rather than recomputed with
   *  `Math.max(...keys)` on every read — that spread blows the call stack once
   *  a multi-page hierarchy's node count passes ~124k (#126). */
  private _maxDepth: number;
  private readonly _pendingPages = new Set<string>();
  /** Failed attempts per hierarchy page key, with the timestamp of the last one
   *  so retries can be spaced out and stale counts discarded; cleared once a
   *  page loads. */
  private readonly _pageFailures = new Map<string, { count: number; at: number }>();
  /** Shared status-checked, counting Getter for hierarchy sub-pages. Retry
   *  policy stays with `loadPage()`, which already owns the attempt count and
   *  backoff — this getter makes exactly one attempt (#139). */
  private readonly _pageGetter: (begin: number, end: number) => Promise<Uint8Array>;

  /**
   * @param isDestroyed Checked after the page arrives, so a torn-down data source drops it.
   * @param onLoaded Called once a page is merged, so LoD selection can pick up the new depth.
   */
  constructor(
    private readonly _url: string,
    private readonly _hierarchy: CopcHierarchy,
    private readonly _isDestroyed: () => boolean,
    private readonly _onLoaded: () => void,
  ) {
    this.nodes = _hierarchy.nodes;
    this.pages = _hierarchy.pages;
    this._maxDepth = _hierarchy.maxDepth;
    this._pageGetter = createCountingGetter(_url, _hierarchy.counter);
  }

  get maxDepth(): number {
    return this._maxDepth;
  }

  isPending(key: string): boolean {
    return this._pendingPages.has(key);
  }

  /** Loads a hierarchy sub-page, merges its nodes/pages into the live maps,
   *  and re-runs LoD selection so the newly revealed depth can be picked up. */
  async loadPage(key: string): Promise<void> {
    const page = this.pages[key];
    if (!page) return;
    const failure = this._pageFailures.get(key);
    // Still inside this attempt's backoff — skip the pass rather than spend an
    // attempt on it. The next LoD pass to rediscover the page picks it up once
    // the delay has elapsed.
    if (failure && performance.now() - failure.at < backoffMs(PAGE_RETRY_BASE_MS, failure.count)) {
      return;
    }
    this._pendingPages.add(key);
    try {
      const { nodes, pages } = await Copc.loadHierarchyPage(this._pageGetter, page);
      if (this._isDestroyed()) return;
      emptyInvalidNodes(nodes, this._hierarchy.copc.header.pointCount, this._url);
      Object.assign(this.nodes, nodes);
      this._maxDepth = maxNodeDepth(nodes, this._maxDepth);
      delete this.pages[key];
      Object.assign(this.pages, pages);
      this._pageFailures.delete(key);
      this._onLoaded();
    } catch (err) {
      const now = performance.now();
      const recent = failure && now - failure.at < PAGE_FAILURE_RESET_MS;
      const attempts = recent ? failure.count + 1 : 1;
      this._pageFailures.set(key, { count: attempts, at: now });
      // A settled 4xx (e.g. 404 on a removed page, 416 on a bad range) never
      // succeeds on retry, so it gives up on the first attempt instead of
      // burning MAX_PAGE_LOAD_ATTEMPTS and their backoff delays (#139).
      if (attempts >= MAX_PAGE_LOAD_ATTEMPTS || !isRetryable(err)) {
        // Give up: drop the entry point so `onPageNeeded` never fires for it
        // again, and log an error once here rather than on every attempt so a
        // transient outage doesn't scroll the console.
        delete this.pages[key];
        this._pageFailures.delete(key);
        console.error(
          `[CopcDataSource] Giving up on hierarchy page "${key}" after ${attempts} attempt${attempts === 1 ? '' : 's'}:`,
          err,
        );
      } else {
        // Not silent before the cap: a page that eventually loads leaves no
        // error behind, so without this the failures that a field report would
        // need to explain a stall would be invisible.
        console.warn(
          `[CopcDataSource] Hierarchy page "${key}" failed (attempt ${attempts}/${MAX_PAGE_LOAD_ATTEMPTS}), will retry:`,
          err,
        );
      }
    } finally {
      this._pendingPages.delete(key);
    }
  }
}
