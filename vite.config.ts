import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const LAZ_WASM = resolve('node_modules/laz-perf/lib/laz-perf.wasm');

const lazPerfWasmPlugin = {
  name: 'laz-perf-wasm',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      if (req.url?.includes('laz-perf.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
        res.end(readFileSync(LAZ_WASM));
        return;
      }
      next();
    });
  },
  generateBundle() {
    (this as any).emitFile({
      type: 'asset',
      fileName: 'laz-perf.wasm',
      source: readFileSync(LAZ_WASM),
    });
  },
};

export default defineConfig({
  plugins: [cesium(), lazPerfWasmPlugin],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'CopcCesium',
      formats: ['es', 'cjs'],
      fileName: (fmt) => `copc-cesium.${fmt === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['cesium'],
    },
  },
});
