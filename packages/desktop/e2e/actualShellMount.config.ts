import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "actualShellMount.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  use: { trace: "off", screenshot: "off" },
});
