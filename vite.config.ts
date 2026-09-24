import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: 5377, strictPort: true },
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
