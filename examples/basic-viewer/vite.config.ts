import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { resolve } from 'path';

// Default mode uses `copcesium` as installed from the npm registry, which is
// the whole point of this example: it exercises the published package the way a
// consumer does, and is the only place a packaging defect like the worker-404
// in #54 is visible at all.
//
// `npm run dev:src` (vite --mode src) instead resolves `copcesium` to this
// repository's src/, so a source change shows up here immediately without
// publishing or packing. That mode never goes through dist/, so it cannot catch
// build or packaging defects — use the default mode for those.
export default defineConfig(async ({ mode }) => {
  if (mode !== 'src') return { plugins: [cesium()] };

  // Imported only in src mode, so the default config above stays something a
  // consumer could copy verbatim — nothing reaches into this repository.
  const { lazPerfWasmInlinePlugin } = await import('../../vite-plugins/lazPerfWasmInline.ts');

  return {
    plugins: [cesium(), lazPerfWasmInlinePlugin()],
    // Registered again for the worker sub-build for the same reason as in the
    // root vite.config.ts: Vite compiles `?worker&inline` entries in an
    // isolated build that does not inherit the top-level `plugins` array, so
    // worker.ts's `virtual:laz-perf-wasm-base64` import fails to resolve there.
    worker: { plugins: () => [lazPerfWasmInlinePlugin()] },
    resolve: {
      alias: { copcesium: resolve(import.meta.dirname, '../../src/index.ts') },
      // src/ sits outside this project, so its bare imports resolve against the
      // repository root's node_modules while this example's own resolve against
      // its own — two copies of each in one bundle. Cesium is the one that
      // actually breaks: it keeps module-level singletons (ContextLimits), and a
      // second copy leaves them uninitialised, which surfaces as
      // "renderState.lineWidth is out of range" and every point-cloud node being
      // dropped from the frame.
      dedupe: ['cesium', 'copc', 'proj4', 'laz-perf'],
    },
    // src/ is above this project's root, which Vite's dev server would
    // otherwise refuse to serve.
    server: { fs: { allow: [resolve(import.meta.dirname, '../..')] } },
  };
});
