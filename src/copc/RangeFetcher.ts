interface RangeRequest {
  begin: number;
  end: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  cancelled: boolean;
}

/** A `fetch()` result whose underlying request can be abandoned early. */
export type CancellableBytesPromise = Promise<Uint8Array> & { cancel: () => void };

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

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
      req = { begin, end, resolve, reject, cancelled: false };
      this.pending.push(req);
      this._scheduleFlush();
    }) as CancellableBytesPromise;
    // A request already merged into an in-flight group fetch can't be pulled
    // back out — the network request keeps going for whichever siblings are
    // still wanted — so cancelling only suppresses this one's own result.
    promise.cancel = () => {
      req.cancelled = true;
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
    for (const group of this._group(live)) void this._fetchGroup(group);
  }

  /** Sorts by offset and merges requests within `gapBytes` of their neighbor. */
  private _group(requests: RangeRequest[]): RangeRequest[][] {
    const sorted = [...requests].sort((a, b) => a.begin - b.begin);
    const groups: RangeRequest[][] = [];
    for (const req of sorted) {
      const group = groups[groups.length - 1];
      const last = group?.[group.length - 1];
      if (last && req.begin - last.end <= this.gapBytes) {
        group.push(req);
      } else {
        groups.push([req]);
      }
    }
    return groups;
  }

  private async _fetchGroup(group: RangeRequest[]): Promise<void> {
    const groupBegin = group[0]!.begin;
    const groupEnd = group[group.length - 1]!.end;
    const controller = new AbortController();
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
