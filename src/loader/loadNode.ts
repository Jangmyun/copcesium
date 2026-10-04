import type * as Cesium from 'cesium';
import { PointCloudPrimitive, type PointStyle } from '../renderer/PointCloudPrimitive';
import type { EyeDomeLighting } from '../renderer/EyeDomeLighting';
import type { NodeRenderData } from '../types';

/**
 * Turns a node's render-ready buffers into a GPU `PointCloudPrimitive`.
 *
 * A thin wrapper, kept `async` for a uniform call signature even though it
 * does no awaiting itself — `CopcDataSource._loadNode` already resolves
 * `renderData` from `WorkerPool` before calling this.
 *
 * `onGpuInit` fires once, on the first frame this node is actually drawn,
 * with the span the GPU buffer/shader creation took. Nothing here can time
 * that: the constructor only allocates, and the upload needs a rendering
 * context that exists only inside `update()` (#194).
 */
export async function createNodePrimitive(
  renderData: NodeRenderData,
  boundingSphere: Cesium.BoundingSphere,
  style: PointStyle,
  onGpuInit?: (startedAt: number, endedAt: number) => void,
  edl?: EyeDomeLighting,
): Promise<PointCloudPrimitive> {
  return new PointCloudPrimitive(renderData, boundingSphere, style, onGpuInit, edl);
}
