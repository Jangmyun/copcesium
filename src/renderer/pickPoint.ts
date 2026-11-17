/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * GPU point picking for `CopcDataSource.pickPoint()`: draws the visible nodes
 * into an ID framebuffer, reads back a window around the click, and decodes
 * the nearest hit. Everything it needs from the data source is passed in per
 * call, so it holds no reference to the cache or the viewer.
 */
import * as Cesium from 'cesium';
import type { LoadedNode, PickedPoint } from '../types';
import { MAX_PICKABLE_NODE_SLOTS, MAX_PICKABLE_POINT_INDEX, decodePickColor } from './shaders';
import { PickFramebuffer } from './PickFramebuffer';

// `SceneTransforms.transformWindowToDrawingBuffer` and `Context.prototype.draw`
// are Cesium renderer internals with no public type declarations — same
// undeclared-but-present-at-runtime pattern as PointCloudPrimitive.ts's
// CesiumInternal cast. `pickPoint()` is the only user.
interface CesiumPickingInternal {
  SceneTransforms: {
    transformWindowToDrawingBuffer(scene: Cesium.Scene, windowPosition: Cesium.Cartesian2): Cesium.Cartesian2;
  };
}
const CesiumPicking = Cesium as unknown as CesiumPickingInternal;
interface CesiumContextDrawable {
  draw(command: unknown, passState: unknown): void;
  uniformState: {
    updateCamera(camera: Cesium.Camera): void;
    updateFrustum(frustum: PickFrustum): void;
  };
}
/** The near/far-bearing subset of every Cesium frustum type (perspective,
 *  orthographic, and their off-center variants) that `pickPoint()` tightens. */
interface PickFrustum {
  near: number;
  far: number;
  clone(): PickFrustum;
}
/** Floor for the pick pass's tightened near plane — see `pickPoint()`. */
const MIN_PICK_NEAR = 1;
/** `Scene.context` (the renderer `Context`) has no public type declaration either. */
interface CesiumSceneInternal {
  context: unknown;
}

export interface PickInputs {
  scene: Cesium.Scene;
  /** The keys currently selected for display, in selection order. */
  selectedKeys: ReadonlySet<string>;
  peekNode: (key: string) => LoadedNode | undefined;
  getSphere: (key: string) => Cesium.BoundingSphere;
  heightOffset: number;
}

export class PointPicker {
  /** Lazily built, resized to the canvas on demand — see `pick()`. */
  private readonly _framebuffer = new PickFramebuffer();
  /** So a WebGL1 session logs the pickPoint() limitation once, not on every click. */
  private _warnedNoWebgl2 = false;

