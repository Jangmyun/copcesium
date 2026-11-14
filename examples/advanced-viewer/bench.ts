/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import * as Cesium from 'cesium';
import type { CopcDataSource } from 'copcesium';
import { escapeHtml } from './html';

/**
 * The shape this harness needs, declared locally rather than imported.
 *
 * This example installs `copcesium` from the registry, so it type-checks
 * against whatever version is published — and `stats` only exists from the
 * release that introduced it. Depending on the imported type would make the
 * example uncompilable until then; describing just the members used here
 * keeps it building against any version and fails loudly at runtime instead.
 */
interface StatsCapable {
  stats: {
    fileBytes: number;
    requestCount: number;
    transferredBytes: number;
    pendingNodes: number;
    fetch: { count: number; p50: number; p95: number };
    decode: { count: number; p50: number; p95: number };
    upload: { count: number; p50: number; p95: number };
  };
}

/**
 * Tuning options the viewer accepts from the URL query, e.g.
 * `?concurrency=12&maxCacheNodes=400`.
 *
 * These have no UI because they are not things an end user tunes; they exist
 * so a sweep can vary one of them across runs without an edit and a dev-server
 * restart, which is what made comparing configurations impractical before
 * (#194). `sseThreshold` is deliberately absent — it already has a slider, and
 * two sources for one value would fight.
 */
const TUNING_PARAMS = [
  'concurrency',
  'maxConcurrentRequests',
  'maxCacheNodes',
  'maxCacheBytes',
  'maxVisibleNodes',
  'maxPoints',
  'debounceMs',
  'lodHysteresis',
  'prefetchFrustumFactor',
  'prefetchIdleOnly',
  'adaptiveMergeGap',
  'decodeBackpressure',
  'strictCacheBudget',
] as const;

export function tuningOptions(): Record<string, number> {
  const params = new URLSearchParams(window.location.search);
  const out: Record<string, number> = {};
  for (const key of TUNING_PARAMS) {
    const raw = params.get(key);
    if (raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) out[key] = value;
    else console.warn(`[bench] ignoring ?${key}=${raw} — not a number`);
  }
  return out;
}

function asStatsCapable(ds: CopcDataSource): StatsCapable | null {
  const candidate = ds as unknown as Partial<StatsCapable>;
  return candidate.stats && typeof candidate.stats.pendingNodes === 'number'
    ? (candidate as StatsCapable)
    : null;
}

/**
 * The loader state the visible-node metrics read, reached privately for the
 * same reason as `_getSphere` below. `stats.pendingNodes` also counts
 * off-screen prefetch loads, so it can't say when the *view* finished (#212).
 */
interface LoadInternals {
  _selectedKeys: Set<string>;
  _pendingKeys: Set<string>;
  _nodeCache: { peek(key: string): unknown };
  _copc: { info: { cube: number[] }; header: { max: number[] } };
  _options: { zFactor?: number };
}

/**
 * The root sphere moved down to the top of the data.
 *
 * The root sphere is centred on the octree's cube, and the cube is as tall as
 * the dataset is wide, so on flat terrain that centre floats hundreds of metres
 * up in the air. A view framed on it never gets close enough to the points for
 * a sideways pan to need new nodes.
 */
