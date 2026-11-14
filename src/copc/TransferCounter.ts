/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Byte accounting for one COPC file.
 *
 * The library reaches the same file over four separate paths — the
 * Range-support probe and `Copc.create()`/`Copc.loadHierarchyPage()` in
 * `hierarchy.ts`, the sub-page loads in `CopcDataSource`, and node point data
 * in `RangeFetcher`. Counting only the last one (the obvious place, since it's
 * the only path this project wrote itself) would silently omit the header and
 * every hierarchy page, which is exactly the kind of hole that makes a
 * "we only transferred N MB" claim indefensible. So all four report here.
 *
 * Resource Timing can't substitute for this: the sample files are served from
 * S3, which sends no `Timing-Allow-Origin`, so `transferSize` on a
 * cross-origin `PerformanceResourceTiming` reads 0. (#181)
 */
/**
 * Node point-data fetches that did not end in delivered bytes, and bytes that
 * arrived but that no node used. `requestCount`/`transferredBytes` count only
 * responses read to the end, so on their own they cannot say how much of the
 * link went to work that was thrown away.
 *
 * Bytes for an attempt that never completed are the bytes it *asked for*: the
 * body is read in one `arrayBuffer()` call, so how much of it had arrived when
 * the attempt ended is not known. `abortedAfterHeaders` tells the two kinds of
 * abort apart — one that ended before the server answered moved little or
 * nothing, one that ended mid-body may have moved most of the span.
 */
export interface FetchWaste {
  /** Attempts ended by `cancel()`/`destroy()` after `fetch()` was called. */
  abortedRequests: number;
  /** Of those, the ones whose response headers had already arrived. */
  abortedAfterHeaders: number;
  /** Bytes the aborted attempts asked for. */
  abortedBytes: number;
  /** Attempts that ended in an HTTP error or a network failure. */
  failedRequests: number;
  /** Bytes the failed attempts asked for. */
  failedBytes: number;
  /** Attempts sent after an earlier one failed. A retry cancelled during its
   *  backoff is never sent and not counted. */
  retries: number;
  /** Bytes inside completed responses that no caller received: merge gaps,
   *  and the slices of members cancelled while their group was in flight.
   *  Already part of `transferredBytes` — a share of it, not an addition. */
  unusedBytes: number;
  /** Requests cancelled before any fetch was made for them. They cost nothing
   *  on the wire; counted to show how much cancellation saved. */
  cancelledBeforeSend: number;
}

export class TransferCounter {
  private _requestCount = 0;
  private _transferredBytes = 0;
  private _fileBytes = 0;
  private readonly _waste: FetchWaste = {
    abortedRequests: 0,
    abortedAfterHeaders: 0,
    abortedBytes: 0,
    failedRequests: 0,
    failedBytes: 0,
    retries: 0,
    unusedBytes: 0,
    cancelledBeforeSend: 0,
  };

  /** An attempt for `[begin, end)` ended by the caller's cancellation. */
  recordAborted(begin: number, end: number, afterHeaders: boolean): void {
    this._waste.abortedRequests++;
    if (afterHeaders) this._waste.abortedAfterHeaders++;
    this._waste.abortedBytes += end - begin;
  }

  /** An attempt for `[begin, end)` that failed. */
  recordFailed(begin: number, end: number): void {
    this._waste.failedRequests++;
    this._waste.failedBytes += end - begin;
  }

  /** A further attempt is actually being sent. Counted then, not when the
   *  failure decides to retry, because a cancellation during the backoff
   *  means the retry never happens. */
  recordRetry(): void {
    this._waste.retries++;
  }

  /** Bytes of a completed response that were not handed to anyone. */
  recordUnused(bytes: number): void {
    this._waste.unusedBytes += bytes;
  }

  /** Logical requests dropped before a fetch was made for them. */
  recordCancelledBeforeSend(count: number): void {
    this._waste.cancelledBeforeSend += count;
  }

  /** A snapshot; later records don't change it. */
  get waste(): FetchWaste {
    return { ...this._waste };
  }

  /**
   * Records one HTTP range response that was actually read.
   *
   * Call this per *response*, not per logical request: `RangeFetcher` merges
   * adjacent ranges from the same tick into a single fetch (#86), so the span
   * that crossed the wire is the merged one — including any gap between the
   * ranges that were merged. Counting the logical requests instead would
   * report more requests than were made and fewer bytes than were received.
   */
  record(begin: number, end: number): void {
    this._requestCount++;
    this._transferredBytes += end - begin;
  }

  /** Total size of the file, once a range response has disclosed it. */
  setFileBytes(bytes: number): void {
    this._fileBytes = bytes;
  }

  get fileBytes(): number {
    return this._fileBytes;
  }
  get requestCount(): number {
    return this._requestCount;
  }
  get transferredBytes(): number {
    return this._transferredBytes;
  }
}

/**
 * Reads the total file size out of a `Content-Range: bytes <a>-<b>/<total>`
 * header, or `undefined` for a missing/unparseable header (including the
 * `*` an unsatisfiable range answers with).
 *
 * Any range response carries this, so the size costs no extra request — the
 * `206` probe `hierarchy.ts` already sends is enough.
 */
export function parseContentRangeTotal(header: string | null): number | undefined {
  if (!header) return undefined;
  const match = /\/\s*(\d+)\s*$/.exec(header);
  if (!match) return undefined;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : undefined;
}

/** Carries `status` so `isRetryable()` can tell a settled 4xx from a 5xx. */
function httpError(url: string, status: number, begin: number, end: number): Error {
  const err = new Error(
    `copcesium: server returned HTTP ${status} for bytes=${begin}-${end - 1} of ${url} (expected 206 Partial Content)`,
  ) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * A `copc` `Getter` that fetches one range, insists on `206`, and reports the
 * bytes to `counter`.
 *
 * `copc`'s own default getter (what it builds when handed a URL string)
 * never inspects the response status, so a 404 arrives as ordinary body bytes
 * rather than a throw — see #139. Passing this instead fixes that for every
 * caller, and is the only way to make those paths countable at all.
 *
 * Deliberately single-attempt: `CopcDataSource._loadPage()` owns the retry
 * count and backoff for hierarchy pages, and retrying here too would multiply
 * the two together.
 */
export function createCountingGetter(
  url: string,
  counter: TransferCounter,
): (begin: number, end: number) => Promise<Uint8Array> {
  return async (begin: number, end: number): Promise<Uint8Array> => {
    const response = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
    if (response.status !== 206) throw httpError(url, response.status, begin, end);
    if (counter.fileBytes === 0) {
      const total = parseContentRangeTotal(response.headers?.get('Content-Range') ?? null);
      if (total !== undefined) counter.setFileBytes(total);
    }
    counter.record(begin, end);
    return new Uint8Array(await response.arrayBuffer());
  };
}
