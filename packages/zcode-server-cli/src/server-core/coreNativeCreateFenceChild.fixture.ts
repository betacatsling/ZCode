/* Real Core/CLI/SQLite new-create receipt with a trusted post-effect Git swap observer. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createCoreAuthority } from "@zcode/services/node";
import { IWorkspaceHierarchyService } from "@zcode/services";

const git = promisify(execFile);
const root = process.env.ZCODE_DATA_BASE_DIR!;
const commandId = "native-create-scope-fence";
const mode = process.argv[2];
const mapping = join(
  root,
  ".zcode",
  "v2",
  "native-create",
  `${createHash("sha256").update(commandId).digest("hex")}.mapping.json`,
);
const catalog = join(root, ".zcode", "v2", "workspace-hierarchy", "profile", "catalog.json");
const swapGit = async () => {
  // 中文：仅替换本 fixture 的真实 Git admin；不伪造来源收据/准入证明。
  await rename(join(root, "real-repo", ".git"), join(root, "original-create-git-admin"));
  await git("git", ["-C", join(root, "real-repo"), "init", "-q"]);
};
const bytes = async () => [
  await readFile(mapping).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }),
  await readFile(catalog),
];
let observed = 0;
let core: Awaited<ReturnType<typeof createCoreAuthority>> | undefined;
try {
  core = await createCoreAuthority({
    installationId: "native-mount-fixture",
    profileRoot: root,
    zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
    testOnlyAfterNativeCreateAttempt: async (id) => {
      if (id !== commandId) return;
      observed++;
      if (mode !== "happy" && mode !== "catalog") await swapGit();
    },
    testOnlyAfterNativeMapping: async (id) => {
      if (id === commandId && mode === "catalog") await swapGit();
    },
  });
  await core.reconcileBeforeAdmission();
  const hierarchy = core.services.get(IWorkspaceHierarchyService);
  const request = {
    workspaceId: "workspace",
    harnessId: "zcode",
    commandId,
    modelBinding: {
      kind: "host-managed" as const,
      selection: {
        providerId: "fixture",
        modelId: "fixture-model",
        options: { reasoningLevel: "off" },
      },
    },
  };
  const initial = await bytes();
  if (mode === "happy") {
    const result = await hierarchy.createAgent(request);
    assert.equal(result.owner.kind, "native");
    const after = await bytes();
    assert.ok(after[0]!.length > 0);
    const references = JSON.parse(after[1]!.toString()).nativeReferences as Array<{
      commandId: string;
    }>;
    assert.equal(references.filter((row) => row.commandId === commandId).length, 1);
    assert.equal(observed, 1);
    process.send?.({ type: "nativeCreateFence", mode, observed, references: 1 });
  } else {
    await assert.rejects(hierarchy.createAgent(request));
    assert.equal(observed, 1, "the actual CLI create attempt must complete before the swap");
    const after = await bytes();
    assert.ok(after[1]!.equals(initial[1]!), "scope swap cannot commit Catalog reference");
    if (mode === "catalog") assert.ok(after[0]!.length > 0, "the actual mapping already committed");
    else assert.equal(after[0]!.length, 0, "scope swap cannot commit a mapping");
    const inspected = await hierarchy.inspectCreateCommand({ workspaceId: "workspace", commandId });
    assert.equal(
      inspected.status,
      "completed-unindexed",
      "genuine completed receipt remains recoverable",
    );
    await assert.rejects(hierarchy.createAgent(request));
    assert.ok((await bytes()).every((part, index) => part.equals(after[index]!)));
    process.send?.({ type: "nativeCreateFence", mode, observed, status: inspected.status });
  }
} catch (error) {
  process.send?.({ type: "error", reason: String(error) });
  process.exitCode = 1;
} finally {
  await core?.dispose();
  process.disconnect?.();
}
