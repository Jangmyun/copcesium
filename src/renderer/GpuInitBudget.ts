/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun), 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * A per-frame cap on how many primitives may upload their vertex buffers
 * (`_initGpu`), shared by every primitive of one data source. Keyed by
 * `frameState.frameNumber`, so no preRender hook has to reset it.
 *
 * Priority: a visible primitive may take any slot left under `limit`; a hidden
 * pre-upload takes at most one slot per frame, so a burst of prefetched nodes
 * cannot use up the whole frame budget ahead of nodes that are on screen.
 */
export class GpuInitBudget {
  private _frame = -1;
  private _used = 0;
  private _hiddenUsed = 0;

  constructor(readonly limit: number) {}

  /** Claims a slot for this frame; false means wait for a later frame. */
  tryAcquire(frameNumber: number, hidden: boolean): boolean {
    if (frameNumber !== this._frame) {
      this._frame = frameNumber;
      this._used = 0;
      this._hiddenUsed = 0;
    }
    if (this._used >= this.limit) return false;
    if (hidden) {
      if (this._hiddenUsed >= 1) return false;
      this._hiddenUsed++;
    }
    this._used++;
    return true;
  }
}
