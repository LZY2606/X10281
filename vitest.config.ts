import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000
  }
});
