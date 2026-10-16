/// <reference types="vitest" />
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    lib: {
      entry: path.resolve(import.meta.dirname, './index.ts'),
      name: 'electron-trpc',
      formats: ['es', 'cjs'],
      fileName: (format) => ({ es: 'main.mjs', cjs: 'main.cjs' })[format as 'es' | 'cjs'],
    },
    outDir: path.resolve(import.meta.dirname, '../../dist'),
    rolldownOptions: {
      external: ['electron', /^@trpc\//, 'debug'],
    },
  },
});
