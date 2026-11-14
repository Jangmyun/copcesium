/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * HTTP fetch stage for node point data. Batches overlapping byte-range
 * requests for the same COPC file into merged HTTP Range Requests, bounds
 * how many are in flight at once, and retries retryable failures with
 * backoff. Only `loadNode`'s point-data fetches go through this class;
 * hierarchy page loads use their own getter and retry loop in
 * `CopcDataSource`, reusing this file's `isRetryable` to classify failures
 * the same way.
 */
import { NetworkEstimator, OverlapClock } from './NetworkEstimator';
import type { TransferCounter } from './TransferCounter';

/**
 * Turns the fixed `gapBytes` into one measured from the link while the
 * fetcher runs. See `NetworkEstimator` for why the break-even gap is
 * `time-to-first-byte × link rate ÷ maxConcurrent`.
 */
export interface AdaptiveGapOptions {
  /** Lower clamp on the measured gap. Default `0`. */
  minGapBytes?: number;
  /** Upper clamp on the measured gap. Default 256 KiB. */
  maxGapBytes?: number;
  /** Replaces `maxGroupBytes` while the adaptive gap is on. Default 4 MiB. */
  maxGroupBytes?: number;
  /** Clock, for tests. Default `performance.now`. */
  now?: () => number;
}

/** Shared by every member of one merged fetch, so the last cancellation in a
 *  group can abort the fetch itself instead of just discarding its result. */
interface GroupState {
  liveCount: number;
  controller: AbortController | null;
}

interface RangeRequest {
  begin: number;
  end: number;
  /** End of the bytes after `end` that the caller skipped but that belong to
   *  the same chunk; equal to `end` when nothing was skipped. */
  slackEnd: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  cancelled: boolean;
  /** Set once `_flush()` groups this request; null while still queued. */
  group: GroupState | null;
}

/** One flushed, grouped batch of requests waiting for a fetch slot. */
interface QueuedGroup {
  requests: RangeRequest[];
  state: GroupState;
}

/** A `fetch()` result whose underlying request can be abandoned early. */
export type CancellableBytesPromise = Promise<Uint8Array> & { cancel: () => void };

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** Carries `status` so the retry policy can tell a 5xx from a 4xx. */
function httpError(status: number, begin: number, end: number): Error {
  const err = new Error(
    `RangeFetcher: server returned HTTP ${status} for bytes=${begin}-${end - 1} (expected 206 Partial Content)`,
  ) as Error & { status: number };
  err.status = status;
  return err;
}

/** Exported so other callers hitting the same file over HTTP (e.g.
 *  `CopcDataSource`'s hierarchy page loads) can classify a settled 4xx the
 *  same way, instead of retrying an answer that will never change. */
export function isRetryable(err: unknown): boolean {
  // A cancelled request must never be retried — `cancel()`/`destroy()` raise
  // this name precisely to say the result is no longer wanted.
  if ((err as Error).name === 'AbortError') return false;
  const status = (err as { status?: number }).status;
  // No status means `fetch()` itself rejected (DNS failure, connection reset,
  // TLS error) rather than the server answering — transient often enough to
  // be worth another attempt.
  return status === undefined || status >= 500;
}

