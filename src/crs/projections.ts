/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { EPSG_TABLE } from './epsgTable';

/**
 * Looks up a proj4 definition string from the local table by EPSG code.
 * @param code  EPSG code (number or string)
 */
export function lookupEpsg(code: string | number): string | null {
  return EPSG_TABLE[parseInt(String(code), 10)] ?? null;
}
