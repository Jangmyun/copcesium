import * as Cesium from 'cesium';
import type { CopcDataSource } from 'copcesium';

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
    fetch: { p50: number; p95: number };
    decode: { p50: number; p95: number };
    upload: { p50: number; p95: number };
  };
}

function asStatsCapable(ds: CopcDataSource): StatsCapable | null {
  const candidate = ds as unknown as Partial<StatsCapable>;
  return candidate.stats && typeof candidate.stats.pendingNodes === 'number'
    ? (candidate as StatsCapable)
    : null;
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

/** Fixed, so flight time is identical every run rather than distance-dependent. */
const FLIGHT_SECONDS = 2;
/** How long `pendingNodes` must stay at 0 before a view counts as settled. A
 *  single zero reading isn't enough: the LoD pass runs on a `debounceMs`
 *  timer, so there's a gap between one batch draining and the next starting. */
const SETTLE_MS = 600;
/** Gives up on a stop that never settles (a dead range server, say) instead of
 *  hanging the whole run. */
const CONVERGE_TIMEOUT_MS = 60_000;

export interface StopResult {
  label: string;
  /** Wall time from arrival at the waypoint to a settled view. */
  convergeMs: number;
  /** Bytes and requests this stop alone added. */
  bytesDelta: number;
  requestsDelta: number;
  /** Totals as of this stop. */
  transferredBytes: number;
  requestCount: number;
  fetchP50: number;
  fetchP95: number;
  decodeP50: number;
  decodeP95: number;
  uploadP50: number;
  uploadP95: number;
  /** True when the stop hit `CONVERGE_TIMEOUT_MS` instead of settling. */
  timedOut: boolean;
}

export interface BenchResult {
  url: string;
  fileBytes: number;
  transferredBytes: number;
  requestCount: number;
  /** The headline: what fraction of the file had to cross the wire. */
  transferredFraction: number;
  stops: StopResult[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function flyTo(viewer: Cesium.Viewer, sphere: Cesium.BoundingSphere, wp: Waypoint): Promise<void> {
  return new Promise<void>((resolve) => {
    viewer.scene.camera.flyToBoundingSphere(sphere, {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(wp.headingDeg),
        Cesium.Math.toRadians(wp.pitchDeg),
        sphere.radius * wp.rangeFactor,
      ),
      duration: FLIGHT_SECONDS,
      complete: () => resolve(),
    });
  });
}

/** Resolves once nothing has been in flight for `SETTLE_MS`, or on timeout. */
async function waitUntilSettled(ds: StatsCapable): Promise<boolean> {
  const deadline = performance.now() + CONVERGE_TIMEOUT_MS;
  let quietSince: number | null = null;
  for (;;) {
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

export async function runBench(
  viewer: Cesium.Viewer,
  dataSource: CopcDataSource,
  url: string,
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

  const stops: StopResult[] = [];
  let prevBytes = ds.stats.transferredBytes;
  let prevRequests = ds.stats.requestCount;

  for (const wp of WAYPOINTS) {
    await flyTo(viewer, rootSphere, wp);

    const startedAt = performance.now();
    const timedOut = await waitUntilSettled(ds);
    const convergeMs = performance.now() - startedAt;

    const s = ds.stats;
    stops.push({
      label: wp.label,
      convergeMs: Math.round(convergeMs),
      bytesDelta: s.transferredBytes - prevBytes,
      requestsDelta: s.requestCount - prevRequests,
      transferredBytes: s.transferredBytes,
      requestCount: s.requestCount,
      fetchP50: Math.round(s.fetch.p50),
      fetchP95: Math.round(s.fetch.p95),
      decodeP50: Math.round(s.decode.p50),
      decodeP95: Math.round(s.decode.p95),
      uploadP50: Math.round(s.upload.p50),
      uploadP95: Math.round(s.upload.p95),
      timedOut,
    });
    prevBytes = s.transferredBytes;
    prevRequests = s.requestCount;
  }

  const final = ds.stats;
  const result: BenchResult = {
    url,
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
  (window as unknown as { __copcesiumBench?: BenchResult }).__copcesiumBench = result;
  return result;
}

/** `?bench` in the URL turns the walk on. */
export function benchRequested(): boolean {
  return new URLSearchParams(window.location.search).has('bench');
}
