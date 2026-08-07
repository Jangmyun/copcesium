/** Shared by every member of one merged fetch, so the last cancellation in a
 *  group can abort the fetch itself instead of just discarding its result. */
interface GroupState {
  liveCount: number;
  controller: AbortController | null;
}

interface RangeRequest {
  begin: number;
  end: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  cancelled: boolean;
  /** Set once `_flush()` groups this request; null while still queued. */
  group: GroupState | null;
}

/** A `fetch()` result whose underlying request can be abandoned early. */
export type CancellableBytesPromise = Promise<Uint8Array> & { cancel: () => void };

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

// A group's members all stay unresolved until its one shared fetch finishes,
// so an unbounded group trades away progressive rendering (many small nodes
// popping in as they each finish) for fewer, larger requests that all land at
// once — worse the bigger the group gets. 512 KiB caps how long the slowest
// case can block a batch of sibling nodes, while still merging the common
// case of a handful of contiguous nodes into one request (#86).
const DEFAULT_MAX_GROUP_BYTES = 512 * 1024;

/**
 * Batches concurrent byte-range requests for one COPC file into fewer HTTP
 * Range Requests, merging ones within `gapBytes` of each other into a single
 * fetch and slicing the response back apart.
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
  private readonly inFlight = new Set<AbortController>();
  private destroyed = false;

  constructor(
    private readonly url: string,
    private readonly gapBytes = 0,
    private readonly maxGroupBytes = DEFAULT_MAX_GROUP_BYTES,
  ) {}

  /** Resolves with the raw bytes for `[begin, end)`. */
  fetch(begin: number, end: number): CancellableBytesPromise {
    if (this.destroyed) {
      const rejected = Promise.reject(
        abortError('RangeFetcher: fetch() called after destroy()'),
      ) as CancellableBytesPromise;
      rejected.cancel = () => {};
      return rejected;
    }
    let req!: RangeRequest;
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      req = { begin, end, resolve, reject, cancelled: false, group: null };
      this.pending.push(req);
      this._scheduleFlush();
    }) as CancellableBytesPromise;
    promise.cancel = () => {
      if (req.cancelled) return;
      req.cancelled = true;
      // A request already merged into a group can't be pulled back out on its
      // own — the fetch is shared — but once every sibling in that group has
      // also been cancelled, the whole group's result is wanted by nobody, so
      // its in-flight fetch (if it's gotten that far) can be aborted instead
      // of downloading a response nothing will use.
      const group = req.group;
      if (group && --group.liveCount === 0) group.controller?.abort();
    };
    return promise;
  }

  /** Rejects anything not yet sent, and aborts any fetch already in flight. */
  destroy(): void {
    this.destroyed = true;
    for (const req of this.pending) req.reject(abortError('RangeFetcher: destroyed before its request was sent'));
    this.pending = [];
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
      else live.push(req);
    }
    for (const group of this._group(live)) {
      const state: GroupState = { liveCount: group.length, controller: null };
      for (const req of group) req.group = state;
      void this._fetchGroup(group, state);
    }
  }

  /**
   * Sorts by offset and merges requests within `gapBytes` of their neighbor,
   * unless doing so would grow the group's span past `maxGroupBytes` — a
   * request that alone exceeds the cap still gets its own group, since
   * there's no smaller fetch that would satisfy it.
   */
  private _group(requests: RangeRequest[]): RangeRequest[][] {
    const sorted = [...requests].sort((a, b) => a.begin - b.begin);
    const groups: RangeRequest[][] = [];
    for (const req of sorted) {
      const group = groups[groups.length - 1];
      const last = group?.[group.length - 1];
      const spanIfAdded = group ? req.end - group[0]!.begin : 0;
      if (last && req.begin - last.end <= this.gapBytes && spanIfAdded <= this.maxGroupBytes) {
        group.push(req);
      } else {
        groups.push([req]);
      }
    }
    return groups;
  }

  private async _fetchGroup(group: RangeRequest[], state: GroupState): Promise<void> {
    const groupBegin = group[0]!.begin;
    const groupEnd = group[group.length - 1]!.end;
    const controller = new AbortController();
    state.controller = controller;
    this.inFlight.add(controller);
    try {
      const response = await fetch(this.url, {
        headers: { Range: `bytes=${groupBegin}-${groupEnd - 1}` },
        signal: controller.signal,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      for (const req of group) {
        if (req.cancelled) {
          req.reject(abortError('RangeFetcher: request cancelled before its result was needed'));
        } else {
          // A copy, not a view — each member is handed off independently
          // (e.g. transferred to a worker), which a shared buffer can't be.
          req.resolve(bytes.slice(req.begin - groupBegin, req.end - groupBegin));
        }
      }
    } catch (err) {
      const error = err as Error;
      for (const req of group) req.reject(error);
    } finally {
      this.inFlight.delete(controller);
    }
  }
}
