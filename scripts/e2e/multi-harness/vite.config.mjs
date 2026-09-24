import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const requireFromWeb = createRequire(resolve(root, "packages/web/package.json"));
const { default: tailwindcss } = await import(
  pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href
);

export default {
  plugins: [tailwindcss()],
  root: resolve(root, "packages/ui/e2e"),
  resolve: {
    alias: { "@": resolve(root, "packages/ui/src") },
  },
  server: { host: "127.0.0.1", port: 4179, strictPort: true },
};
