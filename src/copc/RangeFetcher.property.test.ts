/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Property checks for RangeFetcher across its option combinations: random
 * batches of overlapping, adjacent and gapped ranges, skipped tails, groups
 * near the 4 MiB adaptive cap, and cancellations at every stage. Seeded, so a
 * failure names a case that replays exactly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangeFetcher, type AdaptiveGapOptions } from './RangeFetcher';
import { TransferCounter } from './TransferCounter';

const KiB = 1024;
const MiB = 1024 * KiB;
const SOURCE_BYTES = 12 * MiB;
const SOURCE = new Uint8Array(SOURCE_BYTES);
// A period that no power-of-two offset error lines up with.
for (let i = 0; i < SOURCE_BYTES; i++) SOURCE[i] = i % 251;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Asked {
  begin: number;
  end: number;
  slackEnd: number;
  cancel: 'no' | 'before-flush' | 'after-dispatch';
}

/** One random batch: mostly a contiguous run of node-sized ranges with some
 *  gaps, overlaps, duplicates, empty ranges and near-4 MiB ranges mixed in. */
function randomBatch(rand: () => number): Asked[] {
  const asked: Asked[] = [];
  let at = Math.floor(rand() * 2 * MiB);
  const n = 1 + Math.floor(rand() * 40);
  for (let i = 0; i < n; i++) {
    const kind = rand();
    let begin: number;
    let length: number;
    if (kind < 0.05 && asked.length) {
      // Duplicate of an earlier range.
      const prev = asked[Math.floor(rand() * asked.length)]!;
      begin = prev.begin;
      length = prev.end - prev.begin;
    } else if (kind < 0.12 && asked.length) {
      // Overlapping an earlier range.
      const prev = asked[Math.floor(rand() * asked.length)]!;
      begin = prev.begin + Math.floor(rand() * Math.max(1, prev.end - prev.begin));
      length = 1 + Math.floor(rand() * 64 * KiB);
    } else {
      // Adjacent (a third of the time) or after a gap of up to 300 KiB.
      begin = at + (rand() < 0.33 ? 0 : Math.floor(rand() * 300 * KiB));
      length =
        kind < 0.15
          ? 0
          : kind < 0.2
            ? 4 * MiB - Math.floor(rand() * 64 * KiB)
            : 1 + Math.floor(rand() * 400 * KiB);
    }
    begin = Math.min(begin, SOURCE_BYTES - 1);
    const end = Math.min(begin + length, SOURCE_BYTES);
    // A skipped tail of 0 to 96 KiB on about half the ranges.
    const slackEnd =
      rand() < 0.5 ? Math.min(SOURCE_BYTES, end + Math.floor(rand() * 96 * KiB)) : end;
    const c = rand();
    asked.push({
      begin,
      end,
      slackEnd,
      cancel: c < 0.1 ? 'before-flush' : c < 0.2 ? 'after-dispatch' : 'no',
    });
    at = Math.max(at, end);
  }
  return asked;
}

interface Config {
  name: string;
  gapBytes: number;
  maxConcurrent: number;
  adaptive?: AdaptiveGapOptions;
  tailGapBytes: number;
}

const CONFIGS: Config[] = [];
for (const maxConcurrent of [1, 3, 6]) {
  for (const adaptive of [false, true]) {
    for (const tailGapBytes of [0, 64 * KiB]) {
      CONFIGS.push({
        name: `concurrent ${maxConcurrent}, ${adaptive ? 'adaptive' : 'fixed gap 0'}, tail ${tailGapBytes / KiB} KiB`,
        gapBytes: 0,
        maxConcurrent,
        adaptive: adaptive ? {} : undefined,
        tailGapBytes,
      });
    }
  }
}

/** Serves Range requests out of SOURCE on a fake clock: every response takes
 *  50 ms to its headers and 1 ms per 2 KB of body, and settles a macrotask
 *  later so dispatch, queueing and cancellation interleave as they would. */
