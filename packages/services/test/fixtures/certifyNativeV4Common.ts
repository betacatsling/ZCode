import { isAbsolute, join, relative, resolve } from "node:path";
import { stat, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const nativeRepoRoot = resolve(import.meta.dirname, "../../../..");
export const nativeCliPath =
  process.env.ZCODE_CLI_PATH?.trim() ||
  join(nativeRepoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
export const nativeBuiltinProviderConfigPath =
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() ||
  join(nativeRepoRoot, "apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json");
export const nativeClientId = "native-certification-client";
export const nativeFakeProviderId = "native-certification";
export const nativeFakeModelId = "native-fixture-model";
export const nativeFakeKey = "native-fixture-key";
export const nativeFakeOutputTokenLimit = 512;

export interface NativeFetchAudit {
  readonly logicalFetchAttempts: number;
  readonly nativeFetchInvocations: number;
  readonly httpResponses: number;
  readonly httpErrorResponses: number;
  readonly fetchFailures: number;
  readonly cancelledFetches: number;
  readonly blockedBeforeSend: number;
  readonly unknownOutcomes: number;
  readonly routeAttempts: {
    readonly titleSidecar: number;
    readonly providerModel: number;
    readonly auxiliary: number;
    readonly unknown: number;
  };
}

export const nativeExpectedOutput = "native live output\n";

function normalizeShellCommand(command: string): string {
  return command.trim().replaceAll(/[\t\r\n ]+/gu, " ");
}

function shellPathTokens(path: string): string[] {
  const escapedSingle = path.replaceAll("'", "'\\''");
  return [...new Set([path, JSON.stringify(path), `'${escapedSingle}'`])];
}

export function isNativeCheckCommand(command: unknown, workspace: string): boolean {
  if (typeof command !== "string") return false;
  const absoluteWorkspace = resolve(workspace);
  const absoluteCheck = join(absoluteWorkspace, "check.mjs");
  const checkPaths = ["check.mjs", "./check.mjs", ...shellPathTokens(absoluteCheck)];
  const candidates = new Set(checkPaths.map((checkPath) => `node ${checkPath}`));
  for (const directory of shellPathTokens(absoluteWorkspace)) {
    for (const checkPath of ["check.mjs", "./check.mjs"]) {
      candidates.add(`cd ${directory} && node ${checkPath}`);
    }
  }
  return candidates.has(normalizeShellCommand(command));
}

export function nativeFixtureRelativePath(path: unknown, workspace: string): string | undefined {
  if (typeof path !== "string") return undefined;
  const root = resolve(workspace);
  const target = resolve(root, path);
  const relativePath = relative(root, target);
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath
    : undefined;
}

export function createNativeCheckScript(
  workspace: string,
  markerPath: string,
  nonce: string,
): string {
  const outputPath = join(workspace, "output.txt");
  return [
    'import { readFile, writeFile } from "node:fs/promises";',
    `const outputPath = ${JSON.stringify(outputPath)};`,
    `const markerPath = ${JSON.stringify(markerPath)};`,
    `const expectedNonce = ${JSON.stringify(nonce)};`,
    `const expectedOutput = ${JSON.stringify(nativeExpectedOutput)};`,
    'const output = await readFile(outputPath, "utf8");',
    'if (output !== expectedOutput) throw new Error("native fixture output did not match");',
    'await writeFile(markerPath, `${expectedNonce}\\n`, { flag: "wx", mode: 0o600 });',
    "",
  ].join("\n");
}

export async function prepareNativeFetchGuard(
  root: string,
  maxRequests: number,
  allowedOrigin?: string,
): Promise<{ nodeOptions: string; auditPath: string }> {
  const preloadPath = join(root, "native-fetch-guard.mjs");
  const auditPath = join(root, "native-fetch-audit.jsonl");
  const source = [
    'import { appendFile } from "node:fs/promises";',
    `const auditPath = ${JSON.stringify(auditPath)};`,
    `const maxRequests = ${maxRequests};`,
    `const allowedOrigin = ${JSON.stringify(allowedOrigin)};`,
    'const titleMarker = "Generate a concise title for this coding session.";',
    "let attempt = 0;",
    "let writes = Promise.resolve();",
    "const record = (value) => { writes = writes.then(() => appendFile(auditPath, `${JSON.stringify(value)}\\n`, { mode: 0o600 })); return writes; };",
    "const nativeFetch = globalThis.fetch;",
    'if (typeof nativeFetch !== "function") throw new Error("native fetch guard has no global fetch");',
    "globalThis.fetch = async (input, init) => {",
    "  const request = ++attempt;",
    "  const target = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);",
    '  let routeClass = "unknown";',
    "  try {",
    "    const pathname = new URL(target).pathname;",
    '    if (typeof init?.body === "string" && init.body.includes(titleMarker)) routeClass = "title-sidecar";',
    '    else if (pathname.endsWith("/chat/completions") || pathname.endsWith("/messages")) routeClass = "provider-model";',
    '    else routeClass = "auxiliary";',
    "  } catch {}",
    '  await record({ request, result: "logical-attempt", routeClass });',
    "  if (allowedOrigin) {",
    "    let targetOrigin;",
    "    try { targetOrigin = new URL(target).origin; } catch { targetOrigin = undefined; }",
    "    if (targetOrigin !== allowedOrigin) {",
    '      await record({ request, result: "blocked-before-send", reason: "origin" });',
    '      throw new Error("native fake fetch guard blocked a non-fixture origin");',
    "    }",
    "  }",
    "  if (request > maxRequests) {",
    '    await record({ request, result: "blocked-before-send" });',
    '    throw new Error("native Provider request guard blocked an over-limit send");',
    "  }",
    '  await record({ request, result: "native-fetch-invoked" });',
    "  try {",
    "    const response = await nativeFetch(input, init);",
    '    await record({ request, result: "http-response", status: response.status });',
    "    return response;",
    "  } catch (error) {",
    '    const signal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);',
    '    const cancelled = signal?.aborted === true || (error && typeof error === "object" && "name" in error && error.name === "AbortError");',
    '    await record({ request, result: cancelled ? "fetch-cancelled" : "fetch-failed" });',
    "    throw error;",
    "  }",
    "};",
  ].join("\n");
  await writeFile(preloadPath, `${source}\n`, { mode: 0o600 });
  return { nodeOptions: `--import=${pathToFileURL(preloadPath).href}`, auditPath };
}

export async function readNativeFetchAudit(path: string): Promise<NativeFetchAudit> {
  const rows = (
    await readFile(path, "utf8").catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return "";
      throw error;
    })
  )
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          request?: number;
          result: string;
          status?: number;
          routeClass?: string;
        },
    );
  const attemptRows = rows.filter((row) => row.result === "logical-attempt");
  const attempts = attemptRows.length;
  const invocations = rows.filter((row) => row.result === "native-fetch-invoked").length;
  const responses = rows.filter((row) => row.result === "http-response");
  const failures = rows.filter((row) => row.result === "fetch-failed").length;
  const cancellations = rows.filter((row) => row.result === "fetch-cancelled").length;
  const blocked = rows.filter((row) => row.result === "blocked-before-send").length;
  const terminalRows = rows.filter(
    (row) =>
      row.result === "http-response" ||
      row.result === "fetch-failed" ||
      row.result === "fetch-cancelled" ||
      row.result === "blocked-before-send",
  );
  const terminalRequests = new Set(
    terminalRows
      .filter((row): row is typeof row & { request: number } => typeof row.request === "number")
      .map((row) => row.request),
  );
  const terminalRowsWithoutRequest = terminalRows.filter(
    (row) => typeof row.request !== "number",
  ).length;
  const routeAttempts = {
    titleSidecar: attemptRows.filter((row) => row.routeClass === "title-sidecar").length,
    providerModel: attemptRows.filter((row) => row.routeClass === "provider-model").length,
    auxiliary: attemptRows.filter((row) => row.routeClass === "auxiliary").length,
    unknown: attemptRows.filter(
      (row) =>
        row.routeClass !== "title-sidecar" &&
        row.routeClass !== "provider-model" &&
        row.routeClass !== "auxiliary",
    ).length,
  };
  return {
    logicalFetchAttempts: attempts,
    nativeFetchInvocations: invocations,
    httpResponses: responses.length,
    httpErrorResponses: responses.filter((row) => (row.status ?? 0) >= 400).length,
    fetchFailures: failures,
    cancelledFetches: cancellations,
    blockedBeforeSend: blocked,
    unknownOutcomes: Math.max(0, attempts - terminalRequests.size - terminalRowsWithoutRequest),
    routeAttempts,
  };
}

