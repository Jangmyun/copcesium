import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { lazPerfWasmInlinePlugin } from './vite-plugins/lazPerfWasmInline';

// This config only builds the library (src/index.ts -> dist/). Example apps
// under examples/ are standalone npm projects with their own vite config,
// consuming the published `copcesium` package rather than this build.
export default defineConfig({
  plugins: [lazPerfWasmInlinePlugin()],
  // worker.ts is imported as `./worker/worker.ts?worker&inline` in
  // CopcDataSource.ts, so it's compiled and embedded as a Blob directly in
  // this build's output rather than emitted as a separate chunk — a
  // consumer's own bundler never sees a static import to trace, so it can't
  // discover or copy an asset it doesn't know exists.
  //
  // Vite bundles worker entries via an isolated sub-build that does not
  // inherit the top-level `plugins` array, so the virtual-module plugin has
  // to be registered here too or `worker.ts`'s `virtual:laz-perf-wasm-base64`
  // import fails to resolve during that sub-build.
  worker: {
    plugins: () => [lazPerfWasmInlinePlugin()],
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'CopcCesium',
      // CJS output is intentionally not built: dynamic Worker construction
      // has no CJS equivalent that works the same way across bundlers. See
      // issue #37.
      formats: ['es'],
      fileName: () => 'copc-cesium.mjs',
    },
    rollupOptions: {
      external: ['cesium'],
    },
  },
  // Vitest reads its config from this file's `test` field, so the library
  // build and the test run share one config rather than two that have to be
  // kept in step.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
