import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  agentHostSessionMetadataSchema,
  parseCompatibleSessionSpec,
  projectSchema,
  compatibleSessionSpecSchema,
  sessionHierarchyFileSchema,
} from "@zcode/shared/agent-host";
import { MODEL_GATEWAY_VERSION } from "../../model-gateway/contract.js";
import { CLAUDE_CODE_ADAPTER_VERSION } from "../../agent-adapters/claude-code/claudeCodeVersion.js";
import { PINNED_CODEX_CLI_VERSION } from "../../agent-adapters/codex/codexExecutable.js";
import { PINNED_CLAUDE_CLI_VERSION } from "../../agent-adapters/claude/claudeExecutable.js";
import { ZCODE_ADAPTER_VERSION } from "../../agent-adapters/zcode/zcodeHarnessAdapter.js";
import {
  ACP_ADAPTER_VERSION,
  ACP_OFFERED_PROTOCOL_VERSION,
  ACP_STABLE_PROTOCOL_VERSION,
} from "../../agent-adapters/acp/acpProtocol.js";
import { readLegacyZCodeSession } from "../sessionRouter.js";
import { RELEASE_ACCEPTANCE, RELEASE_CONTRACT_LOCK } from "./versionLock.js";
import { assertIsolatedDrillRoot } from "./drillRoot.js";
import { nativeReplayIds } from "./nativeReplay.js";
import {
  backupNativeSessions,
  externalSessionsPath,
  nativeSessionsPath,
  readExternalSidecar,
  readNativeSessions,
  rollbackNativeSessions,
  writeExternalSidecar,
  writeNativeSessions,
} from "./upgradeRollback.js";
import { MacLocalFakeTransport } from "./macLocalFakeTransport.js";

const ITERATIONS = 40;
const here = fileURLToPath(new URL(".", import.meta.url));

const nativeRecord = {
  sessionId: "native-1",
  taskId: "native-1",
  workspaceId: "ws-mac",
};

const externalRecord = {
  sessionId: "ext-pi-1",
  taskId: "ext-pi-1",
  workspaceId: "ws-mac",
  harnessId: "pi",
  agentHost: {
    schemaVersion: 1 as const,
    harnessId: "pi",
    targetId: "local-mac",
    hostSessionId: "ext-pi-1",
    modelBindingKind: "harness-managed" as const,
  },
};

async function drillRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zcode-mac-release-"));
}

