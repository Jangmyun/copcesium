import { Copc } from 'copc';
import type { Hierarchy } from 'copc';
import { getDepth } from './node';

export interface CopcHierarchy {
  copc: Copc;
  nodes: Hierarchy.Node.Map;
  pages: Hierarchy.Page.Map;
  maxDepth: number;
  rootCenter: { x: number; y: number; z: number };
  rootHalfSize: number;
}

/**
 * A server that ignores `Range` and returns the whole file as `200 OK`
 * doesn't fail — it just hands back far more bytes than the offset math
 * downstream expects, which turns into a confusing parse failure deep inside
 * `Copc.create()`. Probing for `206 Partial Content` up front turns that into
 * a clear, actionable error instead (#86).
 */
async function assertRangeRequestsSupported(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return; // local/fs getter has no such failure mode
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (response.status !== 206) {
    throw new Error(
      `Server did not honor an HTTP Range Request (expected 206 Partial Content, got ${response.status}). ` +
        'COPC streaming requires Range Request support — check that the server or CDN advertises "Accept-Ranges: bytes".',
    );
  }
}

/**
 * Reads a COPC file's header/VLR metadata and its root hierarchy page, and
 * returns the root node map, any unresolved sub-page entry points, the max
 * depth covered by the root page, and the root cube (center/half size).
 */
export async function loadCopcHierarchy(url: string): Promise<CopcHierarchy> {
  await assertRangeRequestsSupported(url);

  let copc: Copc;
  try {
    copc = await Copc.create(url);
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

  const { nodes, pages } = await Copc.loadHierarchyPage(url, copc.info.rootHierarchyPage);
  const maxDepth = Math.max(...Object.keys(nodes).map(getDepth));

  return { copc, nodes, pages, maxDepth, rootCenter, rootHalfSize };
}
