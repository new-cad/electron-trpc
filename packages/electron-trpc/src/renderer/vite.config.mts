import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    // Importantly, `main` build runs first and empties the out dir
    emptyOutDir: false,
    lib: {
      entry: path.resolve(import.meta.dirname, './index.ts'),
      name: 'electron-trpc',
      formats: ['es', 'cjs'],
      fileName: (format) => ({ es: 'renderer.mjs', cjs: 'renderer.cjs' })[format as 'es' | 'cjs'],
    },
    outDir: path.resolve(import.meta.dirname, '../../dist'),
    rolldownOptions: {
      external: [/^@trpc\//, 'debug'],
    },
  },
});
