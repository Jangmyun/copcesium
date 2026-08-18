import type * as Cesium from 'cesium';
import { PointCloudPrimitive, type PointStyle } from '../renderer/PointCloudPrimitive';
import type { NodeRenderData } from '../types';

/**
 * Turns a node's render-ready buffers into a GPU `PointCloudPrimitive`.
 *
 * This is a thin wrapper today, but it's declared `async` so the signature
 * already matches Day 3, when it will fetch `renderData` from a `WorkerPool`
 * instead of receiving it directly — callers won't need to change.
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
): Promise<PointCloudPrimitive> {
  return new PointCloudPrimitive(renderData, boundingSphere, style, onGpuInit);
}
