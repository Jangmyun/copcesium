import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { resolve } from 'path';

export default defineConfig(({ command }) => {
  const isLibBuild = command === 'build';

  return {
    plugins: isLibBuild ? [] : [cesium()],
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
  };
});