test("锁定合成已依赖的契约版本", async () => {
  assert.equal(RELEASE_CONTRACT_LOCK.modelGateway, "0.3.0");
  assert.equal(RELEASE_CONTRACT_LOCK.modelGateway, MODEL_GATEWAY_VERSION);
  assert.equal(RELEASE_CONTRACT_LOCK.codexCliProbe, "codex-cli 0.157.1");
  assert.equal(RELEASE_CONTRACT_LOCK.codexCliProbe, PINNED_CODEX_CLI_VERSION);
  assert.equal(RELEASE_CONTRACT_LOCK.claudeCodeAdapter, "0.1.0");
  assert.equal(RELEASE_CONTRACT_LOCK.claudeCodeAdapter, CLAUDE_CODE_ADAPTER_VERSION);
  assert.equal(RELEASE_CONTRACT_LOCK.claudeCli, "2.1.263");
  assert.equal(RELEASE_CONTRACT_LOCK.claudeCli, PINNED_CLAUDE_CLI_VERSION);
  assert.equal(RELEASE_CONTRACT_LOCK.zcodeAdapter, "native-v4");
  assert.equal(RELEASE_CONTRACT_LOCK.zcodeAdapter, ZCODE_ADAPTER_VERSION);
  assert.equal(RELEASE_CONTRACT_LOCK.acpAdapter, "0.1.0");
  assert.equal(RELEASE_CONTRACT_LOCK.acpAdapter, ACP_ADAPTER_VERSION);
  assert.equal(RELEASE_CONTRACT_LOCK.acpStableProtocol, 1);
  assert.equal(RELEASE_CONTRACT_LOCK.acpStableProtocol, ACP_STABLE_PROTOCOL_VERSION);
  assert.equal(RELEASE_CONTRACT_LOCK.acpOfferedProtocol, 2);
  assert.equal(RELEASE_CONTRACT_LOCK.acpOfferedProtocol, ACP_OFFERED_PROTOCOL_VERSION);
  assert.deepEqual(RELEASE_CONTRACT_LOCK.sessionSpecVersions, [1, 2]);
  assert.equal(RELEASE_CONTRACT_LOCK.sessionMetadataSchemaVersion, 1);
  assert.equal(RELEASE_CONTRACT_LOCK.sessionHierarchySchemaVersion, 1);
  assert.equal(RELEASE_CONTRACT_LOCK.projectSchemaVersion, 1);
  assert.equal(RELEASE_CONTRACT_LOCK.v4WireProtocol, 3);
  assert.equal(RELEASE_CONTRACT_LOCK.zcodeProtocol, 1);
  assert.equal(RELEASE_CONTRACT_LOCK.codexAdapter, "0.157.1");
  assert.equal(RELEASE_CONTRACT_LOCK.piAdapter, "0.87.1");
  assert.equal(RELEASE_CONTRACT_LOCK.piSdk, "0.87.1");

  const [servicesPackage, codexAdapter, piAdapter, v4Core, protocolIndex] = await Promise.all([
    readFile(join(here, "../../../package.json"), "utf8"),
    readFile(join(here, "../../agent-adapters/codex/codexHarnessAdapter.ts"), "utf8"),
    readFile(join(here, "../../agent-adapters/pi/piHarnessAdapter.ts"), "utf8"),
    readFile(join(here, "../../../../../packages/shared/src/zcode-protocol-v4/core.ts"), "utf8"),
    readFile(join(here, "../../../../../packages/shared/src/zcode-protocol/index.ts"), "utf8"),
  ]);
  const pkg = JSON.parse(servicesPackage) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies["@earendil-works/pi-ai"], RELEASE_CONTRACT_LOCK.piSdk);
  assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], RELEASE_CONTRACT_LOCK.piSdk);
  assert.match(codexAdapter, /readonly version = "0\.157\.1"/);
  assert.match(piAdapter, /readonly version = "0\.87\.1"/);
  assert.match(v4Core, /V4_WIRE_PROTOCOL_VERSION = 3/);
  assert.match(protocolIndex, /ZCODE_PROTOCOL_VERSION = 1/);
  assert.match(protocolIndex, /ZCODE_PROTOCOL_V4_WIRE_VERSION = 3/);

  const spec = parseCompatibleSessionSpec({
    schemaVersion: 1,
    hostSessionId: "host-1",
    execution: {
      targetId: "local-mac",
      workspaceIdentity: "workspace-1",
      worktreePath: "/tmp/demo",
    },
    harness: { id: "pi", adapterVersion: RELEASE_CONTRACT_LOCK.piAdapter },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  });
  assert.equal(spec.schemaVersion, 1);
  assert.equal(
    compatibleSessionSpecSchema.safeParse({ schemaVersion: 3, hostSessionId: "host-1" }).success,
    false,
  );
  assert.equal(
    agentHostSessionMetadataSchema.safeParse({
      schemaVersion: RELEASE_CONTRACT_LOCK.sessionMetadataSchemaVersion,
      harnessId: "pi",
      targetId: "local-mac",
      hostSessionId: "ext-pi-1",
      modelBindingKind: "harness-managed",
    }).success,
    true,
  );
  assert.equal(
    agentHostSessionMetadataSchema.safeParse({ schemaVersion: 2, harnessId: "pi" }).success,
    false,
  );
  assert.equal(projectSchema.shape.schemaVersion.value, RELEASE_CONTRACT_LOCK.projectSchemaVersion);
  assert.equal(
    sessionHierarchyFileSchema.shape.schemaVersion.value,
    RELEASE_CONTRACT_LOCK.sessionHierarchySchemaVersion,
  );
});

test("验收目标只有 macOS 本机 launchd", async () => {
  assert.deepEqual(RELEASE_ACCEPTANCE, {
    os: "darwin",
    supervisor: "launchd",
    scope: "local-mac",
  });
  const source = await readFile(join(here, "macLocalFakeTransport.ts"), "utf8");
  assert.equal(source.includes("systemd"), false);
  assert.equal(source.includes("win32"), false);
  assert.equal(source.includes("WSL"), false);
  assert.equal(source.includes("sshd"), false);
  assert.equal(source.includes("createServer"), false);
});

test("演练目录必须落在临时目录", () => {
  const root = join(tmpdir(), "zcode-mac-release-guard");
  assert.equal(assertIsolatedDrillRoot(root), root);
  assert.throws(() => assertIsolatedDrillRoot(join(root, ".ssh")), /drill-refuses-credential-path/);
  assert.throws(
    () => assertIsolatedDrillRoot("/home/ubuntu"),
    /drill-refuses-user-home|drill-root-must-be-under-tmpdir/,
  );
});