export interface NativeConfigModel {
  readonly id: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface NativeProviderMetadata {
  readonly api?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly authHeader?: boolean;
  readonly headers?: Record<string, string>;
  readonly models?: readonly NativeConfigModel[];
}

export async function writeNativeFakeProviderConfig(root: string, port: number): Promise<string> {
  const path = join(root, "provider-config.json");
  const config = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: nativeFakeProviderId,
            providerName: "Native certification fixture",
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: nativeFakeKey },
              api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
              personalModelIds: [nativeFakeModelId],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            providerId: nativeFakeProviderId,
            modelId: nativeFakeModelId,
            config: {
              enabled: true,
              properties: {
                requiresMfjsToolSchema: false,
                contextWindow: 16_000,
                inputFormat: {
                  supportsText: true,
                  supportsImage: false,
                  supportsVideo: false,
                  supportsAudio: false,
                  supportsPdf: false,
                },
                outputFormat: { supportsText: true },
                supportsToolCall: true,
                supportsJsonSchemaOutput: false,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: true,
              },
              optionSpecs: {
                reasoningLevel: { values: ["off"], map: '{"reasoning_effort": "none"}' },
                maxOutputTokens: {
                  max: nativeFakeOutputTokenLimit,
                  map: '{"max_tokens": maxOutputTokens}',
                },
              },
            },
          },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: nativeFakeProviderId,
        modelId: nativeFakeModelId,
        options: { reasoningLevel: "off" },
      },
    },
  };
  await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  if (((await stat(path)).mode & 0o777) !== 0o600)
    throw new Error("native fake Provider Config must be mode 0600");
  return path;
}
