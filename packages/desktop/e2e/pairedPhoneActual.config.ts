import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "pairedPhoneActual.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: "list",
  use: { trace: "off", screenshot: "off" },
});
