import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  define: {
    "import.meta.env.VITE_DAEDALUS_BUILD_ID": JSON.stringify(
      process.env.DAEDALUS_BUILD_ID ?? "local",
    ),
  },
  plugins: [react()],
  build: { outDir: "dist/client" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/events": { target: "ws://127.0.0.1:8787", ws: true },
      "/mcp": "http://127.0.0.1:8787",
    },
  },
});
