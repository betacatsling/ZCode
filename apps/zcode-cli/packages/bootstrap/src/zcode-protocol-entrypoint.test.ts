import assert from "node:assert/strict";
import { mkdtemp, access, rm, writeFile, mkdir } from "node:fs/promises";
import { ProviderConfigMap, ProviderTemplateMap, ModelConfigRules } from "@zcode/provider";
import { encodeZCodeBuiltinRelease } from "@zcode/provider-node";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runZCodeProtocolAgent } from "./zcode-protocol-entrypoint.js";
import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";

test(
  "default no-DI registry starts with isolated fake config, relative DB, and disposes on detach",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-native-default-"));
    const cwd = join(root, "launch");
    const bundled = join(root, "builtin.json");
    const personal = join(root, "personal.json");
    await mkdir(cwd);
    await writeFile(
      bundled,
      JSON.stringify(
        encodeZCodeBuiltinRelease({
          schemaVersion: 1,
          revision: 1,
          config: {
            providers: ProviderConfigMap.empty(),
            providerTemplates: new ProviderTemplateMap(),
            modelConfigRules: ModelConfigRules.empty(),
          },
        }),
      ),
    );
    const input = new PassThrough();
    const output = new PassThrough();
    const env = {
      ...process.env,
      HOME: root,
      ZCODE_DATA_BASE_DIR: root,
      ZCODE_SESSION_DB_PATH: "sessions.sqlite",
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: bundled,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
      ZCODE_TELEMETRY_ENABLED: "false",
    };
    let outputText = "";
    output.on("data", (chunk: Buffer) => {
      outputText += chunk.toString();
      if (
        outputText.includes('"method":"startup/storageState"') &&
        outputText.includes('"phase":"ready"')
      )
        input.end();
    });
    try {
      await runZCodeProtocolAgent({ cwd, env, input, output });
      await access(join(cwd, "sessions.sqlite"));
      await assert.rejects(access(join(process.cwd(), "sessions.sqlite")));
      assert.match(outputText, /"phase":"ready"/);

      // 修复依据：启动取消恰在异步 Registry 返回前发生时，迟到 runtime 也必须释放；
      // 只测试可信进程 DI，不通过 V4 overlay/账号消息注入 Registry。
      const controller = new AbortController();
      let disposed = 0;
      const failureInput = new PassThrough();
      const failureOutput = new PassThrough();
      await assert.rejects(
        runZCodeProtocolAgent(
          {
            cwd,
            env,
            input: failureInput,
            output: failureOutput,
            lifecycle: { signal: controller.signal, deadlineAt: undefined, requestShutdown() {} },
          },
          {
            startProviderRegistryRuntime: async () => {
              const runtime = await startProcessProviderRegistryRuntime(env);
              controller.abort(new Error("fixture-abort"));
              return {
                ...runtime,
                dispose() {
                  disposed++;
                  runtime.dispose();
                },
              };
            },
          },
        ),
        /fixture-abort/,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(disposed, 1);
      failureInput.destroy();
      failureOutput.destroy();
    } finally {
      input.destroy();
      output.destroy();
      await rm(root, { recursive: true, force: true });
    }
  },
);

// The process cwd deliberately differs from launch cwd; no global chdir or user profile is touched.
test("prepare and normal startup select the same configured relative database at launch cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-native-bootstrap-"));
  const cwd = join(root, "launch");
  const path = join(cwd, "sessions.sqlite");
  const env = {
    ...process.env,
    HOME: root,
    ZCODE_DATA_BASE_DIR: root,
    ZCODE_SESSION_DB_PATH: "sessions.sqlite",
    ZCODE_TELEMETRY_ENABLED: "false",
  };
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    const prepare = runZCodeProtocolAgent({ cwd, env, input, output, prepareStorageOnly: true });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("prepare path not emitted")), 5000);
      output.on("data", () => {
        if (!text.includes('"method":"startup/storagePath"')) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    const pathFrame = text
      .split("\n")
      .map((line) => line && JSON.parse(line))
      .find((frame) => frame?.method === "startup/storagePath");
    assert.equal(pathFrame.params.path, path);
    input.write(JSON.stringify({ method: "startup/storagePathReady", reuse: false }) + "\n");
    await prepare;
    await access(path);

    let factoryCalled = 0;
    await assert.rejects(
      runZCodeProtocolAgent(
        { cwd, env, input: new PassThrough(), output: new PassThrough() },
        {
          startProviderRegistryRuntime: async () => {
            factoryCalled++;
            throw new Error("after-storage-open");
          },
        },
      ),
      /after-storage-open/,
    );
    assert.equal(factoryCalled, 1);
    await access(path);
    await assert.rejects(access(join(process.cwd(), "sessions.sqlite")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
