import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The service worker's cache name carries the build time: every build starts a fresh cache and drops the old one. */
const stampServiceWorker = () => ({
  name: "stamp-service-worker",
  apply: "build" as const,
  closeBundle() {
    const file = join(fileURLToPath(new URL(".", import.meta.url)), "dist", "sw.js");
    try {
      writeFileSync(file, readFileSync(file, "utf8").replace("__BUILD__", String(Date.now())));
    } catch {
      // no sw.js in the output: nothing to stamp
    }
  },
});

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), stampServiceWorker()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
