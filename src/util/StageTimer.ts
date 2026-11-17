/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Per-stage (fetch / decode / upload) latency samples behind `CopcDataSource.stats`.
 * Each recorded stage also emits a `performance.measure`, so the same
 * breakdown shows up on DevTools' Performance timeline.
 */
import type { StageTiming } from '../types';
import { percentile, pushSample } from './rollingSamples';

export type StageName = 'fetch' | 'decode' | 'upload';

/** How many recent nodes each stage's percentiles are computed over. Bounded
 *  so a long session doesn't accumulate one sample per node forever; large
 *  enough that a single slow node can't drag the median. */
export const STAGE_SAMPLE_WINDOW = 256;

export class StageTimer {
  /** Bounded rolling samples per pipeline stage; see `timing`. */
  private readonly _samples: Record<StageName, number[]> = { fetch: [], decode: [], upload: [] };
  /** Monotonic completion counts. Kept apart from `_samples` because that
   *  window is capped at `STAGE_SAMPLE_WINDOW` for the percentiles' sake, and
   *  reading its length back as a total silently pins every long session at
   *  that cap (#194). */
  private readonly _counts: Record<StageName, number> = { fetch: 0, decode: 0, upload: 0 };
  /** Emitted `performance.measure` entries since the last clear; see `record`. */
  private readonly _measureCount: Record<StageName, number> = { fetch: 0, decode: 0, upload: 0 };

  /** Records one stage's elapsed time, and emits a `performance.measure` so
   *  the same breakdown appears on DevTools' Performance timeline without the
   *  caller wiring anything up. Measured from timestamps rather than paired
   *  marks, so there are no marks left to clean up. */
  record(stage: StageName, startedAt: number, endedAt = performance.now()): void {
    const end = endedAt;
    this._counts[stage]++;
    const samples = this._samples[stage];
    pushSample(samples, end - startedAt, STAGE_SAMPLE_WINDOW);

    const name = `copcesium ${stage}`;
    try {
      performance.measure(name, { start: startedAt, end });
      // The User Timing buffer has no default cap, so three entries per node
      // would accumulate for the page's lifetime — tens of MB over a long
      // session on a large dataset, never reclaimed. Dropping our own
      // measures periodically bounds that. A DevTools *recording* still
      // captures them as they happen; only post-hoc `getEntriesByType()`
      // sees just the recent window, which is what `stats` is for anyway.
      if (++this._measureCount[stage] >= STAGE_SAMPLE_WINDOW) {
        this._measureCount[stage] = 0;
        performance.clearMeasures(name);
      }
    } catch {
      // User Timing is unavailable in some embedders; the samples above
      // remain the source of truth for `stats`.
    }
  }

  timing(stage: StageName): StageTiming {
    const samples = this._samples[stage];
    return { count: this._counts[stage], p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
  }
}
