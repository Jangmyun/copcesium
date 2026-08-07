import { defineConfig } from 'vitest/config';
import { lazPerfWasmInlinePlugin } from './vite-plugins/lazPerfWasmInline';

export default defineConfig({
  plugins: [lazPerfWasmInlinePlugin()],
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
