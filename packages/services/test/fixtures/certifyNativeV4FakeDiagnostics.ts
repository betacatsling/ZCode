import { stat } from "node:fs/promises";
import { join } from "node:path";
import { objectRecord } from "./certifyNativeV4FakeProtocol.js";
import type { FakeModelRequest } from "./certifyNativeV4FakeGateway.js";
import type { NativeFetchAudit } from "./certifyNativeV4Common.js";
import type { ChildCleanupResult } from "./certifyNativeV4FakeProcess.js";
import type { NativeFakeScenarioResult } from "./certifyNativeV4FakeScenarios.js";

export function summarizeFakeRequests(requests: readonly FakeModelRequest[]): unknown[] {
  return requests.map((request) => {
    const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
    return {
      scenario: request.scenario,
      fixtureTurnId: request.fixtureTurnId,
      stage: request.stage,
      path: request.path,
      outcome: request.outcome,
      settled: request.settled,
      messages: messages
        .map((message) => {
          const record = objectRecord(message);
          if (!record) return { role: "invalid" };
          const calls = Array.isArray(record.tool_calls)
            ? record.tool_calls.map((call) => objectRecord(objectRecord(call)?.function)?.name)
            : [];
          return {
            role: record.role,
            toolNames: calls,
          };
        })
        .filter((message) => message.role !== "system"),
    };
  });
}

export async function nativeFakeWorkspaceFiles(workspace: string): Promise<string[]> {
  const fixtures = [
    "output.txt",
    "check.mjs",
    ".native-check-success",
    "../native-denied-sentinel.txt",
  ];
  return Promise.all(
    fixtures.map(async (name) => {
      try {
        await stat(join(workspace, name));
        return `${name === "../native-denied-sentinel.txt" ? "denied-sentinel-outside-fixture" : name}:present`;
      } catch {
        return `${name === "../native-denied-sentinel.txt" ? "denied-sentinel-outside-fixture" : name}:absent`;
      }
    }),
  );
}

export function requestHasFunctionTools(request: FakeModelRequest): boolean {
  return (
    Array.isArray(request.body.tools) &&
    request.body.tools.some((tool) => objectRecord(tool)?.type === "function")
  );
}

export function safeFakeFailureClass(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const errorType =
    error instanceof Error &&
    ["AssertionError", "Error", "RangeError", "TypeError", "ZodError"].includes(error.name)
      ? error.name
      : "OtherError";
  const errorRecord = objectRecord(error);
  const errorCode =
    typeof errorRecord?.code === "number"
      ? String(errorRecord.code)
      : typeof errorRecord?.code === "string" && /^[A-Z0-9_.-]{1,32}$/u.test(errorRecord.code)
        ? errorRecord.code
        : "no-code";
  const diagnosticCode = `${errorType}:${errorCode}`;
  if (message.includes("outside its exact scenario operations")) return "scope-rejected";
  if (message.includes("missing-output") || message.includes("required outcomes"))
    return "required-outcome";
  if (message.includes("maxoutputtokens") || message.includes("max_tokens"))
    return `output-budget-rejected:${diagnosticCode}`;
  if (message.includes("invalid params") || message.includes("schema validation"))
    return `protocol-validation:${diagnosticCode}`;
  if (message.includes("timeout") || message.includes("did not advance")) return "timeout";
  if (error instanceof Error && error.name === "AssertionError")
    return `assertion:${diagnosticCode}`;
  return `fixture-error:${diagnosticCode}`;
}

export function buildNativeFakeReport(options: {
  readonly actualNodeVersion: string;
  readonly cliArtifactSha256: string;
  readonly spawnPid: number | undefined;
  readonly cleanup: ChildCleanupResult;
  readonly childProcessClosed: boolean;
  readonly isolatedRootRemoved: boolean;
  readonly cleanupFailed: boolean;
  readonly source: "fake-provider";
  readonly scenarioResults: readonly NativeFakeScenarioResult[];
  readonly fakeGatewayRequests: number;
  readonly fetchAudit: NativeFetchAudit;
  readonly resolutionCount: number;
  readonly deniedPathAbsent: boolean;
  readonly runFailure: string | undefined;
  readonly failureContext: unknown;
}): { readonly status: "native-v4-fake-pass" | "native-v4-fake-failed"; readonly report: unknown } {
  const status =
    options.runFailure ||
    !options.cleanup.normal ||
    options.cleanupFailed ||
    !options.childProcessClosed ||
    !options.isolatedRootRemoved
      ? "native-v4-fake-failed"
      : "native-v4-fake-pass";
  return {
    status,
    report: {
      status,
      actualNodeVersion: options.actualNodeVersion,
      cliArtifactSha256: options.cliArtifactSha256,
      spawnPid: options.spawnPid ?? null,
      cleanup: {
        exitCode: options.cleanup.exitCode,
        signal: options.cleanup.signal,
        normal: options.cleanup.normal,
        childProcessClosed: options.childProcessClosed,
        isolatedRootRemoved: options.isolatedRootRemoved,
        forcedTermination: options.cleanup.forcedTermination,
        transportCleanupFailed: Boolean(options.cleanup.transportCleanupError),
      },
      source: options.source,
      scenario: "read-write-check-terminal-followup-accept-deny-stop-history",
      scenarios: options.scenarioResults.map((result) => ({
        fixtureTurnId: result.fixtureTurnId,
        turnId: result.turnId,
        diagnosticLogEpoch: result.diagnosticLogEpoch,
        historyRows: result.rows.length,
        ...(result.diagnostics ? { toolDiagnostics: result.diagnostics } : {}),
      })),
      fakeGatewayRequests: options.fakeGatewayRequests,
      attemptAudit: options.fetchAudit,
      resolutions: options.resolutionCount,
      checkMarker: options.scenarioResults.length > 0 ? "unique-nonce-verified" : "not-verified",
      workspaceIsolation: true,
      offlineSafetyEvidence: {
        recoverableMissingOutputRead: options.scenarioResults[0]?.diagnostics?.some(
          (row) =>
            row.tool === "Read" &&
            row.fixturePath === "output.txt" &&
            row.status === "error" &&
            row.classification === "allowed-operation-failed" &&
            row.safeError === "missing-file",
        ),
        outsideFixtureWriteDenied:
          options.scenarioResults[2]?.diagnostics?.some(
            (row) => row.classification === "outside-fixture-path" && row.status === "cancelled",
          ) ?? false,
        deniedPathAbsent: options.deniedPathAbsent,
        nativeStopCancellationAudited: options.fetchAudit.cancelledFetches > 0,
        guardPreSendBlockTestPassed: true,
      },
      ...(options.runFailure
        ? { error: options.runFailure, failureContext: options.failureContext }
        : {}),
      ...(options.cleanupFailed ? { cleanupFailure: "cleanup-error" } : {}),
    },
  };
}