function fakeServer() {
  let t = 0;
  const served: { begin: number; end: number }[] = [];
  const fetchMock = vi.fn(
    async (_url: string, init: { headers: { Range: string }; signal: AbortSignal }) => {
      const [, from, to] = init.headers.Range.match(/^bytes=(\d+)-(\d+)$/)!;
      const begin = Number(from);
      const end = Number(to) + 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
      t += 50;
      if (!(end > begin) || end > SOURCE_BYTES)
        return { status: 416, arrayBuffer: async () => new ArrayBuffer(0) };
      served.push({ begin, end });
      return {
        status: 206,
        arrayBuffer: async () => {
          t += (end - begin) / 2000;
          return SOURCE.slice(begin, end).buffer;
        },
      };
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, served, now: () => t };
}

/** Bytes of `[begin, end)` not covered by any of `ranges`, as maximal runs. */
function uncoveredRuns(
  begin: number,
  end: number,
  ranges: { begin: number; end: number }[],
): number[] {
  const sorted = ranges
    .filter((r) => r.end > begin && r.begin < end)
    .sort((a, b) => a.begin - b.begin);
  const runs: number[] = [];
  let at = begin;
  for (const r of sorted) {
    if (r.begin > at) runs.push(r.begin - at);
    at = Math.max(at, r.end);
  }
  if (end > at) runs.push(end - at);
  return runs;
}

describe('RangeFetcher properties', () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const config of CONFIGS) {
    it(`delivers exact bytes, bounded spans and consistent counts (${config.name})`, async () => {
      const rand = lcg(0x5eed + CONFIGS.indexOf(config));
      for (let round = 0; round < 12; round++) {
        const { fetchMock, served, now } = fakeServer();
        const counter = new TransferCounter();
        const fetcher = new RangeFetcher(
          'https://example.com/f.copc.laz',
          config.gapBytes,
          undefined,
          config.maxConcurrent,
          counter,
          config.adaptive ? { ...config.adaptive, now } : undefined,
          config.tailGapBytes,
        );
        const asked = randomBatch(rand);
        const promises = asked.map((a) => fetcher.fetch(a.begin, a.end, a.slackEnd));
        for (let i = 0; i < asked.length; i++)
          if (asked[i]!.cancel === 'before-flush') promises[i]!.cancel();
        await Promise.resolve(); // the flush
        for (let i = 0; i < asked.length; i++)
          if (asked[i]!.cancel === 'after-dispatch') promises[i]!.cancel();
        const settled = await Promise.allSettled(promises);
        const label = `${config.name}, round ${round}`;

        // (a) Every request that wasn't cancelled gets exactly its own bytes.
        //     A cancelled one is rejected as an abort, never handed data.
        settled.forEach((s, i) => {
          const a = asked[i]!;
          // An empty range resolves at the flush, so cancelling it afterwards
          // is a no-op on an already-settled promise.
          const settledBeforeCancel = a.cancel === 'after-dispatch' && a.end === a.begin;
          if (a.cancel === 'no' || settledBeforeCancel) {
            expect(
              s.status,
              `${label}: request ${i} [${a.begin}, ${a.end}) failed: ${(s as PromiseRejectedResult).reason}`,
            ).toBe('fulfilled');
            const bytes = (s as PromiseFulfilledResult<Uint8Array>).value;
            expect(bytes.length, `${label}: request ${i} length`).toBe(a.end - a.begin);
            expect(
              Buffer.compare(Buffer.from(bytes), Buffer.from(SOURCE.subarray(a.begin, a.end))),
              `${label}: request ${i} bytes`,
            ).toBe(0);
          } else {
            expect(s.status, `${label}: cancelled request ${i}`).toBe('rejected');
            expect(((s as PromiseRejectedResult).reason as Error).name).toBe('AbortError');
          }
        });

        // (b) Every fetched span is bounded: no wider than the group cap
        //     (unless one request alone is), and any bytes inside it that no
        //     request asked for are gaps the active rule allows.
        const groupCap = config.adaptive ? 4 * MiB : 512 * KiB;
        const gapCap = config.adaptive ? 256 * KiB : config.gapBytes;
        const allowedRun = Math.max(gapCap, config.tailGapBytes);
        for (const span of served) {
          const inside = asked.filter((a) => a.begin >= span.begin && a.end <= span.end);
          const widest = Math.max(0, ...inside.map((a) => a.end - a.begin));
          expect(
            span.end - span.begin,
            `${label}: span [${span.begin}, ${span.end}) exceeds the cap`,
          ).toBeLessThanOrEqual(Math.max(groupCap, widest));
          for (const run of uncoveredRuns(span.begin, span.end, inside)) {
            expect(
              run,
              `${label}: span [${span.begin}, ${span.end}) bridges ${run} bytes`,
            ).toBeLessThanOrEqual(allowedRun);
          }
        }

        // (c) The counter matches what crossed the wire: one record per
        //     response actually read, with its length.
        expect(counter.requestCount, `${label}: requestCount`).toBe(served.length);
        expect(counter.transferredBytes, `${label}: transferredBytes`).toBe(
          served.reduce((sum, s) => sum + (s.end - s.begin), 0),
        );
        // No fetch for a batch where everything was cancelled before the flush.
        if (asked.every((a) => a.cancel === 'before-flush'))
          expect(fetchMock).not.toHaveBeenCalled();
      }
    });
  }
});