/**
 * Resolves after `ms`, or immediately if `signal` aborts first. A plain
 * `setTimeout` here would let a group cancelled mid-backoff sit on its
 * `maxConcurrent` slot (only freed in `_fetchGroup()`'s `finally`, once
 * `_fetchRange()` actually returns) for the rest of the delay — up to the
 * full backoff, every retry — instead of freeing it for the next group
 * `_pump()` is waiting to dispatch (#123 review).
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// A group's members all stay unresolved until its one shared fetch finishes,
// so an unbounded group trades away progressive rendering (many small nodes
// popping in as they each finish) for fewer, larger requests that all land at
// once — worse the bigger the group gets. 512 KiB caps how long the slowest
// case can block a batch of sibling nodes, while still merging the common
// case of a handful of contiguous nodes into one request (#86).
const DEFAULT_MAX_GROUP_BYTES = 512 * 1024;

// Before #86, each node's Range Request was made inside its worker task, so
// WorkerPool's own concurrency (its worker count) throttled how many were
// ever in flight together. Moving the fetch to the main thread — ahead of
// the worker handoff — dropped that gate: `_updateLoD()` dispatches every
// newly-selected node's load in one synchronous pass (up to
// `maxVisibleNodes`, e.g. 100), and with nothing here to hold them back they
// all left as HTTP requests at once, well past what a browser's per-origin
// connection limit or the decode pipeline behind it could actually use.
// This default restores a comparable cap for callers that don't pass their
// own (`CopcDataSource` passes its `WorkerPool`'s concurrency instead, so
// fetch throughput tracks decode throughput exactly).
const DEFAULT_MAX_CONCURRENT = 6;

// Total attempts per group, retried only for the failures that a retry can
// plausibly fix: 5xx and network-level errors. A 4xx (403 on an expired
// pre-signed URL, 416 on a bad range) is a settled answer — retrying it just
// delays the inevitable failure — and an AbortError means the caller already
// said it no longer wants the result (#117).
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

// Clamps for the adaptive gap. 256 KiB is roughly `RTT × bandwidth ÷
// concurrency` at 100 ms, 100 Mbps and five fetches, the widest link this was
// measured on, where a fixed 256 KiB gap won; going past it only adds gap
// bytes on links fast enough that a request costs little anyway. The group cap
// is raised alongside, because a 256 KiB gap under the default 512 KiB cap
// could rarely merge anything; 4 MiB is the cap the gap rule was measured with.
const DEFAULT_MAX_ADAPTIVE_GAP = 256 * 1024;
const DEFAULT_ADAPTIVE_MAX_GROUP_BYTES = 4 * 1024 * 1024;

// How long one attempt may go without the server sending anything — the
// response headers, or the next chunk of the body — before it is abandoned
// and retried. Measured from the last progress, not from the start, so a
// large group arriving slowly but steadily is never cut off; only a stalled
// connection is, which would otherwise hold one of `maxConcurrent` slots
// indefinitely.
const DEFAULT_IDLE_TIMEOUT_MS = 20_000;

function timeoutError(ms: number): Error {
  const err = new Error(`RangeFetcher: no data from the server for ${ms} ms`);
  err.name = 'TimeoutError';
  return err;
}

/**
 * Batches concurrent byte-range requests for one COPC file into fewer HTTP
 * Range Requests, merging ones within `gapBytes` of each other into a single
 * fetch and slicing the response back apart. At most `maxConcurrent` group
 * fetches run at once; the rest queue until a slot frees up.
 *
 * `CopcDataSource._updateLoD()` dispatches every newly-selected node's load
 * within the same synchronous pass, so requests queued in the same microtask
 * tick are exactly the sibling nodes a COPC writer already lays out
 * contiguously — merging them needs no cross-worker coordination as long as
 * the fetch itself happens here, on the main thread, before a node's decode
 * is handed to a worker (#86).
 */
export class RangeFetcher {
  private pending: RangeRequest[] = [];
  private flushScheduled = false;
  private readonly queue: QueuedGroup[] = [];
  private activeCount = 0;
  private readonly inFlight = new Set<AbortController>();
  private destroyed = false;
  private readonly estimator: NetworkEstimator | null;
  private readonly overlap: OverlapClock | null;
  private readonly now: () => number;

  constructor(
    private readonly url: string,
    private readonly gapBytes = 0,
    private readonly maxGroupBytes = DEFAULT_MAX_GROUP_BYTES,
    private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT,
    /** Optional; omit it and nothing is tallied. Supplied by `CopcDataSource`
     *  so node point data lands in the same total as the header and the
     *  hierarchy pages (#181). */
    private readonly counter?: TransferCounter,
    private readonly idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    /** Omit to keep the fixed `gapBytes`. `gapBytes` is then only the gap
     *  used until enough responses have been timed. */
    private readonly adaptive?: AdaptiveGapOptions,
    /** Widest skipped tail (see `fetch()`'s `slackEnd`) re-fetched to keep
     *  two neighbors in one request, on top of whatever gap is in use. */
    private readonly tailGapBytes = 0,
  ) {
    this.estimator = adaptive ? new NetworkEstimator() : null;
    this.overlap = adaptive ? new OverlapClock() : null;
    this.now = adaptive?.now ?? (() => performance.now());
  }

  /** The merge gap the next flush would use when its batch can't all be
   *  dispatched at once. Equal to `gapBytes` unless adaptive. */
  get currentGapBytes(): number {
    if (!this.estimator) return this.gapBytes;
    return this.estimator.gapBytes(
      this.adaptive!.minGapBytes ?? 0,
      this.adaptive!.maxGapBytes ?? DEFAULT_MAX_ADAPTIVE_GAP,
      this.gapBytes,
      this.maxConcurrent,
    );
  }

