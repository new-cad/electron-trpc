/// <reference types="vitest" />
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**'],
      reporter: ['text', 'cobertura', 'html'],
      reportsDirectory: path.resolve(import.meta.dirname, './coverage/'),
    },
  },
});
