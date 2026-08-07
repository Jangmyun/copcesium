import type { Copc, Hierarchy } from 'copc';

/**
 * Payload carried as `WorkerRequest.payload` for this worker. `node` must be
 * the Hierarchy.Node entry (pointCount/pointDataOffset/pointDataLength) for
 * the specific node being converted, not a node key string — the caller looks
 * that up from the hierarchy's node map before dispatching.
 */
export interface NodeConversionPayload {
  /** This node's compressed point data, already fetched (and possibly merged
   *  with adjacent sibling ranges) by `RangeFetcher` on the main thread. */
  compressedBytes: Uint8Array;
  copc: Copc;
  node: Hierarchy.Node;
  /** proj4-registered CRS name; 'EPSG:4326' skips the proj4 transform entirely. */
  proj: string;
  projDef: string | null;
  geoidOffset: number;
  /** Converts the Z axis unit to meters (see CopcDataSourceOptions.zFactor). */
  zFactor: number;
  /**
   * The file header's Z range, in source units. Used only to normalize each
   * point's Z for the elevation colour ramp — a per-node range would make the
   * same height a different colour in different nodes.
   */
  zMin: number;
  zMax: number;
}
