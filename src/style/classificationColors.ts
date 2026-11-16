/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * ASPRS standard LAS classification codes and the colour each is drawn in.
 *
 * Shared deliberately: the worker uses it for the CPU fallback when a file
 * carries no RGB, and renderer/shaders.ts generates the GLSL lookup for
 * `colorMode: 'classification'` from the same entries. Keeping one table means
 * the palette can't drift between the two paths.
 */
export const CLASSIFICATION_COLORS: Record<number, [number, number, number]> = {
  2: [153, 111, 66], // Ground
  3: [90, 156, 68], // Low Vegetation
  4: [70, 133, 53], // Medium Vegetation
  5: [50, 110, 38], // High Vegetation
  6: [219, 141, 51], // Building
  9: [59, 121, 191], // Water
  10: [140, 140, 140], // Rail
  11: [100, 100, 100], // Road Surface
};

/** Colour for a classification code the table above doesn't cover. */
export const DEFAULT_CLASS_COLOR: [number, number, number] = [190, 190, 190];
