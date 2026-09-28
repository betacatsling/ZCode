import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@zcode\/services$/,
        replacement: fileURLToPath(new URL("./projectSidebarServicesFixture.ts", import.meta.url)),
      },
      { find: "@", replacement: fileURLToPath(new URL("../../src", import.meta.url)) },
    ],
  },
  esbuild: { jsx: "automatic" },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.SIDEBAR_FIXTURE_PORT ?? 4179),
    strictPort: true,
    proxy: {
      ...(process.env.AGENT_HOST_DRIVER_PORT
        ? { "/__agent-host": `http://127.0.0.1:${process.env.AGENT_HOST_DRIVER_PORT}` }
        : {}),
      ...(process.env.PROJECT_SIDEBAR_DRIVER_PORT
        ? { "/__project-sidebar": `http://127.0.0.1:${process.env.PROJECT_SIDEBAR_DRIVER_PORT}` }
        : {}),
    },
  },
});
