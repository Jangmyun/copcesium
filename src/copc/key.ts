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
  const a = key.indexOf('-');
  const b = key.indexOf('-', a + 1);
  const c = key.indexOf('-', b + 1);
  return [
    Number(key.slice(0, a)),
    Number(key.slice(a + 1, b)),
    Number(key.slice(b + 1, c)),
    Number(key.slice(c + 1)),
  ];
}