  /** Read-only view of the link estimate, for diagnostics. Null unless adaptive. */
  get network(): Pick<NetworkEstimator, 'ready' | 'ttfbMs' | 'bytesPerMs'> | null {
    return this.estimator;
  }

  /**
   * Resolves with the raw bytes for `[begin, end)`.
   *
   * `slackEnd` (default `end`) marks bytes the caller chose to skip after
   * `end` — the unused tail of a chunk read layer by layer, or the hole
   * between a chunk's two used ranges. Skipping them leaves a gap between
   * neighbors that a fixed gap of 0 would never bridge, so a batch of sibling
   * nodes that used to go out as one request goes out as one per node. A gap
   * that lies wholly inside the earlier request's slack is bridged up to
   * `tailGapBytes`, or up to the merge gap in use if that is wider; the
   * skipped bytes are downloaded and dropped, never handed to the caller.
   */
  fetch(begin: number, end: number, slackEnd = end): CancellableBytesPromise {
    if (this.destroyed) {
      const rejected = Promise.reject(
        abortError('RangeFetcher: fetch() called after destroy()'),
      ) as CancellableBytesPromise;
      rejected.cancel = () => {};
      return rejected;
    }
    let req!: RangeRequest;
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      req = { begin, end, slackEnd: Math.max(end, slackEnd), resolve, reject, cancelled: false, group: null };
      this.pending.push(req);
      this._scheduleFlush();
    }) as CancellableBytesPromise;
    promise.cancel = () => {
      if (req.cancelled) return;
      req.cancelled = true;
      // A request already merged into a group can't be pulled back out on its
      // own — the fetch is shared — but once every sibling in that group has
      // also been cancelled, the whole group's result is wanted by nobody, so
      // it can be dropped instead of doing (or downloading the result of) a
      // fetch nothing will use: aborted if already in flight, or simply
      // pulled out of the queue if it hadn't gotten a slot yet.
      const group = req.group;
      if (!group || --group.liveCount > 0) return;
      if (group.controller) group.controller.abort();
      else this._cancelQueuedGroup(group);
    };
    return promise;
  }

  /** Rejects anything not yet sent, and aborts any fetch already in flight. */
  destroy(): void {
    this.destroyed = true;
    for (const req of this.pending) req.reject(abortError('RangeFetcher: destroyed before its request was sent'));
    this.pending = [];
    for (const { requests } of this.queue) {
      for (const req of requests) req.reject(abortError('RangeFetcher: destroyed before its request was sent'));
    }
    this.queue.length = 0;
    for (const controller of this.inFlight) controller.abort();
  }

  private _scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this._flush());
  }

  private _flush(): void {
    this.flushScheduled = false;
    const batch = this.pending;
    this.pending = [];
    const live: RangeRequest[] = [];
    for (const req of batch) {
      if (req.cancelled) req.reject(abortError('RangeFetcher: request cancelled before it reached a fetch'));
      // An empty range needs no bytes, and alone it would go out as the
      // invalid header `bytes=b-(b-1)` and fail with a 416.
      else if (req.end <= req.begin) req.resolve(new Uint8Array(0));
      else live.push(req);
    }
    if (live.length < batch.length) this.counter?.recordCancelledBeforeSend(batch.length - live.length);
    for (const group of this._group(live)) {
      const state: GroupState = { liveCount: group.length, controller: null };
      for (const req of group) req.group = state;
      this.queue.push({ requests: group, state });
    }
    this._pump();
  }

  /** Removes a not-yet-dispatched group from the queue and rejects its members. */
  private _cancelQueuedGroup(state: GroupState): void {
    const index = this.queue.findIndex((queued) => queued.state === state);
    if (index === -1) return; // already dispatched by the time this ran
    const [removed] = this.queue.splice(index, 1);
    this.counter?.recordCancelledBeforeSend(removed!.requests.length);
    for (const req of removed!.requests) {
      req.reject(abortError('RangeFetcher: request cancelled before it reached a fetch'));
    }
  }

  /** Dispatches queued groups until `maxConcurrent` fetches are in flight. */
  private _pump(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const { requests, state } = this.queue.shift()!;
      this.activeCount++;
      void this._fetchGroup(requests, state).finally(() => {
        this.activeCount--;
        this._pump();
      });
    }
  }

  /**
   * Groups a flushed batch. With a fixed gap this is just `_merge()`. With the
   * adaptive gap, bridging a gap only pays when a request saved would
   * otherwise have waited for a slot: if the contiguous-only groups all fit in
   * the free slots, they go out in parallel and merging across gaps would
   * just download the gap bytes for nothing. So the measured gap applies only
   * when the batch would queue.
   */
  private _group(requests: RangeRequest[]): RangeRequest[][] {
    if (!this.adaptive) return this._merge(requests, this.gapBytes, this.maxGroupBytes);
    const contiguous = this._merge(requests, 0, this.maxGroupBytes);
    const free = this.maxConcurrent - this.activeCount - this.queue.length;
    if (contiguous.length <= free) return contiguous;
    return this._merge(
      requests,
      this.currentGapBytes,
      Math.max(this.maxGroupBytes, this.adaptive.maxGroupBytes ?? DEFAULT_ADAPTIVE_MAX_GROUP_BYTES),
    );
  }

  /**
   * Sorts by offset and merges requests within `gapBytes` of their neighbor
   * (or within `tailGapBytes`, when the gap is only the neighbor's skipped
   * tail), unless doing so would grow the group's span past `maxGroupBytes` —
   * a request that alone exceeds the cap still gets its own group, since
   * there's no smaller fetch that would satisfy it.
   *
   * A group reaches as far as its furthest-ending member, not its last one:
   * sorted by `begin`, a later member can lie wholly inside an earlier one,
   * and measuring from the later member's end would both cut the earlier
   * member's bytes short and mis-measure the gap to whatever comes next.
   *
   * Groups come back in request order, each placed by its earliest member.
   * Offset order only finds the neighbors: `_updateLoD()` asks for nodes most
   * important first, and leaving the groups sorted by offset made the file's
   * layout decide what appeared on screen first once `maxConcurrent` queued
   * the rest.
   */
  private _merge(requests: RangeRequest[], gapBytes: number, maxGroupBytes: number): RangeRequest[][] {
    const askedAt = new Map(requests.map((req, i) => [req, i]));
    const sorted = [...requests].sort((a, b) => a.begin - b.begin);
    const tailGap = Math.max(gapBytes, this.tailGapBytes);
    const groups: RangeRequest[][] = [];
    // The current group's furthest-ending member.
    let reach: RangeRequest | undefined;
    for (const req of sorted) {
      const group = groups[groups.length - 1];
      const spanIfAdded = group ? Math.max(reach!.end, req.end) - group[0]!.begin : 0;
      const limit = reach && req.begin <= reach.slackEnd ? tailGap : gapBytes;
      if (reach && req.begin - reach.end <= limit && spanIfAdded <= maxGroupBytes) {
        group!.push(req);
        if (req.end > reach.end) reach = req;
      } else {
        groups.push([req]);
        reach = req;
      }
    }
    const firstAsked = (group: RangeRequest[]): number =>
      Math.min(...group.map((req) => askedAt.get(req)!));
    return groups.sort((a, b) => firstAsked(a) - firstAsked(b));
  }

  private async _fetchGroup(group: RangeRequest[], state: GroupState): Promise<void> {
    const groupBegin = group[0]!.begin;
    const groupEnd = Math.max(...group.map((req) => req.end));
    const controller = new AbortController();
    state.controller = controller;
    this.inFlight.add(controller);
    try {
      const bytes = await this._fetchRange(groupBegin, groupEnd, controller.signal);
      let used = 0;
      let usedEnd = groupBegin;
      for (const req of group) {
        if (req.cancelled) {
          req.reject(abortError('RangeFetcher: request cancelled before its result was needed'));
        } else {
          // A copy, not a view — each member is handed off independently
          // (e.g. transferred to a worker), which a shared buffer can't be.
          req.resolve(bytes.slice(req.begin - groupBegin, req.end - groupBegin));
          // Members are in offset order and may overlap; count each byte once.
          used += Math.max(0, req.end - Math.max(req.begin, usedEnd));
          usedEnd = Math.max(usedEnd, req.end);
        }
      }
      this.counter?.recordUnused(bytes.length - used);
    } catch (err) {
      const error = err as Error;
      for (const req of group) req.reject(error);
    } finally {
      this.inFlight.delete(controller);
    }
  }

  /**
   * One group's Range Request, retried on the failures a retry can fix.
   *
   * `signal` is reused across attempts rather than replaced per attempt:
   * `cancel()` and `destroy()` abort the one controller `_fetchGroup()`
   * registered, so swapping in a fresh controller mid-retry would strand an
   * abort that landed against the previous one, leaving a cancelled group
   * still fetching.
   */
  private async _fetchRange(begin: number, end: number, signal: AbortSignal): Promise<Uint8Array> {
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) this.counter?.recordRetry();
      let afterHeaders = false;
      try {
        const sentAt = this.now();
        let headersAt = sentAt;
        // Every body is clocked from its headers on, even one that fails or is
        // aborted, since it still shared the link with the bodies that do get
        // timed.
        let mark: number | null = null;
        let bodyArea = 0;
        let bodyEnd = sentAt;
        let bytes: Uint8Array;
        try {
          bytes = await this._attempt(begin, end, signal, () => {
            afterHeaders = true;
            headersAt = this.now();
            if (this.overlap) mark = this.overlap.start(headersAt);
          });
        } finally {
          // One timestamp for both the overlap integral and the body time, so
          // `sharedWith` is the mean over exactly the interval it divides by.
          bodyEnd = this.now();
          if (mark !== null) bodyArea = this.overlap!.end(bodyEnd, mark);
        }
        // Only successful reads are timed: a failed or aborted attempt says
        // nothing about what the next request on a working link costs.
        if (this.estimator) {
          const bodyMs = bodyEnd - headersAt;
          this.estimator.record({
            ttfbMs: headersAt - sentAt,
            bodyMs,
            bytes: bytes.length,
            sharedWith: bodyMs > 0 ? bodyArea / bodyMs : 1,
          });
        }
        // Counted after the body is in hand, not at the response headers: the
        // LoD pass cancels requests the camera has moved past (#86), and an
        // abort partway through the download would otherwise be tallied as a
        // full transfer. Counted here rather than in `fetch()` because this is
        // the merged span that actually crossed the wire, and it runs once per
        // response, so a retried attempt only counts when it finally delivers.
        this.counter?.record(begin, begin + bytes.length);
        return bytes;
      } catch (err) {
        // Tallied per attempt, so a group that fails twice and then succeeds
        // shows two failures and two retries next to its one counted response.
        if (signal.aborted) this.counter?.recordAborted(begin, end, afterHeaders);
        else this.counter?.recordFailed(begin, end);
        if (attempt >= MAX_ATTEMPTS || signal.aborted || !isRetryable(err)) throw err;
        await delay(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
        // Cancelled while backing off — don't resurrect work nobody wants.
        if (signal.aborted) throw abortError('RangeFetcher: request cancelled while waiting to retry');
      }
    }
  }

  /**
   * One attempt at a group's Range Request. It runs on its own controller,
   * which follows `signal` (the caller's cancellation) and also fires when
   * the server sends nothing for `idleTimeoutMs`. A stall then surfaces as a
   * retryable `TimeoutError`, not as the `AbortError` that tells
   * `_fetchRange()` the caller gave up. `onHeaders` runs once the response
   * headers arrive, so an abort can be told apart as before or after them.
   */
  private async _attempt(
    begin: number,
    end: number,
    signal: AbortSignal,
    onHeaders: () => void,
  ): Promise<Uint8Array> {
    const controller = new AbortController();
    const follow = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', follow, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.idleTimeoutMs);
    };
    try {
      touch();
      const response = await fetch(this.url, {
        headers: { Range: `bytes=${begin}-${end - 1}` },
        signal: controller.signal,
      });
      onHeaders();
      touch();
      // Strictly 206, not merely `ok`: a 200 means the server ignored the
      // Range header and sent the whole file, and those bytes would then be
      // sliced at range-relative offsets — silently handing the decoder data
      // from the wrong part of the file instead of failing (#117). That body
      // can be the whole multi-GB file, so release it rather than leave the
      // stream open until it is garbage-collected.
      if (response.status !== 206) {
        void response.body?.cancel().catch(() => {});
        throw httpError(response.status, begin, end);
      }
      const bytes = await readBody(response, touch);
      // A short body would otherwise reach the decoder as a truncated chunk.
      // A longer one is harmless: members are sliced from its start.
      if (bytes.length < end - begin) {
        throw new Error(
          `RangeFetcher: expected ${end - begin} bytes for bytes=${begin}-${end - 1}, received ${bytes.length}`,
        );
      }
      return bytes;
    } catch (err) {
      if (timedOut) throw timeoutError(this.idleTimeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', follow);
    }
  }
}

/** Reads a response body chunk by chunk, calling `onProgress` for each, so
 *  the idle timer measures silence rather than total download time. */
async function readBody(response: Response, onProgress: () => void): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onProgress();
    chunks.push(value);
    length += value.length;
  }
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
