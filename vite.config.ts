import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { hpackApiPlugin } from "./src/server/vite-plugin.ts";

export default defineConfig({
  plugins: [react(), hpackApiPlugin()],
  server: { host: "127.0.0.1", port: 5377, strictPort: true },
  publicDir: "cases",
});
