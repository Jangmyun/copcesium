import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { lazPerfWasmInlinePlugin } from './vite-plugins/lazPerfWasmInline';

// Dev server for examples/dev-viewer, which imports `src/` directly so source
// changes are visible in the browser without publishing or packing. Kept
// separate from vite.config.ts because that one is the library *build* config
// (build.lib, rollupOptions.external) and has no dev server to speak of.
//
// examples/basic-viewer is deliberately not served from here: it is a
// standalone npm project that installs `copcesium` from the registry, which is
// the only way to exercise the published package the way a consumer does.
export default defineConfig({
  root: 'examples/dev-viewer',
  plugins: [cesium(), lazPerfWasmInlinePlugin()],
  // Registered again for the worker sub-build for the same reason as in
  // vite.config.ts: Vite compiles `?worker&inline` entries in an isolated
  // build that does not inherit the top-level `plugins` array, so worker.ts's
  // `virtual:laz-perf-wasm-base64` import would otherwise fail to resolve.
  worker: {
    plugins: () => [lazPerfWasmInlinePlugin()],
  },
});
