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
 * Reads a COPC file's header/VLR metadata and its root hierarchy page, and
 * returns the root node map, any unresolved sub-page entry points, the max
 * depth covered by the root page, and the root cube (center/half size).
 */
export async function loadCopcHierarchy(url: string): Promise<CopcHierarchy> {
  const counter = new TransferCounter();
  await assertRangeRequestsSupported(url, counter);
  // Falls back to a HEAD when the probe couldn't disclose the size — see the
  // CORS note above. `Content-Length` *is* safelisted, so a HEAD reads it from
  // any origin. One extra headers-only request, and only when needed.
  if (counter.fileBytes === 0) await readFileSizeViaHead(url, counter);
  // `Copc.create()` and `loadHierarchyPage()` both accept a Getter in place of
  // a URL, which is what makes the header and root-page bytes countable —
  // handing them the URL would route them through copc's own uncounted (and
  // status-blind) default getter instead.
  const getter = createCountingGetter(url, counter);

  let copc: Copc;
  try {
    copc = await Copc.create(getter);
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
  // A manual reduce instead of `Math.max(...keys.map(getDepth))` — spreading a
  // large array into call arguments can blow the call stack (see #126).
  let maxDepth = 0;
  for (const key of Object.keys(nodes)) {
    const depth = getDepth(key);
    if (depth > maxDepth) maxDepth = depth;
  }

  return { copc, nodes, pages, maxDepth, rootCenter, rootHalfSize, counter };
}
