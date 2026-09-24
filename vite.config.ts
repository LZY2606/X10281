import { defineConfig } from 'vite';
import { createApiPlugin } from './src/server/apiPlugin';

export default defineConfig({
  plugins: [createApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5377,
    strictPort: true
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000
  }
});
