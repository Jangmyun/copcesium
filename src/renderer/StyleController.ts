/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Owns the live `PointStyle` shared by every loaded primitive, plus the
 * validation and the option mirrors (`pointSizeMode`, `colorMode`,
 * `classificationFilter`, `clipMode`) that the public setters on
 * `CopcDataSource` delegate to. Every mutation asks the host to render again,
 * which `requestRenderMode: true` needs for a uniform change to show up.
 */
import * as Cesium from 'cesium';
import type { ClipMode, ColorMode, CopcDataSourceOptions, PointSizeMode } from '../types';
import type { PointStyle } from './PointCloudPrimitive';
import { COLOR_MODE, SIZE_MODE, buildClassMask } from './shaders';
import { createClipState, setClipBoxes, validateClipMode, validateClipPlanes } from './clipping';

/** Shared by the constructor and the live setter so an out-of-range or non-finite
 *  value can never slip in through either path. */
export function validateOpacity(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`opacity must be between 0 and 1, got ${value}`);
  }
  return value;
}

/** Shared by the constructor and the live setter; a zero/negative factor would
 *  make every attenuated point collapse to (or below) `minPixelSize`. */
export function validateAttenuationFactor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`attenuationFactor must be a positive finite number, got ${value}`);
  }
  return value;
}

/** Shared by the constructor and both min/max live setters — checked together
 *  because either one alone can't tell whether the *pair* still makes sense
 *  (e.g. raising min past the current max). */
export function validateSizeBounds(min: number, max: number): void {
  if (!Number.isFinite(min) || min < 0) {
    throw new RangeError(`minPixelSize must be a non-negative finite number, got ${min}`);
  }
  if (!Number.isFinite(max) || max < min) {
    throw new RangeError(`maxPixelSize must be a finite number >= minPixelSize (${min}), got ${max}`);
  }
}

/** The options the style is seeded from; every default is already filled in. */
export type StyleOptions = Required<
  Pick<
    CopcDataSourceOptions,
    | 'pixelSize'
    | 'pointSizeMode'
    | 'attenuationFactor'
    | 'minPixelSize'
    | 'maxPixelSize'
    | 'colorMode'
    | 'opacity'
    | 'clipMode'
  >
> &
  Pick<CopcDataSourceOptions, 'intensityRange' | 'classificationFilter' | 'clipPlanes' | 'clipBoxes'>;

export class StyleController {
  /** Handed to every primitive and mutated in place — never replaced. */
  readonly style: PointStyle;
  /** True while `intensityRange` is unpinned and grows with each node loaded. */
  private _autoIntensityRange: boolean;
  private _pointSizeMode: PointSizeMode;
  private _colorMode: ColorMode;
  private _classificationFilter: number[] | undefined;
  private _clipMode: ClipMode;

  constructor(
    options: StyleOptions,
    private readonly _requestRender: () => void,
  ) {
    validateSizeBounds(options.minPixelSize, options.maxPixelSize);
    this.style = {
      pixelSize: options.pixelSize,
      sizeMode: SIZE_MODE[options.pointSizeMode],
      attenuationFactor: validateAttenuationFactor(options.attenuationFactor),
      minPixelSize: options.minPixelSize,
      maxPixelSize: options.maxPixelSize,
      colorMode: COLOR_MODE[options.colorMode],
      intensityRange: new Cesium.Cartesian2(options.intensityRange?.[0] ?? 0, options.intensityRange?.[1] ?? 1),
      classMask: buildClassMask(options.classificationFilter),
      heightOffset: 0,
      opacity: validateOpacity(options.opacity),
      clip: createClipState(options.clipPlanes, options.clipBoxes, options.clipMode),
    };
    this._autoIntensityRange = options.intensityRange === undefined;
    this._pointSizeMode = options.pointSizeMode;
    this._colorMode = options.colorMode;
    this._classificationFilter = options.classificationFilter;
    this._clipMode = options.clipMode;
  }

  /** Widens the auto intensity range as nodes arrive; a no-op once pinned. */
  growAutoIntensityRange(maxIntensity: number): void {
    if (!this._autoIntensityRange) return;
    if (maxIntensity <= this.style.intensityRange.y) return;
    this.style.intensityRange.y = maxIntensity;
  }

  get pixelSize(): number {
    return this.style.pixelSize;
  }
  set pixelSize(value: number) {
    this.style.pixelSize = value;
    this._requestRender();
  }

  get pointSizeMode(): PointSizeMode {
    return this._pointSizeMode;
  }
  set pointSizeMode(value: PointSizeMode) {
    this._pointSizeMode = value;
    this.style.sizeMode = SIZE_MODE[value];
    this._requestRender();
  }

  get attenuationFactor(): number {
    return this.style.attenuationFactor;
  }
  set attenuationFactor(value: number) {
    this.style.attenuationFactor = validateAttenuationFactor(value);
    this._requestRender();
  }

  get minPixelSize(): number {
    return this.style.minPixelSize;
  }
  set minPixelSize(value: number) {
    validateSizeBounds(value, this.style.maxPixelSize);
    this.style.minPixelSize = value;
    this._requestRender();
  }

  get maxPixelSize(): number {
    return this.style.maxPixelSize;
  }
  set maxPixelSize(value: number) {
    validateSizeBounds(this.style.minPixelSize, value);
    this.style.maxPixelSize = value;
    this._requestRender();
  }

  get opacity(): number {
    return this.style.opacity;
  }
  set opacity(value: number) {
    this.style.opacity = validateOpacity(value);
    this._requestRender();
  }

  get colorMode(): ColorMode {
    return this._colorMode;
  }
  set colorMode(value: ColorMode) {
    this._colorMode = value;
    this.style.colorMode = COLOR_MODE[value];
    this._requestRender();
  }

  get classificationFilter(): number[] | undefined {
    return this._classificationFilter;
  }
  set classificationFilter(value: number[] | undefined) {
    // Built before either field is assigned, so an out-of-range code throws
    // without leaving the filter half-applied.
    const mask = buildClassMask(value);
    this._classificationFilter = value;
    this.style.classMask = mask;
    this._requestRender();
  }

  get intensityRange(): [number, number] {
    return [this.style.intensityRange.x, this.style.intensityRange.y];
  }
  set intensityRange(value: [number, number] | undefined) {
    this._autoIntensityRange = value === undefined;
    this.style.intensityRange.x = value?.[0] ?? 0;
    this.style.intensityRange.y = value?.[1] ?? 1;
    this._requestRender();
  }

  get heightOffset(): number {
    return this.style.heightOffset;
  }
  set heightOffset(value: number) {
    this.style.heightOffset = value;
    this._requestRender();
  }

  get clipPlanes(): Cesium.Plane[] {
    return this.style.clip.planes.map((plane) => Cesium.Plane.clone(plane));
  }
  set clipPlanes(value: Cesium.Plane[] | undefined) {
    this.style.clip.planes = validateClipPlanes(value);
    this._clipChanged();
  }

  get clipBoxes(): Cesium.Matrix4[] {
    return this.style.clip.boxes.map((box) => Cesium.Matrix4.clone(box));
  }
  set clipBoxes(value: Cesium.Matrix4[] | undefined) {
    setClipBoxes(this.style.clip, value);
    this._clipChanged();
  }

  get clipMode(): ClipMode {
    return this._clipMode;
  }
  set clipMode(value: ClipMode) {
    const mode = validateClipMode(value);
    this._clipMode = value;
    this.style.clip.mode = mode;
    this._clipChanged();
  }

  private _clipChanged(): void {
    this.style.clip.version++;
    this._requestRender();
  }
}