  pick(deps: PickInputs, windowPosition: Cesium.Cartesian2, tolerancePixels: number): PickedPoint | undefined {
    const { scene, selectedKeys, peekNode, getSphere, heightOffset } = deps;
    if (!Cesium.FeatureDetection.supportsWebgl2(scene)) {
      if (!this._warnedNoWebgl2) {
        this._warnedNoWebgl2 = true;
        console.warn(
          '[CopcDataSource] pickPoint() requires a WebGL2 context; this session is running WebGL1 ' +
            '(either the browser lacks WebGL2, or the Viewer was created with contextOptions.requestWebgl1). ' +
            'Returning undefined for every call.',
        );
      }
      return undefined;
    }

    const context = (scene as unknown as CesiumSceneInternal).context as unknown as CesiumContextDrawable;
    const width = scene.drawingBufferWidth;
    const height = scene.drawingBufferHeight;
    if (width === 0 || height === 0) return undefined;

    const { framebuffer, passState } = this._framebuffer.ensure(context, width, height);
    this._framebuffer.clear(context);
    // The czm_* view/projection uniforms still hold whatever the last draw
    // left there — e.g. the narrow off-center frustum of a scene.pick() the
    // Viewer's own click handler ran just before this, or the nearest slice
    // of a multi-frustum render. Re-sync them to the full current camera,
    // as Cesium's Picking.js does before its own pick pass.
    context.uniformState.updateCamera(scene.camera);

    // 1-based: slotToKey[slot - 1] === key — see decodePickColor()'s doc for
    // why node slot 0 is reserved as "no hit". Commands are collected first
    // and drawn only after the frustum is tightened to exactly these nodes.
    const slotToKey: string[] = [];
    const commands: unknown[] = [];
    for (const key of selectedKeys) {
      // Past these limits the pick encoding wraps and would silently report a
      // different point — see MAX_PICKABLE_NODE_SLOTS's doc comment.
      if (slotToKey.length >= MAX_PICKABLE_NODE_SLOTS) break;
      const node = peekNode(key);
      if (!node || !node.primitive.show) continue; // not actually on screen
      if (node.pointCount > MAX_PICKABLE_POINT_INDEX + 1) continue;
      const cmd = node.primitive.preparePickCommand(context, slotToKey.length + 1, framebuffer);
      if (!cmd) continue;
      slotToKey.push(key);
      commands.push(cmd);
    }
    if (slotToKey.length === 0) return undefined;

    tightenPickFrustum(scene, context, slotToKey, getSphere, heightOffset);
    for (const cmd of commands) context.draw(cmd, passState);

    const drawingBufferPos = CesiumPicking.SceneTransforms.transformWindowToDrawingBuffer(scene, windowPosition);
    const glX = Math.round(drawingBufferPos.x);
    // Window/drawing-buffer Y grows downward from the top; GL readback Y grows upward from the bottom.
    const glY = Math.round(height - drawingBufferPos.y);

    const rectX = Cesium.Math.clamp(glX - tolerancePixels, 0, width - 1);
    const rectY = Cesium.Math.clamp(glY - tolerancePixels, 0, height - 1);
    const rectRight = Cesium.Math.clamp(glX + tolerancePixels, 0, width - 1);
    const rectTop = Cesium.Math.clamp(glY + tolerancePixels, 0, height - 1);
    const rectW = rectRight - rectX + 1;
    const rectH = rectTop - rectY + 1;
    if (rectW <= 0 || rectH <= 0) return undefined;

    const pixels = this._framebuffer.readPixels(context, rectX, rectY, rectW, rectH);

    // Among every hit in the tolerance window, the one closest to the exact
    // click wins — each pixel already reflects the GPU depth test's own
    // nearest-to-camera winner, so no depth comparison is needed here.
    let best: { pointIndex: number; nodeSlot: number; distSq: number } | undefined;
    for (let row = 0; row < rectH; row++) {
      for (let col = 0; col < rectW; col++) {
        const decoded = decodePickColor(pixels, (row * rectW + col) * 4);
        if (!decoded) continue;
        const dx = rectX + col - glX;
        const dy = rectY + row - glY;
        const distSq = dx * dx + dy * dy;
        if (!best || distSq < best.distSq) best = { ...decoded, distSq };
      }
    }
    if (!best) return undefined;

    const nodeKey = slotToKey[best.nodeSlot - 1];
    const node = nodeKey ? peekNode(nodeKey) : undefined;
    if (!nodeKey || !node) return undefined;

    const attrs = node.primitive.readPointAttributes(best.pointIndex, context);
    return {
      nodeKey,
      pointIndex: best.pointIndex,
      position: attrs.position,
      dataPosition: attrs.dataPosition,
      classification: attrs.classification,
      intensity: attrs.intensity,
    };
  }

  destroy(): void {
    this._framebuffer.destroy();
  }
}

/**
 * Narrows the pick pass's near/far to the depth range the drawn nodes
 * actually span. The camera's own frustum runs 0.1 m–1e10 m, which leaves
 * even a 24-bit pick depth buffer unable to order points kilometres away —
 * the GPU depth test then keeps an arbitrary point instead of the front-most
 * one. Depth is measured along the view direction (not Euclidean distance)
 * so off-axis points near the screen edge are never clipped, and each
 * sphere is widened by `|heightOffset|`, which shifts drawn positions but
 * not the cached spheres. Leaves the uniforms untouched in a non-3D scene
 * mode or for a frustum without plain near/far.
 */
function tightenPickFrustum(
  scene: Cesium.Scene,
  context: CesiumContextDrawable,
  keys: string[],
  getSphere: (key: string) => Cesium.BoundingSphere,
  heightOffset: number,
): void {
  if (scene.mode !== Cesium.SceneMode.SCENE3D) return;
  const original = scene.camera.frustum as unknown as Partial<PickFrustum>;
  if (typeof original.near !== 'number' || typeof original.far !== 'number' || typeof original.clone !== 'function') {
    return;
  }
  const camPos = scene.camera.positionWC;
  const camDir = scene.camera.directionWC;
  const extra = Math.abs(heightOffset);
  const toCenter = new Cesium.Cartesian3();
  let near = Infinity;
  let far = -Infinity;
  for (const key of keys) {
    const sphere = getSphere(key);
    const depth = Cesium.Cartesian3.dot(Cesium.Cartesian3.subtract(sphere.center, camPos, toCenter), camDir);
    const radius = sphere.radius + extra;
    near = Math.min(near, depth - radius);
    far = Math.max(far, depth + radius);
  }
  const frustum = (original as PickFrustum).clone();
  // Camera inside (or right next to) a node drives `depth - radius` to zero
  // or below; floor it rather than letting near collapse and squander the
  // depth precision this exists to recover.
  frustum.near = Math.max(near, MIN_PICK_NEAR, original.near);
  frustum.far = Math.max(Math.min(far, original.far), frustum.near + 1);
  context.uniformState.updateFrustum(frustum);
}
