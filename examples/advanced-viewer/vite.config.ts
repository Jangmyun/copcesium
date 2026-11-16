/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { resolve } from 'path';
import { lazPerfWasmInlinePlugin } from '../../vite-plugins/lazPerfWasmInline.ts';

// `npm run dev` (default mode) installs `copcesium` from the registry, the
// only way to exercise the published package the way a real consumer does.
//
// `npm run dev:src` (--mode src) instead aliases the `copcesium` import to
// this repo's `src/`, so a source change is visible immediately via Vite HMR
// with no build/pack/publish step. main.ts is unchanged either way — only
// where `copcesium` resolves to differs.
export default defineConfig(({ mode }) => {
  const useSrc = mode === 'src';

  return {
    plugins: useSrc ? [cesium(), lazPerfWasmInlinePlugin()] : [cesium()],
    resolve: useSrc
      ? { alias: { copcesium: resolve(import.meta.dirname, '../../src') } }
      : undefined,
    // Registered again for the worker sub-build for the same reason as in
    // the root vite.config.ts: Vite compiles `?worker&inline` entries in an
    // isolated build that does not inherit the top-level `plugins` array, so
    // worker.ts's `virtual:laz-perf-wasm-base64` import would otherwise fail
    // to resolve when src/ is served directly.
    worker: useSrc ? { plugins: () => [lazPerfWasmInlinePlugin()] } : undefined,
  };
});
