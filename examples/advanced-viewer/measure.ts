/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

// Measure tab (#215): click points on the cloud to measure the path through
// them. The numbers come from the library's pure `measurePath()`; this file
// only owns the interaction and the drawing, which stay out of the library on
// purpose. The tool is exclusive with the Clip tab's, since both act on a
// left click.
import * as Cesium from 'cesium';
import { measurePath, type CopcDataSource, type PathMeasurement } from 'copcesium';
import { escapeHtml } from './html';

const HINTS = {
  off: 'Turn the tool on, then click points on the cloud.',
  picking: 'Click points along the path. Finish (Enter) keeps it; Esc cancels.',
  done: 'Turn the tool on again to start a new measurement.',
} as const;

const COLOR = Cesium.Color.fromCssColorString('#ffcc33');

export interface MeasureTab {
  /** Removes the measurement. Call before a data source is destroyed. */
  reset(): void;
  /** Turns the click tool off, keeping a finished measurement on screen. */
  stopTool(): void;
}

/**
 * @param onToolStart Called when this tool starts taking clicks, so the
 *   caller can switch any other click tool off.
 */
export function mountMeasureTab(
  viewer: Cesium.Viewer,
  getDataSource: () => CopcDataSource | null,
  onToolStart: () => void,
): MeasureTab {
  const toolGrid = document.getElementById('measureToolGrid')!;
  const hint = document.getElementById('measureHint')!;
  const results = document.getElementById('measureResults')!;
  const finishBtn = document.getElementById('measureFinishBtn') as HTMLButtonElement;
  const clearBtn = document.getElementById('measureClearBtn') as HTMLButtonElement;

  let picking = false;
  // The data itself, without the live heightOffset: `PickedPoint.dataPosition`.
  // Measured as is, and drawn shifted by the current offset (see `drawn`).
  let points: Cesium.Cartesian3[] = [];
  const entities: Cesium.Entity[] = [];

  /**
   * Where `dataPosition` is drawn now: shifted `heightOffset` meters along
   * geocentric up, which is how the library applies it. Adding it to the
   * Cartographic height instead would drift sideways (about 0.34 m per
   * 100 m at Autzen's latitude).
   */
  const drawn = (dataPosition: Cesium.Cartesian3, result?: Cesium.Cartesian3) => {
    const offset = getDataSource()?.heightOffset ?? 0;
    const up = Cesium.Cartesian3.normalize(dataPosition, new Cesium.Cartesian3());
    return Cesium.Cartesian3.add(
      dataPosition,
      Cesium.Cartesian3.multiplyByScalar(up, offset, up),
      result ?? new Cesium.Cartesian3(),
    );
  };

  const meters = (v: number): string =>
    Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(3)} km` : `${v.toFixed(2)} m`;
  const signed = (v: number): string => `${v >= 0 ? '+' : '−'}${meters(Math.abs(v))}`;

  const row = (label: string, value: string): string =>
    `<div class="url-row" style="justify-content:space-between"><span>${escapeHtml(label)}</span>` +
    `<span style="font-family:'IBM Plex Mono',monospace">${escapeHtml(value)}</span></div>`;

  const showResults = (m: PathMeasurement | null): void => {
    if (!m) {
      results.innerHTML = '';
      return;
    }
    const lines = [
      row('Points', String(points.length)),
      row('Distance', meters(m.length)),
      row('Horizontal', meters(m.horizontalLength)),
      row('Height difference', signed(m.heightDifference)),
    ];
    if (points.length > 2) {
      lines.push(row('Total ascent', meters(m.totalAscent)));
      lines.push(row('Total descent', meters(m.totalDescent)));
    }
    results.innerHTML = lines.join('');
  };

  const removeEntities = (): void => {
    for (const entity of entities) viewer.entities.remove(entity);
    entities.length = 0;
  };

  const redraw = (): void => {
    removeEntities();
    const measurement = points.length >= 2 ? measurePath(points) : null;
    showResults(measurement);
    points.forEach((p, i) => {
      entities.push(
        viewer.entities.add({
          position: new Cesium.CallbackPositionProperty((_time, result) => drawn(p, result), false),
          point: {
            pixelSize: 8,
            color: COLOR,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
            // Never hidden behind the points it was picked from.
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label:
            i > 0 && measurement
              ? {
                  text: meters(measurement.segments[i - 1]!.distance),
                  font: '12px sans-serif',
                  fillColor: Cesium.Color.WHITE,
                  showBackground: true,
                  backgroundColor: Cesium.Color.BLACK.withAlpha(0.6),
                  pixelOffset: new Cesium.Cartesian2(0, -16),
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                }
              : undefined,
        }),
      );
    });
    if (points.length >= 2) {
      const snapshot = points.slice();
      entities.push(
        viewer.entities.add({
          polyline: {
            positions: new Cesium.CallbackProperty(() => snapshot.map((p) => drawn(p)), false),
            width: 2,
            material: COLOR,
            depthFailMaterial: COLOR.withAlpha(0.5),
            arcType: Cesium.ArcType.NONE,
          },
        }),
      );
    }
    finishBtn.disabled = !picking || points.length < 2;
    clearBtn.disabled = points.length === 0;
    viewer.scene.requestRender();
  };

  const setPicking = (next: boolean): void => {
    picking = next;
    toolGrid
      .querySelectorAll<HTMLElement>('.color-btn')
      .forEach((b) => b.classList.toggle('active', (b.dataset.tool === 'on') === next));
    hint.textContent = next ? HINTS.picking : points.length >= 2 ? HINTS.done : HINTS.off;
    finishBtn.disabled = !picking || points.length < 2;
  };

  const clear = (): void => {
    points = [];
    redraw();
  };

  const start = (): void => {
    onToolStart();
    clear();
    setPicking(true);
  };

  const finish = (): void => {
    if (!picking) return;
    // A single point measures nothing, so it goes with the tool.
    if (points.length < 2) clear();
    setPicking(false);
  };

  const cancel = (): void => {
    if (!picking) return;
    clear();
    setPicking(false);
  };

  toolGrid.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.color-btn') as HTMLElement | null;
    if (!btn) return;
    if (btn.dataset.tool === 'on') {
      if (!picking) start();
    } else {
      finish();
    }
  });
  finishBtn.addEventListener('click', finish);
  clearBtn.addEventListener('click', () => {
    clear();
    if (picking) setPicking(true);
  });
  document.addEventListener('keydown', (e) => {
    if (!picking || (e.target as HTMLElement).closest('input, select, textarea')) return;
    if (e.key === 'Escape') cancel();
    else if (e.key === 'Enter') finish();
  });

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    if (!picking) return;
    const ds = getDataSource();
    if (!ds) return;
    // The default click handler would otherwise select a marker and open the
    // info box over it.
    viewer.selectedEntity = undefined;
    const picked = ds.pickPoint(e.position);
    if (!picked) {
      // `pickPoint()` skips clipped points too.
      hint.textContent = 'No visible point there. Click on the cloud itself.';
      return;
    }
    hint.textContent = HINTS.picking;
    points.push(Cesium.Cartesian3.clone(picked.dataPosition));
    redraw();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  setPicking(false);
  redraw();

  return {
    // Points belong to the dataset they were picked on.
    reset: () => {
      clear();
      setPicking(false);
    },
    stopTool: finish,
  };
}
