import { defineConfig } from "tsup";

/** Separate ESM build: the server-core banner redeclares __filename in Pi's SDK. */
export default defineConfig({
  entry: { piWorker: "../services/src/agent-adapters/pi/piWorker.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  splitting: false,
  clean: false,
  external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
});
