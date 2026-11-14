// Two-point / path measurement for the advanced viewer (#215). STUB: not
// wired into main.ts yet. The numbers come from the library's pure
// `measureSegment()` / `measurePath()`; this file only owns the interaction
// and the drawing, which stay out of the library on purpose.
//
// TODO(#215):
// - Import `measurePath` from 'copcesium' once the example builds against a
//   copcesium that exports it (it lives in src/measure/measure.ts).
// - Call `start()` from a toolbar button, `onClick()` from a
//   ScreenSpaceEventHandler LEFT_CLICK, `cancel()` on Escape.
// - Draw endpoints, the polyline and labels as Cesium Entities; labels set
//   `disableDepthTestDistance` so points never hide them.
// - Store `PickedPoint.dataPosition`, and draw at that position shifted by
//   the live `heightOffset`, so the endpoints follow the cloud if it moves.
// - Show distance, horizontal distance and height difference in meters, and
//   say in the UI that height is ellipsoidal height.
// - Browser check (needs the measurement lock to be released): the same two
//   points stay put across LOD changes and cache eviction; clipped-away points
//   cannot be picked.
import type * as Cesium from 'cesium';
import type { CopcDataSource, PickedPoint } from 'copcesium';

type MeasureState =
  | { kind: 'idle' }
  | { kind: 'picking'; points: Cesium.Cartesian3[] }
  | { kind: 'done'; points: Cesium.Cartesian3[] };

export class MeasureTool {
  private state: MeasureState = { kind: 'idle' };

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly dataSource: CopcDataSource,
  ) {}

  /** Starts a new measurement, discarding any finished one. */
  start(): void {
    this.clear();
    this.state = { kind: 'picking', points: [] };
  }

  /** Adds the point under `windowPosition`, if any. */
  onClick(windowPosition: Cesium.Cartesian2): void {
    if (this.state.kind !== 'picking') return;
    const picked: PickedPoint | undefined = this.dataSource.pickPoint(windowPosition);
    if (!picked) return;
    this.state.points.push(picked.dataPosition);
    // TODO(#215): redraw, and recompute with measurePath(this.state.points).
    this.viewer.scene.requestRender();
  }

  /** Ends picking and keeps the result on screen. */
  finish(): void {
    if (this.state.kind !== 'picking') return;
    this.state = { kind: 'done', points: this.state.points };
  }

  /** Abandons an in-progress measurement. */
  cancel(): void {
    if (this.state.kind === 'picking') this.clear();
  }

  /** Removes the current measurement and its drawing. */
  clear(): void {
    // TODO(#215): remove the entities this tool added.
    this.state = { kind: 'idle' };
  }
}
