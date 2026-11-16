/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun), 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

// Clip tab: drives `CopcDataSource`'s `clipBoxes` / `clipPlanes` /
// `clipMode` setters from a click on the cloud, so plane and box clipping can
// be tried without building `Cesium.Plane` / `Cesium.Matrix4` values in the
// console. Both region kinds are placed in the clicked point's local
// east/north/up frame. A click only does anything while a tool is active.
import * as Cesium from 'cesium';
import type { ClipMode, CopcDataSource } from 'copcesium';

type Tool = 'off' | 'box' | 'plane';
type Side = 'E' | 'W' | 'N' | 'S' | 'U' | 'D';

/** Plane normals in the clicked point's ENU frame, pointing at the kept side. */
const SIDE_NORMALS: Record<Side, Cesium.Cartesian3> = {
  E: new Cesium.Cartesian3(1, 0, 0),
  W: new Cesium.Cartesian3(-1, 0, 0),
  N: new Cesium.Cartesian3(0, 1, 0),
  S: new Cesium.Cartesian3(0, -1, 0),
  U: new Cesium.Cartesian3(0, 0, 1),
  D: new Cesium.Cartesian3(0, 0, -1),
};

const HINTS: Record<Tool, string> = {
  off: 'Pick a tool, then click a point on the cloud.',
  box: 'Click a point to center the box on it. Click again to move it.',
  plane: 'Click a point to cut through it. Click again to move the cut.',
};

export interface ClipTab {
  /** Drops every region and the outline. Call before a data source is destroyed. */
  reset(): void;
  /** The panel's inside/outside choice, to pass to the next `load()`. */
  clipMode(): ClipMode;
}

export function mountClipTab(
  viewer: Cesium.Viewer,
  getDataSource: () => CopcDataSource | null,
): ClipTab {
  const toolGrid = document.getElementById('clipToolGrid')!;
  const modeGrid = document.getElementById('clipModeGrid')!;
  const hint = document.getElementById('clipHint')!;
  const boxFields = document.getElementById('clipBoxFields')!;
  const planeFields = document.getElementById('clipPlaneFields')!;
  const sizeInputs = ['clipBoxE', 'clipBoxN', 'clipBoxU'].map(
    (id) => document.getElementById(id) as HTMLInputElement,
  );
  const sideSelect = document.getElementById('clipPlaneSide') as HTMLSelectElement;
  const clearBtn = document.getElementById('clipClearBtn') as HTMLButtonElement;

  let tool: Tool = 'off';
  let mode: ClipMode = 'inside';
  // The clicked point each region was built from, kept so a size or side
  // change can rebuild the region in place without another click.
  let boxCenter: Cesium.Cartesian3 | null = null;
  let planePoint: Cesium.Cartesian3 | null = null;
  let outline: Cesium.Entity | null = null;
  // Last valid size per axis, so a half-typed or empty field keeps the box.
  const size = new Cesium.Cartesian3(150, 100, 80);

  const setHint = (text: string): void => {
    hint.textContent = text;
  };

  const removeOutline = (): void => {
    if (outline) viewer.entities.remove(outline);
    outline = null;
  };

  const syncClearBtn = (): void => {
    clearBtn.disabled = !boxCenter && !planePoint;
  };

  const applyBox = (): void => {
    const ds = getDataSource();
    if (!ds || !boxCenter) return;
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(boxCenter);
    ds.clipPlanes = undefined;
    ds.clipBoxes = [Cesium.Matrix4.multiplyByScale(enu, size, new Cesium.Matrix4())];
    removeOutline();
    outline = viewer.entities.add({
      position: boxCenter,
      // Zero heading/pitch/roll at a position is that position's ENU frame,
      // the same frame the clip box above is built in.
      orientation: Cesium.Transforms.headingPitchRollQuaternion(
        boxCenter,
        new Cesium.HeadingPitchRoll(),
      ),
      box: {
        dimensions: Cesium.Cartesian3.clone(size),
        fill: false,
        outline: true,
        outlineColor: Cesium.Color.CYAN,
      },
    });
    viewer.scene.requestRender();
  };

  const applyPlane = (): void => {
    const ds = getDataSource();
    if (!ds || !planePoint) return;
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(planePoint);
    const normal = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      SIDE_NORMALS[sideSelect.value as Side],
      new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.normalize(normal, normal);
    ds.clipBoxes = undefined;
    ds.clipPlanes = [Cesium.Plane.fromPointNormal(planePoint, normal)];
    removeOutline();
    viewer.scene.requestRender();
  };

  const clear = (): void => {
    const ds = getDataSource();
    if (ds) {
      ds.clipBoxes = undefined;
      ds.clipPlanes = undefined;
    }
    boxCenter = null;
    planePoint = null;
    removeOutline();
    syncClearBtn();
    viewer.scene.requestRender();
  };

  const setTool = (next: Tool): void => {
    tool = next;
    toolGrid
      .querySelectorAll<HTMLElement>('.color-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.tool === next));
    boxFields.style.display = next === 'box' ? '' : 'none';
    planeFields.style.display = next === 'plane' ? '' : 'none';
    setHint(HINTS[next]);
  };

  const setMode = (next: ClipMode): void => {
    mode = next;
    modeGrid
      .querySelectorAll<HTMLElement>('.color-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
    const ds = getDataSource();
    if (ds) ds.clipMode = next;
    viewer.scene.requestRender();
  };

  toolGrid.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.color-btn') as HTMLElement | null;
    if (btn) setTool((btn.dataset.tool ?? 'off') as Tool);
  });
  modeGrid.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.color-btn') as HTMLElement | null;
    if (btn) setMode((btn.dataset.mode ?? 'inside') as ClipMode);
  });

  const axes = ['x', 'y', 'z'] as const;
  sizeInputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v) || v <= 0) return;
      size[axes[i]!] = v;
      applyBox();
    });
  });
  sideSelect.addEventListener('change', applyPlane);
  clearBtn.addEventListener('click', clear);

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    if (tool === 'off') return;
    const ds = getDataSource();
    if (!ds) return;
    // The default click handler would otherwise select the box outline and
    // open the info box over it.
    viewer.selectedEntity = undefined;
    const picked = ds.pickPoint(e.position);
    if (!picked) {
      // `pickPoint()` skips clipped points, so with `inside` and a region set,
      // anything outside the kept region can't be clicked.
      setHint(
        boxCenter || planePoint
          ? 'No visible point there. Clipped points can’t be picked — press Clear to start over.'
          : 'No point there. Click on the cloud itself.',
      );
      return;
    }
    setHint(HINTS[tool]);
    // `position` already includes the live heightOffset, which is also where
    // the clip test runs, so the region lands on the point that was clicked.
    if (tool === 'box') {
      planePoint = null;
      boxCenter = Cesium.Cartesian3.clone(picked.position);
      applyBox();
    } else {
      boxCenter = null;
      planePoint = Cesium.Cartesian3.clone(picked.position);
      applyPlane();
    }
    syncClearBtn();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  setTool('off');
  setMode(mode);
  syncClearBtn();

  return {
    reset: clear,
    // A region belongs to the dataset it was clicked on, so a new load starts
    // with none; the inside/outside choice carries over.
    clipMode: () => mode,
  };
}
