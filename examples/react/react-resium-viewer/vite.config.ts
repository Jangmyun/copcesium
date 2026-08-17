import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import { resolve } from 'path';
import { lazPerfWasmInlinePlugin } from '../../../vite-plugins/lazPerfWasmInline.ts';

// `npm run dev` (default mode) installs `copcesium` from the registry, the
// only way to exercise the published package the way a real consumer does.
//
// `npm run dev:src` (--mode src) instead aliases the `copcesium` import to
// this repo's `src/`, so a source change is visible immediately via Vite HMR
// with no build/pack/publish step. The app code is unchanged either way —
// only where `copcesium` resolves to differs.
export default defineConfig(({ mode }) => {
  const useSrc = mode === 'src';

  return {
    plugins: useSrc ? [react(), cesium(), lazPerfWasmInlinePlugin()] : [react(), cesium()],
    resolve: useSrc
      ? { alias: { copcesium: resolve(import.meta.dirname, '../../../src') } }
      : undefined,
    // Registered again for the worker sub-build for the same reason as in
    // the root vite.config.ts: Vite compiles `?worker&inline` entries in an
    // isolated build that does not inherit the top-level `plugins` array, so
    // worker.ts's `virtual:laz-perf-wasm-base64` import would otherwise fail
    // to resolve when src/ is served directly.
    worker: useSrc ? { plugins: () => [lazPerfWasmInlinePlugin()] } : undefined,
  };
});
