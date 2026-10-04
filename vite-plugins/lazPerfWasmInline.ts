/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:laz-perf-wasm-base64';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

const LAZ_PERF_WASM = resolve(
  import.meta.dirname,
  '../node_modules/laz-perf/lib/worker/laz-perf.wasm',
);

/**
 * Embeds laz-perf.wasm as a base64 string, importable as
 * `virtual:laz-perf-wasm-base64`, instead of shipping it as a separate
 * physical asset. worker.ts decodes it and hands the raw bytes to
 * `LazPerf.create({ wasmBinary })`, skipping the emscripten `locateFile`
 * fetch path entirely.
 *
 * This exists so the worker (itself inlined as a Blob via `?worker&inline`)
 * never needs to resolve any URL relative to its own location — a Blob's
 * `import.meta.url` has an opaque origin, so `new URL('x', import.meta.url)`
 * cannot find a same-origin sibling file the way it could from a real
 * emitted chunk. Bundling the wasm into the worker's own source sidesteps
 * that rather than working around it.
 */
export function lazPerfWasmInlinePlugin(): Plugin {
  let cached: string | null = null;
  return {
    name: 'laz-perf-wasm-inline',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },
    load(id) {
      if (id === RESOLVED_ID) {
        cached ??= readFileSync(LAZ_PERF_WASM).toString('base64');
        return `export default ${JSON.stringify(cached)};`;
      }
    },
  };
}
