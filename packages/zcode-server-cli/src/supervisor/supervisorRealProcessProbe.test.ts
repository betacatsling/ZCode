import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// One actual public-factory worker per disposable profile; no synthetic Core or provider call.
test(
  "public factory native/external census and real freeze diagnose missing idle lease",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "supervisor-probe-"));
    const provider = join(dir, "builtin.json");
    const profile = join(dir, "install");
    const fixture = fileURLToPath(
      new URL("./supervisorRealProcessProbe.fixture.ts", import.meta.url),
    );
    let child: ReturnType<typeof fork> | undefined;
    let closed: Promise<void> | undefined;
    try {
      await writeFile(
        provider,
        JSON.stringify({
          schemaVersion: 1,
          revision: 0,
          config: {
            providerConfigRules: { templateRules: [], providerRules: [] },
            modelConfigRules: {
              modelRules: [],
              modelApiRules: [],
              providerSiteRules: [],
              templateModelRules: [],
              builtinProviderModelRules: [],
            },
          },
        }),
      );
      child = fork(fixture, [], {
        execPath: process.execPath,
        execArgv: ["--import", import.meta.resolve("tsx")],
        env: {
          ...process.env,
          HOME: dir,
          XDG_CONFIG_HOME: join(dir, "config"),
          ZCODE_DATA_BASE_DIR: dir,
          ZCODE_SERVER_ROOT: profile,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      child.stderr?.on("data", (part: Buffer) => {
        stderr += part.toString().replaceAll(dir, "<profile>");
      });
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`probe timeout: ${stderr}`)), 20_000);
        child!.once("message", (message: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(message);
        });
        child!.once("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`probe close ${code}: ${stderr}`));
        });
      });
      // Structured failure is printed for diagnosis, but the regression must stay RED if freeze fails.
      assert.equal(result.type, "probe", JSON.stringify(result));
      assert.equal(result.frozen, true, JSON.stringify(result));
      assert.deepEqual(
        result.after,
        {
          native: { running: 0, waiting: 0, uncertain: 0 },
          external: { running: 0, waiting: 0, uncertain: 0 },
        },
        JSON.stringify(result),
      );
      assert.equal(result.released, true, JSON.stringify(result));
      process.stdout.write(
        `public factory census: ${JSON.stringify({ before: result.before, after: result.after, frozen: result.frozen, released: result.released })}\n`,
      );
    } finally {
      if (child && child.exitCode === null) child.kill("SIGTERM");
      if (child && closed) {
        const settled = await Promise.race([
          closed.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
        ]);
        if (!settled) {
          child.kill("SIGKILL");
          await closed;
        }
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    }
  },
);