function dataTopSphere(root: Cesium.BoundingSphere, internals: LoadInternals): Cesium.BoundingSphere {
  const { info, header } = internals._copc;
  const drop = ((info.cube[2]! + info.cube[5]!) / 2 - header.max[2]!) * (internals._options.zFactor ?? 1);
  const up = Cesium.Cartesian3.normalize(root.center, new Cesium.Cartesian3());
  const center = Cesium.Cartesian3.subtract(
    root.center,
    Cesium.Cartesian3.multiplyByScalar(up, drop, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  return new Cesium.BoundingSphere(center, root.radius);
}

/** Selected nodes still in flight: what the camera wants but can't show yet. */
function visiblePending(internals: LoadInternals): number {
  let count = 0;
  for (const key of internals._selectedKeys) {
    if (internals._pendingKeys.has(key)) count++;
  }
  return count;
}

/**
 * A fixed camera walk, for measuring instead of guessing.
 *
 * Hand-flying the camera produces a different number every run, so a
 * before/after comparison of an optimization says nothing. This drives a
 * deterministic path and reports `dataSource.stats` at each stop.
 *
 * Waypoints are expressed as `HeadingPitchRange` offsets from the dataset's
 * own bounding sphere, not absolute coordinates, so the same walk is
 * comparable across datasets of wildly different extent — Autzen at ~81 MB
 * and Montréal at ~51.9 GB fly the same relative route.
 *
 * Run it by appending `?bench` to the viewer URL. Results land in the console
 * and on `window.__copcesiumBench` for scripted collection.
 */

/** Fraction of the root sphere's radius to sit back at, per stop. */
interface Waypoint {
  label: string;
  headingDeg: number;
  pitchDeg: number;
  /** Multiplier on the root bounding sphere radius. */
  rangeFactor: number;
}

const WAYPOINTS: Waypoint[] = [
  { label: 'overview', headingDeg: 0, pitchDeg: -60, rangeFactor: 2.5 },
  { label: 'approach', headingDeg: 0, pitchDeg: -45, rangeFactor: 0.8 },
  { label: 'close', headingDeg: 0, pitchDeg: -30, rangeFactor: 0.25 },
  { label: 'orbit-90', headingDeg: 90, pitchDeg: -30, rangeFactor: 0.25 },
  { label: 'orbit-180', headingDeg: 180, pitchDeg: -30, rangeFactor: 0.25 },
  { label: 'pull-back', headingDeg: 180, pitchDeg: -60, rangeFactor: 2.5 },
];

/**
 * Seconds per halving (or doubling) of viewing distance, plus a floor.
 *
 * A single fixed duration was the wrong call: the walk drops from 2.5x the
 * dataset radius to 0.25x, so a flat 2s made that leg an order of magnitude
 * faster than the ones either side of it. The camera outran the loader and
 * the descent showed holes where nodes for the new view hadn't arrived — not
 * a rendering bug, just a camera moving faster than any real user would drag
 * it, which is also not the thing worth measuring.
 *
 * Scaling by log2 of the range ratio keeps apparent speed constant instead:
 * every halving of distance gets the same time to stream in.
 */
const SECONDS_PER_OCTAVE = 1.4;
const MIN_FLIGHT_SECONDS = 1.5;

function flightSeconds(fromFactor: number, toFactor: number): number {
  const octaves = Math.abs(Math.log2(toFactor / fromFactor));
  return Math.max(MIN_FLIGHT_SECONDS, octaves * SECONDS_PER_OCTAVE);
}

/**
 * The `?route=pan` sweep: stops at `PAN_START`, then drags sideways in bursts.
 *
 * The walk waits for every stop to settle, so it can't show what prefetching
 * is for — content already being there when a pan reveals it. Bursts with
 * pauses are how a mouse drag actually moves, and the pauses are the only time
 * spare worker capacity exists to prefetch with.
 */
const PAN_BURSTS = 6;
const PAN_BURST_SECONDS = 1;
const PAN_PAUSE_SECONDS = 1;
/** Sideways speed during a burst, as a fraction of the root sphere's radius.
 *  Six bursts cover 0.36 radii: about two screen widths from `PAN_START`, and
 *  short of the edge of the data, where the selection would only shrink. */
const PAN_RADII_PER_SECOND = 0.06;
/** Framed on `dataTopSphere`, because from `close` the coarse nodes already
 *  selected span the whole sweep. */
const PAN_START: Waypoint = { label: 'pan-start', headingDeg: 0, pitchDeg: -45, rangeFactor: 0.1 };
const PAN_APPROACH_STOPS = 3;
/** How long `pendingNodes` must stay at 0 before a view counts as settled. A
 *  single zero reading isn't enough: the LoD pass runs on a `debounceMs`
 *  timer, so there's a gap between one batch draining and the next starting. */
const SETTLE_MS = 600;
/** Gives up on a stop that never settles (a dead range server, say) instead of
 *  hanging the whole run. */
const CONVERGE_TIMEOUT_MS = 60_000;

export interface StopResult {
  label: string;
  /** Wall time from arrival at the waypoint to a settled view. Includes the
   *  fixed `SETTLE_MS` quiet period, which is roughly half of a typical stop —
   *  use `loadMs` to compare configurations. */
  convergeMs: number;
  /** `convergeMs` minus the settle window: time actually spent loading. The
   *  constant is the same every stop, so leaving it in dilutes whatever
   *  difference a configuration change makes by about half (#194). */
  loadMs: number;
  /** Arrival until the last selected node finished loading, ignoring
   *  off-screen prefetch traffic. 0 when everything was already there. */
  visibleLoadMs: number;
  /** Bytes, requests, and decoded nodes this stop alone added. */
  bytesDelta: number;
  requestsDelta: number;
  nodesDelta: number;
  /** `bytesDelta / convergeMs`. The only throughput figure here that is
   *  genuinely scoped to this stop — see the `session*` fields below. */
  bytesPerSec: number;
  /** Totals as of this stop. */
  transferredBytes: number;
  requestCount: number;
  /**
   * Percentiles as of this stop, over the data source's rolling window —
   * **not** over this stop alone. A stop that transfers nothing still reports
   * whatever the window held on arrival, so consecutive stops often repeat a
   * value. Named for that scope rather than left looking per-stop (#194); use
   * `bytesPerSec` and `nodesDelta` for per-stop cost.
   */
  sessionFetchP50: number;
  sessionFetchP95: number;
  sessionDecodeP50: number;
  sessionDecodeP95: number;
  sessionUploadP50: number;
  sessionUploadP95: number;
  /** True when the stop hit `CONVERGE_TIMEOUT_MS` instead of settling. */
  timedOut: boolean;
}

export interface PanResult {
  /** Time, from the first burst until settled, with any selected node missing. */
  gapMs: number;
  /** `gapMs` weighted by how many nodes were missing, so one late node and
   *  twenty late nodes don't read the same. */
  gapNodeMs: number;
  /** Nodes that entered the selection during the pan. */
  selectedNew: number;
  /** How many of those were already cached when selected. */
  selectedHits: number;
  bytesDelta: number;
  requestsDelta: number;
  timedOut: boolean;
}

export interface BenchResult {
  url: string;
  /** Tuning options this run resolved to, so two pasted results can be told
   *  apart. Populated from the URL query by the viewer (#194). */
  options: Record<string, number>;
  /** Sum of every stop's `convergeMs`, settle windows included. */
  totalConvergeMs: number;
  /** Sum of every stop's `loadMs` — the headline for comparing two
   *  configurations over the same walk. */
  totalLoadMs: number;
  /** Sum of every stop's `visibleLoadMs` — what a viewer waits for. */
  totalVisibleLoadMs: number;
  /** Only on `?route=pan`, measured after the stops. */
  pan: PanResult | null;
  fileBytes: number;
  transferredBytes: number;
  requestCount: number;
  /** The headline: what fraction of the file had to cross the wire. */
  transferredFraction: number;
  stops: StopResult[];
}

/**
 * The Benchmark tab.
 *
 * Two ways to measure, because they answer different questions.
 *
 * **Live** — just fly the camera yourself and watch the numbers. Every run
 * differs, so this can't show that an optimization helped, but for "what did
 * this session actually cost" it's the more honest measurement: it's a real
 * viewing session rather than a synthetic path.
 *
 * **Fixed walk** — a scripted six-stop route. Reproducible, so two builds can
 * be compared. Waypoints are offsets from the dataset's own bounding sphere,
 * making the same walk meaningful for an 81 MB file and a 51.9 GB one alike.
 */
class BenchPanel {
  private readonly body: HTMLElement;
  private readonly live: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly results: HTMLDivElement;

  constructor() {
    this.body = document.getElementById('benchBody') ?? document.body;
    this.live = document.createElement('div');
    this.status = document.createElement('div');
    this.status.style.cssText = 'color:var(--accent);font-weight:600;font-size:12.5px;margin-top:12px';
    this.results = document.createElement('div');
    this.body.replaceChildren(this.live, this.status, this.results);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  clearResults(): void {
    this.results.replaceChildren();
  }

  /**
   * The always-on readout.
   *
   * Split into totals and a live rate because they answer different things:
   * the totals are what the session has cost so far, the rate is what it's
   * costing right now. A single cumulative number can't tell a finished load
   * from one still streaming hard.
   */
  renderLive(stats: StatsCapable['stats'] | null, bytesPerSec: number): void {
    if (!stats) {
      this.live.innerHTML = `<div style="color:var(--dim);font-size:12px">Load a dataset to measure.</div>`;
      return;
    }
    const pct =
      stats.fileBytes > 0 ? `${((stats.transferredBytes / stats.fileBytes) * 100).toFixed(3)}%` : 'unknown';

    this.live.innerHTML =
      `<div class="sec-label" style="margin-bottom:8px">session total</div>` +
      statBlock('file', stats.fileBytes > 0 ? formatSize(stats.fileBytes) : 'unknown') +
      statBlock('transferred', formatSize(stats.transferredBytes), true) +
      statBlock('of file', pct, true) +
      statBlock('requests', String(stats.requestCount)) +
      statBlock('nodes decoded', String(stats.decode.count)) +
      statBlock('nodes on GPU', String(stats.upload.count)) +
      `<div class="sec-label" style="margin:14px 0 8px">right now</div>` +
      statBlock('in flight', `${stats.pendingNodes} node${stats.pendingNodes === 1 ? '' : 's'}`) +
      statBlock('transfer rate', bytesPerSec > 0 ? `${formatSize(bytesPerSec)}/s` : 'idle') +
      `<div class="sec-label" style="margin:14px 0 6px">per-node latency</div>` +
      `<div style="font-size:10.5px;color:var(--dim);margin-bottom:6px;line-height:1.5">` +
      `p50 = half the nodes were faster than this. p95 = all but the slowest 5% were.<br>` +
      `Over the last ${Math.min(256, stats.decode.count)} node(s).</div>` +
      `<table style="width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:10.5px">` +
      `<tr style="color:var(--dim);text-align:left">` +
      ['stage', 'p50', 'p95', 'n'].map((h) => `<th style="padding:0 6px 4px 0;font-weight:500">${h}</th>`).join('') +
      `</tr>` +
      (['fetch', 'decode', 'upload'] as const)
        .map((k) => {
          const t = stats[k];
          const cells =
            t.count === 0
              ? ['—', '—', '0']
              : [`${Math.round(t.p50)} ms`, `${Math.round(t.p95)} ms`, String(t.count)];
          return (
            `<tr style="border-top:1px solid var(--border)">` +
            `<td style="padding:4px 6px 4px 0;color:var(--dim)">${k}</td>` +
            cells.map((c) => `<td style="padding:4px 6px 4px 0">${escapeHtml(c)}</td>`).join('') +
            `</tr>`
          );
        })
        .join('') +
      `</table>`;
  }

  /** Appends the fixed walk's per-stop breakdown below the live readout. */
  renderWalk(result: BenchResult): void {
    const rows = result.stops
      .map(
        (s) =>
          `<tr style="border-top:1px solid var(--border)">` +
          [
            escapeHtml(s.label) + (s.timedOut ? ' &#9888;' : ''),
            String(s.visibleLoadMs),
            String(s.loadMs),
            escapeHtml(formatSize(s.bytesDelta)),
            String(s.requestsDelta),
            String(s.nodesDelta),
            s.bytesPerSec > 0 ? escapeHtml(`${formatSize(s.bytesPerSec)}/s`) : '—',
          ]
            .map((c) => `<td style="padding:4px 6px 4px 0">${c}</td>`)
            .join('') +
          `</tr>`,
      )
      .join('');

    this.results.innerHTML =
      `<div class="sec-label" style="margin:14px 0 6px">fixed walk — per stop</div>` +
      `<table style="width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:10.5px">` +
      `<tr style="color:var(--dim);text-align:left">` +
      ['stop', 'visible ms', 'load ms', 'bytes', 'reqs', 'nodes', 'rate']
        .map((h) => `<th style="padding:0 6px 4px 0;font-weight:500">${h}</th>`)
        .join('') +
      `</tr>${rows}</table>`;

    const copy = document.createElement('button');
    copy.textContent = 'Copy JSON';
    copy.style.cssText = BUTTON_CSS;
    copy.onclick = () => {
      void navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      copy.textContent = 'Copied';
    };
    this.results.appendChild(copy);
  }
}

const BUTTON_CSS =
  'margin-top:12px;padding:6px 12px;border-radius:6px;cursor:pointer;font:inherit;font-size:11.5px;' +
  'background:var(--panel3);color:var(--text);border:1px solid var(--border2)';

function formatSize(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function statBlock(label: string, value: string, accent = false): string {
  return (
    `<div style="margin-bottom:9px">` +
    `<div style="font-size:10.5px;color:var(--dim)">${escapeHtml(label)}</div>` +
    `<div style="font-family:'IBM Plex Mono',monospace;font-size:15px;font-weight:600;` +
    `color:${accent ? 'var(--accent)' : 'inherit'}">${escapeHtml(value)}</div></div>`
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function flyTo(
  viewer: Cesium.Viewer,
  sphere: Cesium.BoundingSphere,
  wp: Waypoint,
  seconds: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    viewer.scene.camera.flyToBoundingSphere(sphere, {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(wp.headingDeg),
        Cesium.Math.toRadians(wp.pitchDeg),
        sphere.radius * wp.rangeFactor,
      ),
      duration: seconds,
      complete: () => resolve(),
    });
  });
}

/**
 * Sweeps the camera sideways in bursts from wherever it is now, sampling every
 * frame how much of the current selection is missing.
 *
 * The camera is placed from elapsed time rather than stepped per frame, so a
 * slower frame rate can't shorten the distance covered.
 */
async function runPan(
  viewer: Cesium.Viewer,
  ds: StatsCapable,
  internals: LoadInternals,
  radius: number,
): Promise<PanResult> {
  const camera = viewer.scene.camera;
  const origin = Cesium.Cartesian3.clone(camera.position);
  const direction = Cesium.Cartesian3.clone(camera.direction);
  const up = Cesium.Cartesian3.clone(camera.up);
  const right = Cesium.Cartesian3.clone(camera.right);
  const periodSeconds = PAN_BURST_SECONDS + PAN_PAUSE_SECONDS;
  const durationSeconds = PAN_BURSTS * periodSeconds - PAN_PAUSE_SECONDS;

  const movingSecondsAt = (t: number): number =>
    Math.floor(t / periodSeconds) * PAN_BURST_SECONDS + Math.min(t % periodSeconds, PAN_BURST_SECONDS);

  const bytesBefore = ds.stats.transferredBytes;
  const requestsBefore = ds.stats.requestCount;
  const seen = new Set(internals._selectedKeys);
  let gapMs = 0;
  let gapNodeMs = 0;
  let selectedNew = 0;
  let selectedHits = 0;
  let sampling = true;

  const startedAt = performance.now();
  let lastFrameAt = startedAt;
  const swept = new Promise<void>((resolve) => {
    const frame = (): void => {
      if (!sampling) return;
      const now = performance.now();
      const missing = visiblePending(internals);
      if (missing > 0) {
        gapMs += now - lastFrameAt;
        gapNodeMs += missing * (now - lastFrameAt);
      }
      lastFrameAt = now;
      for (const key of internals._selectedKeys) {
        if (seen.has(key)) continue;
        seen.add(key);
        selectedNew++;
        if (internals._nodeCache.peek(key)) selectedHits++;
      }

      const elapsedSeconds = Math.min((now - startedAt) / 1000, durationSeconds);
      const distance = movingSecondsAt(elapsedSeconds) * PAN_RADII_PER_SECOND * radius;
      camera.setView({
        destination: Cesium.Cartesian3.add(
          origin,
          Cesium.Cartesian3.multiplyByScalar(right, distance, new Cesium.Cartesian3()),
          new Cesium.Cartesian3(),
        ),
        orientation: { direction, up },
      });
      viewer.scene.requestRender();
      if (elapsedSeconds >= durationSeconds) resolve();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  await swept;
  const timedOut = await waitUntilSettled(ds);
  sampling = false;

  return {
    gapMs: Math.round(gapMs),
    gapNodeMs: Math.round(gapNodeMs),
    selectedNew,
    selectedHits,
    bytesDelta: ds.stats.transferredBytes - bytesBefore,
    requestsDelta: ds.stats.requestCount - requestsBefore,
    timedOut,
  };
}

/** Resolves once nothing has been in flight for `SETTLE_MS`, or on timeout. */
async function waitUntilSettled(ds: StatsCapable, onTick?: (pending: number) => void): Promise<boolean> {
  const deadline = performance.now() + CONVERGE_TIMEOUT_MS;
  let quietSince: number | null = null;
  for (;;) {
    onTick?.(ds.stats.pendingNodes);
    if (ds.stats.pendingNodes === 0) {
      quietSince ??= performance.now();
      if (performance.now() - quietSince >= SETTLE_MS) return false;
    } else {
      quietSince = null;
    }
    if (performance.now() > deadline) return true;
    await sleep(50);
  }
}

async function runWalk(
  viewer: Cesium.Viewer,
  dataSource: CopcDataSource,
  url: string,
  panel: BenchPanel,
): Promise<BenchResult | null> {
  const ds = asStatsCapable(dataSource);
  if (!ds) {
    console.error(
      '[bench] this copcesium build has no `stats` — the harness needs the release that added it. ' +
        'Run with `npm run dev:src` to benchmark this repo\'s src/ instead.',
    );
    return null;
  }
  // The dataset's root sphere is what every waypoint offset is relative to, and
  // it's the same one `zoomTo()` frames against — so `rangeFactor` means the
  // same thing here as it does there. Reaching for it privately is a harness
  // concession: the library has no public accessor for it, and adding one for
  // a benchmark would be the tail wagging the dog.
  const rootSphere = (dataSource as unknown as { _getSphere(key: string): Cesium.BoundingSphere })._getSphere(
    '0-0-0-0',
  );

  const internals = dataSource as unknown as LoadInternals;
  const panRoute = new URLSearchParams(window.location.search).get('route') === 'pan';
  const waypoints = panRoute ? [...WAYPOINTS.slice(0, PAN_APPROACH_STOPS), PAN_START] : WAYPOINTS;

  const stops: StopResult[] = [];
  let prevBytes = ds.stats.transferredBytes;
  let prevRequests = ds.stats.requestCount;
  let prevNodes = ds.stats.decode.count;

  let prevFactor = WAYPOINTS[0]!.rangeFactor;
  for (const [i, wp] of waypoints.entries()) {
    const seconds = flightSeconds(prevFactor, wp.rangeFactor);
    prevFactor = wp.rangeFactor;
    panel.setStatus(`Stop ${i + 1}/${waypoints.length} — ${wp.label} · flying`);
    await flyTo(viewer, wp === PAN_START ? dataTopSphere(rootSphere, internals) : rootSphere, wp, seconds);

    const startedAt = performance.now();
    // The last moment anything selected was still loading, rather than the
    // first moment nothing was: a hierarchy page landing mid-settle can add
    // selected nodes after an earlier zero reading.
    let lastVisibleAt: number | null = null;
    const timedOut = await waitUntilSettled(ds, (pending) => {
      if (visiblePending(internals) > 0) lastVisibleAt = performance.now();
      panel.setStatus(
        `Stop ${i + 1}/${waypoints.length} — ${wp.label} · ` +
          (pending > 0 ? `loading ${pending} node${pending === 1 ? '' : 's'}` : 'settling'),
      );
    });
    const convergeMs = performance.now() - startedAt;

    const s = ds.stats;
    stops.push({
      label: wp.label,
      convergeMs: Math.round(convergeMs),
      // Floor at 0: a stop with nothing to load still reports one full quiet
      // period, and a few milliseconds of loop overhead must not read as
      // negative work.
      loadMs: Math.max(0, Math.round(convergeMs - SETTLE_MS)),
      visibleLoadMs: lastVisibleAt === null ? 0 : Math.round(lastVisibleAt - startedAt),
      bytesDelta: s.transferredBytes - prevBytes,
      requestsDelta: s.requestCount - prevRequests,
      nodesDelta: s.decode.count - prevNodes,
      bytesPerSec:
        convergeMs > SETTLE_MS
          ? Math.round(((s.transferredBytes - prevBytes) * 1000) / (convergeMs - SETTLE_MS))
          : 0,
      transferredBytes: s.transferredBytes,
      requestCount: s.requestCount,
      sessionFetchP50: Math.round(s.fetch.p50),
      sessionFetchP95: Math.round(s.fetch.p95),
      sessionDecodeP50: Math.round(s.decode.p50),
      sessionDecodeP95: Math.round(s.decode.p95),
      sessionUploadP50: Math.round(s.upload.p50),
      sessionUploadP95: Math.round(s.upload.p95),
      timedOut,
    });
    prevBytes = s.transferredBytes;
    prevRequests = s.requestCount;
    prevNodes = s.decode.count;
  }

  let pan: PanResult | null = null;
  if (panRoute) {
    panel.setStatus('Panning');
    pan = await runPan(viewer, ds, internals, rootSphere.radius);
  }

  const final = ds.stats;
  const result: BenchResult = {
    url,
    options: tuningOptions(),
    totalConvergeMs: stops.reduce((sum, stop) => sum + stop.convergeMs, 0),
    totalLoadMs: stops.reduce((sum, stop) => sum + stop.loadMs, 0),
    totalVisibleLoadMs: stops.reduce((sum, stop) => sum + stop.visibleLoadMs, 0),
    pan,
    fileBytes: final.fileBytes,
    transferredBytes: final.transferredBytes,
    requestCount: final.requestCount,
    transferredFraction: final.fileBytes > 0 ? final.transferredBytes / final.fileBytes : 0,
    stops,
  };

  const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;
  console.log(
    `[bench] ${url}\n` +
      `  file            ${mb(result.fileBytes)}\n` +
      `  transferred     ${mb(result.transferredBytes)} in ${result.requestCount} requests\n` +
      `  fraction        ${(result.transferredFraction * 100).toFixed(3)}% of the file`,
  );
  console.table(stops);
  if (pan) console.log('[bench] pan', pan);
  panel.setStatus('Fixed walk complete');
  panel.renderWalk(result);
  (window as unknown as { __copcesiumBench?: BenchResult }).__copcesiumBench = result;
  return result;
}

/**
 * Wires the Benchmark tab: a live readout that ticks while the tab is open,
 * and a button that runs the fixed walk.
 *
 * `getDataSource` is a callback rather than a value because the active data
 * source is replaced whenever a different dataset is loaded.
 */
export function mountBenchTab(viewer: Cesium.Viewer, getDataSource: () => CopcDataSource | null): void {
  const panel = new BenchPanel();
  let running = false;

  const run = document.createElement('button');
  run.textContent = 'Run fixed walk';
  run.style.cssText = BUTTON_CSS;
  run.onclick = () => {
    const ds = getDataSource();
    if (!ds || running) return;
    running = true;
    run.disabled = true;
    panel.clearResults();
    void runWalk(viewer, ds, currentUrlOf(ds), panel).finally(() => {
      running = false;
      run.disabled = false;
    });
  };

  // Transfer rate is derived here rather than in the library: it's a display
  // concern, and the counter only needs to be a monotonic total.
  let lastBytes = 0;
  let lastAt = performance.now();
  let rate = 0;

  const tick = (): void => {
    const ds = getDataSource();
    const capable = ds ? asStatsCapable(ds) : null;
    if (capable) {
      const now = performance.now();
      const elapsed = (now - lastAt) / 1000;
      if (elapsed > 0) {
        const delta = capable.stats.transferredBytes - lastBytes;
        // Smoothed, or the readout flickers between a burst and a gap in a
        // way that's impossible to read at a 250ms refresh.
        rate = rate * 0.6 + (delta / elapsed) * 0.4;
        lastBytes = capable.stats.transferredBytes;
        lastAt = now;
      }
    }
    panel.renderLive(capable ? capable.stats : null, rate < 1024 ? 0 : rate);
    // Re-appending is cheap and keeps the button below the readout, which
    // `renderLive` replaces wholesale on every tick.
    if (!run.isConnected) document.getElementById('benchBody')?.appendChild(run);
  };
  tick();
  setInterval(tick, 250);

  (window as unknown as { __copcesiumRunBench?: () => void }).__copcesiumRunBench = () => run.click();
}

/** The URL a data source was loaded from, for labelling results. */
function currentUrlOf(ds: CopcDataSource): string {
  return (ds as unknown as { _url?: string })._url ?? '';
}

/**
 * `?bench` auto-runs the fixed walk once the initial dataset is loaded;
 * `?bench=<presetKey>` picks which dataset to load first. Without it the tab
 * still works — it just waits for you to fly the camera or press the button.
 */
export function benchRequested(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.has('bench') ? (params.get('bench') ?? '') : null;
}

/** Starts the fixed walk programmatically (used by the `?bench` auto-run). */
export function autoRunWalk(): void {
  (window as unknown as { __copcesiumRunBench?: () => void }).__copcesiumRunBench?.();
}
