/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Running estimate of what one more Range Request costs on the current link,
 * so `RangeFetcher` can decide how large a gap between two ranges is worth
 * downloading just to save a request.
 *
 * Merging two ranges across a gap of `g` bytes saves one request's fixed cost
 * (the time to first byte: a round trip plus server think time) and costs the
 * time to move `g` extra bytes through the slot that fetch occupies. With
 * `concurrency` fetches sharing one bottleneck, a busy slot gets roughly
 * `bandwidth / concurrency`, so the break-even gap is
 * `ttfb × bandwidth ÷ concurrency`.
 *
 * The bandwidth is not a single response's body rate: slots are often not all
 * busy, and a response that had the link to itself reads as several times the
 * per-slot share (E5 measured 0.67–1.14 MB/s per response on a 2.5 MB/s link
 * shared by five, and overshot the gap 1.5–2.7×). Instead each response's rate
 * is multiplied by how many bodies were downloading alongside it on average
 * (`sharedWith`, itself included), which under fair sharing recovers the
 * whole link's rate whatever the occupancy was.
 *
 * Both inputs are robust statistics over a short window rather than moving
 * averages: a response that opened a fresh connection (TLS handshake, TCP
 * slow start) or waited in the browser's own per-host queue is an outlier, not
 * a trend. The fixed cost takes the lower quartile rather than the median,
 * because a request sent while the link is busy also waits behind other
 * responses' bytes in the bottleneck queue, and merging does not save that.
 */

/** One completed response. Times are milliseconds. */
export interface NetworkSample {
  /** From `fetch()` being called to its response headers arriving. */
  ttfbMs: number;
  /** From the headers arriving to the body being fully read. */
  bodyMs: number;
  bytes: number;
  /** Mean number of bodies downloading during this one's body, itself
   *  included (see `OverlapClock`). Default `1`. */
  sharedWith?: number;
}

// Large enough to ride out a burst of fresh connections after a pause, small
// enough to follow a link that changes underneath a session (Wi-Fi to LTE).
const WINDOW = 16;

// Before this many samples, a single slow first response (connection setup,
// cold CDN edge) would set the gap for the whole first view.
const MIN_SAMPLES = 4;

// Body times below a few milliseconds are dominated by timer resolution and
// event-loop scheduling, not by the link, and would read as absurd rates.
// 16 KiB is smaller than almost any COPC chunk, so the window still fills.
const MIN_RATE_BYTES = 16 * 1024;
const MIN_RATE_MS = 2;

function quantile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/**
 * Time-integral of how many response bodies are downloading at once, so a
 * response can learn how many others it shared the link with. `start()` when
 * a response's headers arrive, `end()` with the returned mark when its body
 * has been read (or abandoned); the difference divided by the body time is
 * the mean number of bodies in flight, the caller's own included.
 */
export class OverlapClock {
  private active = 0;
  private area = 0;
  private last = 0;

  start(now: number): number {
    this.advance(now);
    this.active++;
    return this.area;
  }

  /** Body-milliseconds accumulated across all bodies since `mark`. */
  end(now: number, mark: number): number {
    this.advance(now);
    this.active = Math.max(0, this.active - 1);
    return this.area - mark;
  }

  private advance(now: number): void {
    if (this.active > 0) this.area += this.active * (now - this.last);
    this.last = now;
  }
}

export class NetworkEstimator {
  private readonly ttfb: number[] = [];
  private readonly rate: number[] = [];

  record(sample: NetworkSample): void {
    if (!(sample.ttfbMs >= 0)) return;
    push(this.ttfb, sample.ttfbMs);
    if (sample.bytes >= MIN_RATE_BYTES && sample.bodyMs >= MIN_RATE_MS) {
      const shared =
        sample.sharedWith !== undefined && sample.sharedWith >= 1 ? sample.sharedWith : 1;
      push(this.rate, (sample.bytes / sample.bodyMs) * shared);
    }
  }

  /** True once both the fixed cost and the rate have enough samples. */
  get ready(): boolean {
    return this.ttfb.length >= MIN_SAMPLES && this.rate.length >= MIN_SAMPLES;
  }

  /** Lower-quartile time to first byte, ms. NaN until the first sample. */
  get ttfbMs(): number {
    return this.ttfb.length ? quantile(this.ttfb, 0.25) : NaN;
  }

  /** Median estimate of the whole link's rate, bytes per ms. NaN until the
   *  first usable sample. */
  get bytesPerMs(): number {
    return this.rate.length ? quantile(this.rate, 0.5) : NaN;
  }

  /**
   * Break-even merge gap in bytes for `concurrency` fetches sharing the link,
   * clamped to `[min, max]`; `fallback` until `ready`.
   */
  gapBytes(min: number, max: number, fallback: number, concurrency = 1): number {
    if (!this.ready) return fallback;
    const gap = Math.round((this.ttfbMs * this.bytesPerMs) / Math.max(1, concurrency));
    return Math.min(max, Math.max(min, gap));
  }
}

function push(window: number[], value: number): void {
  window.push(value);
  if (window.length > WINDOW) window.shift();
}
