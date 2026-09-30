import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ROOT } from "./source-utils.mjs";

const BASELINE = "f130e1940c0d70ddc71d3fe586fc2a333b9f212e";
const ENTRY = "scripts/verify-product-login-removed.mjs";
const SOURCE_ROOTS = [
  ENTRY,
  "packages/ui/src",
  "packages/shared/src",
  "packages/services/src",
  "packages/desktop/src",
  "packages/web/src",
  "apps/zcode-cli/packages/cli/src",
  "apps/zcode-cli/packages/bootstrap/src",
  "apps/zcode-cli/packages/adapters/src",
  "apps/zcode-cli/packages/i18n/src",
];

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: ROOT, maxBuffer: 100 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${binary} failed: ${result.error ?? result.stderr?.toString()}`);
  return result.stdout;
}

const CASES = [
  ["baseline", null, "", false],
  ["deleted login surface", "packages/ui/src/login/audit.ts", "export {};", true],
  [
    "locale key",
    "packages/ui/src/i18n/locales/audit.ts",
    'export default {"login.useApiKey":"fixture"};',
    true,
  ],
  [
    "provider UI wiring",
    "packages/ui/src/settings/ModelProviderSection.tsx",
    "\nexport const onCodingPlanLogin = () => {};\n",
    true,
  ],
  ["legacy helper", "packages/ui/src/lib/codingPlanOwnedEntryPlans.ts", "export {};", true],
  [
    "shared contract",
    "packages/shared/src/coding-plan-subscription.ts",
    "\nexport type CodingPlanPaypalSupportRequest = {};\n",
    true,
  ],
  [
    "status fields",
    "packages/ui/src/settings/model-provider-section/Detail.tsx",
    "\nexport const loginLoading = false;\n",
    true,
  ],
  [
    "CLI browser side effect",
    "apps/zcode-cli/packages/cli/src/login-command.ts",
    "\nexport function openBrowser() {}\n",
    true,
  ],
  [
    "preserve MCP OAuth",
    "apps/zcode-cli/packages/adapters/src/mcp/oauth.ts",
    "\n// fixture: third-party OAuth remains available\n",
    false,
  ],
];

test("verifier refactor preserves success and rejection behavior", async (t) => {
  // 原脚本是本次结构重排的回归基准；不改写断言来让新脚本通过。
  // 浅克隆缺少该提交时明确失败，先 fetch 归档标签再运行，不把缺基准记作 skip。
  const original = command("git", ["show", `${BASELINE}:${ENTRY}`]);
  const current = await readFile(join(ROOT, ENTRY));
  const fixture = await mkdtemp(join(tmpdir(), "zcode-login-check-parity-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const archive = command("git", ["archive", BASELINE, ...SOURCE_ROOTS]);
  command("tar", ["-xf", "-", "-C", fixture], { input: archive });
  await cp(
    join(ROOT, "scripts/product-login-checks"),
    join(fixture, "scripts/product-login-checks"),
    { recursive: true },
  );

  async function run(source) {
    await writeFile(join(fixture, ENTRY), source);
    const result = spawnSync(process.execPath, [join(fixture, ENTRY)], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    const output = JSON.parse(result.stdout);
    delete output.remainingUiInventory.note;
    return { exit: result.status, output };
  }

  for (const [name, relativePath, addition, shouldFail] of CASES) {
    await t.test(name, async () => {
      const target = relativePath ? join(fixture, relativePath) : null;
      const saved = target
        ? await readFile(target).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          })
        : null;
      if (target) {
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, Buffer.concat([saved ?? Buffer.alloc(0), Buffer.from(addition)]));
      }
      try {
        const before = await run(original);
        const after = await run(current);
        assert.deepEqual(after, before);
        assert.equal(before.exit, shouldFail ? 1 : 0);
      } finally {
        if (target && saved !== null) await writeFile(target, saved);
        else if (target) {
          await rm(target);
          if (relativePath === "packages/ui/src/login/audit.ts")
            await rm(join(fixture, "packages/ui/src/login"), { recursive: true });
        }
      }
    });
  }
});