test("macOS 本机临时目录回滚后旧程序不重放外部会话", async () => {
  const root = await drillRoot();
  try {
    await writeNativeSessions(root, [nativeRecord]);
    const before = await readFile(nativeSessionsPath(root));
    await backupNativeSessions(root);
    await writeExternalSidecar(root, [externalRecord]);
    assert.deepEqual(await readFile(nativeSessionsPath(root)), before);
    assert.deepEqual(nativeReplayIds(await readNativeSessions(root)), ["native-1"]);
    const sidecar = await readExternalSidecar(root);
    assert.equal(readLegacyZCodeSession(sidecar[0]).kind, "external");
    assert.deepEqual(nativeReplayIds(sidecar), []);
    assert.deepEqual(nativeReplayIds([nativeRecord, externalRecord]), ["native-1"]);

    await assert.rejects(
      writeNativeSessions(root, [nativeRecord, externalRecord]),
      /external-session-not-native/,
    );
    assert.deepEqual(await readFile(nativeSessionsPath(root)), before);

    await writeFile(
      nativeSessionsPath(root),
      `${JSON.stringify([nativeRecord, { sessionId: "ext-smuggled", taskId: "ext-smuggled" }])}\n`,
    );
    assert.deepEqual(nativeReplayIds(await readNativeSessions(root)), ["native-1", "ext-smuggled"]);
    await rollbackNativeSessions(root);
    assert.deepEqual(await readFile(nativeSessionsPath(root)), before);
    assert.deepEqual(nativeReplayIds(await readNativeSessions(root)), ["native-1"]);
    assert.equal(
      await readFile(externalSessionsPath(root), "utf8").then((text) => text.includes("ext-pi-1")),
      true,
    );
    assert.equal(nativeReplayIds(await readNativeSessions(root)).includes("ext-pi-1"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("未知字段不会写入原生会话文件", async () => {
  const root = await drillRoot();
  try {
    await writeNativeSessions(root, [nativeRecord]);
    const before = await readFile(nativeSessionsPath(root));
    await assert.rejects(
      writeNativeSessions(root, [{ ...nativeRecord, futureField: true }]),
      /unrecognized|Unrecognized|invalid|strict/i,
    );
    assert.deepEqual(await readFile(nativeSessionsPath(root)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS 本机假传输下同工作区多会话断线不重放 prompt", async () => {
  const root = await drillRoot();
  try {
    const transport = new MacLocalFakeTransport(root);
    assert.deepEqual(transport.acceptance, RELEASE_ACCEPTANCE);
    const ids = ["host-a", "host-b", "host-c"] as const;
    for (const hostSessionId of ids) {
      await transport.createSession({
        hostSessionId,
        workspaceId: "ws-mac",
        harnessId: "pi",
      });
      const accepted = await transport.sendPrompt(hostSessionId, "do not replay this prompt");
      assert.equal(accepted.status, "accepted");
    }
    for (let i = 0; i < ITERATIONS; i += 1) {
      await transport.disconnect();
      for (const session of transport.listSessions()) {
        assert.equal(session.workspaceId, "ws-mac");
        assert.equal(session.activity, "running");
        assert.equal(session.lastTurn, "unknown");
        assert.equal(session.dispatched, 1);
      }
      await transport.reconnect();
      for (const hostSessionId of ids) {
        const again = await transport.sendPrompt(hostSessionId, "do not replay this prompt");
        assert.equal(again.status, "duplicate");
        assert.equal(transport.queryPrompt(hostSessionId)?.status, "execution-unknown");
      }
    }
    assert.equal(transport.listSessions().length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS 本机假传输下删除期间拒绝新会话", async () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const root = await drillRoot();
    try {
      const transport = new MacLocalFakeTransport(root);
      await transport.createSession({
        hostSessionId: "keep-me",
        workspaceId: "ws-mac",
        harnessId: "pi",
      });
      transport.beginDelete();
      await assert.rejects(
        transport.createSession({
          hostSessionId: "new-during-delete",
          workspaceId: "ws-mac",
          harnessId: "codex",
        }),
        /deletion-admission-rejected/,
      );
      assert.deepEqual(
        transport.listSessions().map((session) => session.hostSessionId),
        ["keep-me"],
      );
      assert.equal(transport.listSessions()[0]?.activity, "running");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
