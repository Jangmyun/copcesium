/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/** Parses a COPC hierarchy node key ("D-X-Y-Z") into its four integer components. */
export function parseKey(key: string): [number, number, number, number] {
  return key.split('-').map(Number) as [number, number, number, number];
}
