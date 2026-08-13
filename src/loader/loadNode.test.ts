import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import { createNodePrimitive } from './loadNode';
import { PointCloudPrimitive, type PointStyle } from '../renderer/PointCloudPrimitive';
import { COLOR_MODE, buildClassMask } from '../renderer/shaders';
import type { NodeRenderData } from '../types';

// Mock render data, standing in for what a Worker will eventually produce.
const renderData: NodeRenderData = {
  positions: new Float32Array([0, 0, 0, -6378137, 6378137, 0]),
  origin: [6378137, 0, 0],
  colors: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
  intensities: new Uint16Array([100, 200]),
  classifications: new Uint8Array([2, 6]),
  elevations: new Uint16Array([0, 65535]),
  pointCount: 2,
  maxIntensity: 200,
};

function makeStyle(pixelSize = 2): PointStyle {
  return {
    pixelSize,
    colorMode: COLOR_MODE.rgb,
    intensityRange: new Cesium.Cartesian2(0, 1),
    classMask: buildClassMask(undefined),
    heightOffset: 0,
  };
}

describe('createNodePrimitive', () => {
  it('resolves to a PointCloudPrimitive built from the given render data and bounding sphere', async () => {
    const boundingSphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(0, 0, 0), 10);

    const primitive = await createNodePrimitive(renderData, boundingSphere, makeStyle());

    expect(primitive).toBeInstanceOf(PointCloudPrimitive);
    expect(primitive.isDestroyed()).toBe(false);
  });

  it('shares a single style object across primitives so style updates apply to all of them', async () => {
    const boundingSphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(0, 0, 0), 10);
    const style = makeStyle(1);

    const a = await createNodePrimitive(renderData, boundingSphere, style);
    const b = await createNodePrimitive(renderData, boundingSphere, style);

    // Both primitives hold the same object, not a copy: their uniformMaps read
    // through to whatever CopcDataSource's setters last wrote.
    style.pixelSize = 5;
    style.colorMode = COLOR_MODE.classification;
    style.heightOffset = -3.2;
    expect(a.style).toBe(style);
    expect(b.style).toBe(style);
    expect(a.style.pixelSize).toBe(5);
    expect(b.style.colorMode).toBe(COLOR_MODE.classification);
    expect(b.style.heightOffset).toBe(-3.2);
  });
});
