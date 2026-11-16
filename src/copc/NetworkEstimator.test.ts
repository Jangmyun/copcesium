/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { NetworkEstimator, OverlapClock } from './NetworkEstimator';

const KiB = 1024;

describe('NetworkEstimator', () => {
  it('returns the fallback gap until it has enough samples', () => {
    const est = new NetworkEstimator();
    for (let i = 0; i < 3; i++) est.record({ ttfbMs: 100, bodyMs: 100, bytes: 256 * KiB });
    expect(est.ready).toBe(false);
    expect(est.gapBytes(0, 1e9, 7)).toBe(7);
  });

  it('sizes the gap as time to first byte times the per-response rate', () => {
    const est = new NetworkEstimator();
    // 150 ms to first byte, 500 B/ms per response: e.g. 20 Mbps shared by five fetches.
    for (let i = 0; i < 4; i++) est.record({ ttfbMs: 150, bodyMs: 200, bytes: 100_000 });
    expect(est.ready).toBe(true);
    expect(est.gapBytes(0, 1e9, 0)).toBe(75_000);
  });

  it('clamps the gap to the given bounds', () => {
    const est = new NetworkEstimator();
    for (let i = 0; i < 4; i++) est.record({ ttfbMs: 1000, bodyMs: 10, bytes: 1_000_000 });
    expect(est.gapBytes(0, 256 * KiB, 0)).toBe(256 * KiB);
    const slow = new NetworkEstimator();
    for (let i = 0; i < 4; i++) slow.record({ ttfbMs: 1, bodyMs: 1000, bytes: 20 * KiB });
    expect(slow.gapBytes(4 * KiB, 256 * KiB, 0)).toBe(4 * KiB);
  });

  it('ignores one slow outlier, such as a response that opened a new connection', () => {
    const est = new NetworkEstimator();
    est.record({ ttfbMs: 900, bodyMs: 200, bytes: 100_000 });
    for (let i = 0; i < 4; i++) est.record({ ttfbMs: 150, bodyMs: 200, bytes: 100_000 });
    expect(est.ttfbMs).toBe(150);
  });

  it('does not take a rate from bodies too small or too fast to time', () => {
    const est = new NetworkEstimator();
    for (let i = 0; i < 8; i++) est.record({ ttfbMs: 100, bodyMs: 0.5, bytes: 4 * KiB });
    expect(est.ready).toBe(false);
    expect(Number.isNaN(est.bytesPerMs)).toBe(true);
    expect(est.ttfbMs).toBe(100);
  });

  it('follows a link that changes, once the old samples leave the window', () => {
    const est = new NetworkEstimator();
    for (let i = 0; i < 16; i++) est.record({ ttfbMs: 40, bodyMs: 100, bytes: 100_000 });
    for (let i = 0; i < 16; i++) est.record({ ttfbMs: 200, bodyMs: 100, bytes: 100_000 });
    expect(est.ttfbMs).toBe(200);
  });

  it('recovers the link rate from responses that shared it, and splits it across the slots', () => {
    // The E5 p20 case: each response read 1,000 B/ms while 2.5 bodies were
    // downloading on average, on a 2,500 B/ms link shared by five slots.
    const est = new NetworkEstimator();
    for (let i = 0; i < 4; i++)
      est.record({ ttfbMs: 150, bodyMs: 100, bytes: 100_000, sharedWith: 2.5 });
    expect(est.bytesPerMs).toBe(2500);
    expect(est.gapBytes(0, 1e9, 0, 5)).toBe(75_000);
  });

  it('treats a missing or nonsensical sharedWith as a response that had the link alone', () => {
    const est = new NetworkEstimator();
    est.record({ ttfbMs: 100, bodyMs: 100, bytes: 100_000 });
    est.record({ ttfbMs: 100, bodyMs: 100, bytes: 100_000, sharedWith: 0 });
    est.record({ ttfbMs: 100, bodyMs: 100, bytes: 100_000, sharedWith: NaN });
    expect(est.bytesPerMs).toBe(1000);
  });

  it('takes the fixed cost from the lower quartile, not the queue-inflated median', () => {
    const est = new NetworkEstimator();
    for (const ttfbMs of [150, 150, 150, 220, 230, 240, 250, 260, 270]) {
      est.record({ ttfbMs, bodyMs: 100, bytes: 100_000 });
    }
    expect(est.ttfbMs).toBe(150);
  });
});

describe('OverlapClock', () => {
  it('measures how many bodies a response shared the link with', () => {
    const clock = new OverlapClock();
    // A: 0–100 ms. B: 50–150 ms. C: 60–70 ms.
    const a = clock.start(0);
    const b = clock.start(50);
    const c = clock.start(60);
    expect(clock.end(70, c) / 10).toBe(3); // C ran only while all three did
    expect(clock.end(100, a) / 100).toBeCloseTo(1.6); // 50 ms alone, 10 ms with two others, 40 ms with B
    expect(clock.end(150, b) / 100).toBeCloseTo(1.6); // 10 ms ×3, 40 ms ×2, 50 ms alone
  });

  it('starts from zero again after an idle stretch', () => {
    const clock = new OverlapClock();
    clock.end(10, clock.start(0));
    const mark = clock.start(1000);
    expect(clock.end(1100, mark)).toBe(100);
  });
});
