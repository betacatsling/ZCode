/**
 * P4：产品 OAuth / JWT 读者卸载，以及 provisioning 不再导出这些键。
 *
 * 旧 credentials.json 可以继续留在磁盘。读取路径必须返回空或不可用，
 * 不能解密这些键，也不能因此发起授权请求或删除凭据文件。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ModelConfigRules,
  ProviderConfigMap,
  type PersonalProviderConfigRepository,
} from "@zcode/provider";
import type { AppSettings } from "@zcode/shared";
import { createFeedbackService } from "../src/feedback/feedbackService.js";
import { resolveBigModelStartPlanZcodeJwt } from "../src/model-provider/bigmodelStartPlanZcodeJwt.js";
import {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
} from "../src/model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";
import type { ProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { setDataBaseDir } from "../src/paths.js";
import { BigModelUsageQuotaProvider } from "../src/usage-stats/providers/bigmodelUsageQuotaProvider.js";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const LEGACY_CREDENTIALS = {
  "oauth:active_provider": 1,
  "oauth:zai:access_token": "not-a-cipher",
  "oauth:zai:refresh_token": "not-a-cipher",
  "oauth:zai:user_info": null,
  "oauth:bigmodel:access_token": "not-a-cipher",
  "oauth:bigmodel:refresh_token": "not-a-cipher",
  "oauth:bigmodel:user_info": { id: "leftover" },
  zcodejwttoken: "leftover-jwt",
  "oauth:login_attribution": '{"channel_id":"legacy"}',
  "account-provider:bigmodel:api-key": "derived-key",
  "personal:example:api-key": "keep-me",
};

function throwingCredentialService() {
  const loads: string[] = [];
  return {
    loads,
    async load(key: string) {
      loads.push(key);
      throw new Error(`unexpected credential read: ${key}`);
    },
    async save(key: string) {
      loads.push(`save:${key}`);
      throw new Error(`unexpected credential save: ${key}`);
    },
    async delete(key: string) {
      loads.push(`delete:${key}`);
      throw new Error(`unexpected credential delete: ${key}`);
    },
  };
}

const IN_READER_FILES = [
  "feedback/feedbackService.ts",
  "model-provider/bigmodelStartPlanZcodeJwt.ts",
  "usage-stats/providers/bigmodelUsageQuotaProvider.ts",
  "node.ts",
  "model-provider/providerProvisioningSource.ts",
  "model-provider/providerProvisioningTarget.ts",
];

test("P4: IN readers do not load product oauth keys", () => {
  const node = readFileSync(join(here, "../src/node.ts"), "utf8");
  const start = node.indexOf("export function createTelemetryUserIdLoader(");
  const end = node.indexOf("export function disposeServiceResources(");
  assert.ok(start >= 0 && end > start);
  const readers = node.slice(start, end);
  assert.doesNotMatch(readers, /credentialService\.load/);
  assert.doesNotMatch(readers, /oauth:active_provider/);
  assert.doesNotMatch(readers, /zcodejwttoken/);
  assert.doesNotMatch(readers, /oauth:zai:/);
  assert.doesNotMatch(readers, /oauth:bigmodel:/);
  assert.doesNotMatch(readers, /oauth:login_attribution/);
  assert.match(readers, /return async \(\) => ""/);
  assert.match(readers, /return async \(\) => null/);
  assert.match(readers, /return "";/);

  for (const rel of IN_READER_FILES) {
    const source = readFileSync(join(here, "../src", rel), "utf8");
    assert.doesNotMatch(source, /\.load\(\s*["'`]zcodejwttoken["'`]/, rel);
    assert.doesNotMatch(source, /\.load\(\s*["'`]oauth:/, rel);
    assert.doesNotMatch(source, /\.load\(\s*`oauth:/, rel);
  }
});

test("P4: oauth credential mutation does not request a provisioning refresh", () => {
  const node = readFileSync(join(here, "../src/node.ts"), "utf8");
  assert.doesNotMatch(node, /PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS/);
  assert.doesNotMatch(node, /isProviderProvisioningAccountCredentialKey/);
  assert.doesNotMatch(node, /onProviderProvisioningSourceChanged\?\.\(\s*"credential"\s*\)/);
  assert.match(node, /createCredentialService\(\)/);
  assert.match(node, /onProviderProvisioningSourceChanged\?\.\(\s*"personal-config"\s*\)/);
  assert.match(node, /onProviderProvisioningSourceChanged\?\.\(\s*"account-settings"\s*\)/);
});

test("P4: feedback list does not read zcodejwttoken or call the feedback API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-p4-feedback-"));
  const previous = process.env.ZCODE_DATA_BASE_DIR;
  setDataBaseDir(dir);
  const credentials = throwingCredentialService();
  const requests: string[] = [];
  try {
    const service = createFeedbackService({
      credentialService: credentials,
      getDeviceMid: () => "device-1",
      apiClient: {
        async request(input) {
          requests.push(String(input));
          throw new Error("feedback auth request fired");
        },
      },
    });
    const listed = await service.list();
    assert.deepEqual(listed, { items: [], total: 0 });
    assert.deepEqual(credentials.loads, []);
    assert.deepEqual(requests, []);
  } finally {
    setDataBaseDir(previous ?? null);
  }
});

test("P4: Start Plan product JWT is unavailable and personal api key still returns", async () => {
  const credentials = throwingCredentialService();
  const personal = await resolveBigModelStartPlanZcodeJwt({
    credentialService: credentials,
    provider: { apiKey: " personal-key " },
    trustCachedZcodeJwt: true,
  });
  assert.equal(personal, "personal-key");
  const unavailable = await resolveBigModelStartPlanZcodeJwt({
    credentialService: credentials,
    trustCachedZcodeJwt: true,
  });
  assert.equal(unavailable, "");
  assert.deepEqual(credentials.loads, []);
});

test("P4: quota reset and team quota do not read oauth keys or fire auth", async () => {
  const credentials = throwingCredentialService();
  const requests: string[] = [];
  const authCalls: string[] = [];
  const provider = new BigModelUsageQuotaProvider({
    apiClient: {
      async request(input) {
        requests.push(String(input));
        throw new Error("quota auth request fired");
      },
    },
    accountRequestAuthService: {
      async resolveAccessCurrent() {
        authCalls.push("resolveAccessCurrent");
        throw new Error("account auth fired");
      },
      async resolveCurrent() {
        authCalls.push("resolveCurrent");
        throw new Error("account auth fired");
      },
      async assertCurrent() {
        authCalls.push("assertCurrent");
        throw new Error("account auth fired");
      },
    },
    credentialService: credentials,
    env: {},
  });

  await assert.rejects(
    () =>
      provider.getCodingPlanResetStatus({
        preferredProviderId: "bigmodel",
        accountAccess: {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "individual-coding-plan",
        },
      }),
    /product_oauth_credential_unavailable/,
  );
  await assert.rejects(
    () =>
      provider.getSnapshotForRequest({
        accountAccess: {
          type: "zhipu-account",
          family: "zai",
          planKind: "team-coding-plan",
          productId: "prod",
          organizationId: "org",
          projectId: "proj",
        },
      }),
    /Coding Plan entitlement refresh failed/,
  );
  assert.deepEqual(credentials.loads, []);
  assert.deepEqual(requests, []);
  assert.deepEqual(authCalls, []);
});

test("P4: new provisioning sync ignores leftover oauth keys and does not erase the store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-p4-provision-"));
  const credentialFilePath = join(dir, "credentials.json");
  const rawCredentials = `${JSON.stringify(LEGACY_CREDENTIALS, null, 2)}\n`;
  await writeFile(credentialFilePath, rawCredentials);
  const personal = {
    revision: "empty",
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
  };
  const personalRepository = {
    async read() {
      return personal;
    },
    onDidChange() {
      return () => {};
    },
    async update(transform) {
      return { ...personal, ...transform(personal), revision: personal.revision };
    },
  } satisfies PersonalProviderConfigRepository;
  const settingService = {
    async get() {
      return {
        providerFamilyDomain: undefined,
        providerFamilyConnectionSelections: {},
      } as AppSettings;
    },
    async update() {},
    async updateDataBaseDir() {},
    async ensureDefaultProject() {
      return { path: dir, created: false };
    },
  };
  let decrypts = 0;
  const source = createProviderProvisioningSource({
    personalRepository,
    settingService,
    credentialFilePath,
    personalConfigFilePath: join(dir, "missing-personal.json"),
    cipherProvider: {
      encrypt() {
        return "";
      },
      decrypt() {
        decrypts += 1;
        throw new Error("decrypt fired");
      },
    },
  });

  const envelope = await source.read("sync-1");
  assert.deepEqual(envelope.credentials, []);
  for (const key of [
    "oauth:active_provider",
    "oauth:zai:access_token",
    "oauth:zai:refresh_token",
    "oauth:zai:user_info",
    "oauth:bigmodel:access_token",
    "oauth:bigmodel:refresh_token",
    "oauth:bigmodel:user_info",
    "zcodejwttoken",
    "account-provider:bigmodel:api-key",
  ]) {
    assert.equal(
      envelope.credentials.some((entry) => entry.key === key),
      false,
      key,
    );
  }
  assert.equal(decrypts, 0);
  assert.deepEqual(await listProviderProvisioningCredentialKeys(credentialFilePath), []);
  assert.equal(await readFile(credentialFilePath, "utf8"), rawCredentials);

  const credentials = throwingCredentialService();
  const target = createProviderProvisioningTarget({
    providerRuntime: {
      async start() {},
      registryService: {
        async refresh() {
          return { sourceRevisions: { config: "config-rev" } };
        },
        validateSelection() {
          return { ok: true };
        },
      },
    } as unknown as ProviderRuntime,
    personalRepository,
    credentialService: credentials,
    settingService,
    personalConfigFilePath: join(dir, "missing-personal.json"),
    stateFilePath: join(dir, "runtime", "provisioning.json"),
    listProvisioningCredentialKeys: () =>
      listProviderProvisioningCredentialKeys(credentialFilePath),
  });
  const result = await target.apply({
    ...envelope,
    credentials: [
      { scope: "oauth-session", key: "oauth:active_provider", value: "zai" },
      { scope: "oauth-session", key: "oauth:zai:access_token", value: "token" },
      { scope: "oauth-session", key: "oauth:bigmodel:user_info", value: "{}" },
      { scope: "oauth-session", key: "zcodejwttoken", value: "jwt" },
      {
        scope: "account-provider",
        key: "account-provider:bigmodel:api-key",
        value: "derived",
      },
    ],
  });
  assert.equal(result.status, "applied");
  assert.equal(result.credentialCount, 0);
  assert.deepEqual(credentials.loads, []);
  assert.equal(await readFile(credentialFilePath, "utf8"), rawCredentials);
});
