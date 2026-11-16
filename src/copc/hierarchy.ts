/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Metadata stage. Fetches and parses a COPC file's header and octree
 * hierarchy pages (not point data) via the `copc` library, tracking bytes
 * transferred along the way for `CopcDataSource`'s stats. Feeds the node map
 * that `selectNodes` walks and `loadNode`/`worker` later decode.
 */
import { Copc } from 'copc';
import type { Hierarchy } from 'copc';
import { getDepth } from './node';
import { createCountingGetter, parseContentRangeTotal, TransferCounter } from './TransferCounter';

export interface CopcHierarchy {
  copc: Copc;
  nodes: Hierarchy.Node.Map;
  pages: Hierarchy.Page.Map;
  maxDepth: number;
  rootCenter: { x: number; y: number; z: number };
  rootHalfSize: number;
  /** Carries the bytes this load already spent, so `CopcDataSource` can keep
   *  counting into the same tally instead of starting from zero after the
   *  header and root page are on the wire. */
  counter: TransferCounter;
}

/**
 * A server that ignores `Range` and returns the whole file as `200 OK`
 * doesn't fail — it just hands back far more bytes than the offset math
 * downstream expects, which turns into a confusing parse failure deep inside
 * `Copc.create()`. Probing for `206 Partial Content` up front turns that into
 * a clear, actionable error instead (#86).
 */
async function assertRangeRequestsSupported(url: string, counter: TransferCounter): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return; // local/fs getter has no such failure mode
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  // The probe response carries the file size in `Content-Range`, which costs
  // nothing to read — but only where it's readable. `Content-Range` is not a
  // CORS-safelisted response header, and the public sample buckets send no
  // `Access-Control-Expose-Headers`, so in a browser this comes back null even
  // though the header is on the wire. It does work same-origin and in Node.
  const total = parseContentRangeTotal(response.headers?.get('Content-Range') ?? null);
  if (total !== undefined) counter.setFileBytes(total);
  counter.record(0, 1);
  if (response.status !== 206) {
    // A server ignoring Range streams the whole file here; don't keep it open.
    void response.body?.cancel().catch(() => {});
    throw new Error(
      `Server did not honor an HTTP Range Request (expected 206 Partial Content, got ${response.status}). ` +
        'COPC streaming requires Range Request support — check that the server or CDN advertises "Accept-Ranges: bytes".',
    );
  }
}

/** Last resort for the file size when `Content-Range` isn't readable. */
async function readFileSizeViaHead(url: string, counter: TransferCounter): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const length = Number(response.headers?.get('Content-Length'));
    if (Number.isFinite(length) && length > 0) counter.setFileBytes(length);
  } catch {
    // Not worth failing a load over: an unknown file size costs the
    // transferred-fraction readout, nothing else.
  }
}

/**
 * Turns hierarchy entries that can't describe real point data into empty
 * nodes: more points than the whole file holds, or points with no bytes to
 * hold them. Either would otherwise reach the decoder as a range read that
 * fails or a buffer sized from a corrupt count. They are emptied rather than
 * removed, so selection still walks through them to their children. Returns
 * how many were emptied.
 */
export function emptyInvalidNodes(nodes: Hierarchy.Node.Map, totalPoints: number, url: string): number {
  let emptied = 0;
  for (const [key, node] of Object.entries(nodes)) {
    if (!node) continue;
    const tooMany = node.pointCount > totalPoints;
    const noBytes = node.pointCount > 0 && !(node.pointDataLength > 0);
    if (!tooMany && !noBytes && node.pointCount >= 0) continue;
    nodes[key] = { pointCount: 0, pointDataOffset: 0, pointDataLength: 0 };
    emptied++;
  }
  if (emptied > 0) {
    console.warn(
      `[CopcDataSource] ${url}: ignored ${emptied} hierarchy ${emptied === 1 ? 'entry' : 'entries'} ` +
        `whose point count exceeds the file's (${totalPoints}) or that has points but no data.`,
    );
  }
  return emptied;
}

/**
 * Reads a COPC file's header/VLR metadata and its root hierarchy page, and
 * returns the root node map, any unresolved sub-page entry points, the max
 * depth covered by the root page, and the root cube (center/half size).
 */
export async function loadCopcHierarchy(url: string): Promise<CopcHierarchy> {
  const counter = new TransferCounter();
  // `Copc.create()` and `loadHierarchyPage()` both accept a Getter in place of
  // a URL, which is what makes the header and root-page bytes countable —
  // handing them the URL would route them through copc's own uncounted (and
  // status-blind) default getter instead.
  const getter = createCountingGetter(url, counter);

  // The Range probe and the header read don't depend on each other, so they
  // go out together: before first points, the probe's round trip (and the
  // HEAD's, below) used to sit in series ahead of the header and root page.
  // The probe still gets the first word — on a server that ignores Range,
  // its error says why, where the header read's failure would not.
  const probe = assertRangeRequestsSupported(url, counter);
  const header = Copc.create(getter);
  header.catch(() => {}); // awaited below, once the probe has passed
  // Falls back to a HEAD when the probe couldn't disclose the size — see the
  // CORS note above. `Content-Length` *is* safelisted, so a HEAD reads it from
  // any origin. One extra headers-only request, only when needed, and off the
  // path to first points.
  const fileSize = probe.then(
    () => (counter.fileBytes === 0 ? readFileSizeViaHead(url, counter) : undefined),
    () => undefined,
  );
  await probe;

  let copc: Copc;
  try {
    copc = await header;
  } catch (err) {
    const e = err as Error;
    if (/must be at least|Invalid header|COPC info VLR/i.test(e.message)) {
      throw new Error(
        `Failed to read the COPC header. Check that the URL is correct and that CORS access is allowed.\nCause: ${e.message}`,
        { cause: err },
      );
    }
    throw err;
  }

  const [minx, miny, minz, maxx, maxy, maxz] = copc.info.cube;
  const rootCenter = { x: (minx + maxx) / 2, y: (miny + maxy) / 2, z: (minz + maxz) / 2 };
  const rootHalfSize = (maxx - minx) / 2;

  const { nodes, pages } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
  emptyInvalidNodes(nodes, copc.header.pointCount, url);
  // A manual reduce instead of `Math.max(...keys.map(getDepth))` — spreading a
  // large array into call arguments can blow the call stack (see #126).
  let maxDepth = 0;
  for (const key of Object.keys(nodes)) {
    const depth = getDepth(key);
    if (depth > maxDepth) maxDepth = depth;
  }

  await fileSize;
  return { copc, nodes, pages, maxDepth, rootCenter, rootHalfSize, counter };
}
