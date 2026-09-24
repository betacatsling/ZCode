import { defineConfig, devices } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Each invocation owns a new artifact directory; never clean or reuse a person's browser profile.
const artifactBase = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? tmpdir());
if (!process.env.ZCODE_E2E_INTERNAL_RUN_DIR) {
  await mkdir(artifactBase, { recursive: true });
}
const runDir =
  process.env.ZCODE_E2E_INTERNAL_RUN_DIR ?? (await mkdtemp(resolve(artifactBase, "zcode-ui-e2e-")));
process.env.ZCODE_E2E_INTERNAL_RUN_DIR = runDir;
if (!process.env.TEST_WORKER_INDEX) console.log(`[ui-e2e] artifacts: ${runDir}`);

const executablePath = process.env.ZCODE_E2E_CHROMIUM_PATH;

export default defineConfig({
  testDir: "../../../packages/ui/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: resolve(runDir, "report"), open: "never" }]],
  outputDir: resolve(runDir, "results"),
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    launchOptions: executablePath ? { executablePath } : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: {
    command:
      "mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/web exec vite --config ../../scripts/e2e/multi-harness/vite.config.mjs",
    cwd: resolve(import.meta.dirname, "../../.."),
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
