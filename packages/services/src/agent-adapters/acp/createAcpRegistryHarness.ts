import type { AcpAgentProfile } from "./acpProfile.js";
import {
  createAcpHarness,
  type AcpHarnessAdapter,
  type AcpHarnessOptions,
} from "./acpHarnessAdapter.js";
import { gooseAcpProfile } from "./agents/goose.js";
import { openCodeAcpProfile } from "./agents/opencode.js";

/**
 * Explicit opt-in ACP registry factories.
 * Lazy Host / default composition must not register these — call sites pass
 * `openTransport` (stdio launch is still caller-owned; see SPEC.md).
 */
export function createExperimentalRegistryAcpHarness(options: {
  profile: AcpAgentProfile;
  openTransport: AcpHarnessOptions["openTransport"];
  now?: () => number;
}): AcpHarnessAdapter {
  return createAcpHarness({
    profile: options.profile,
    openTransport: options.openTransport,
    ...(options.now ? { now: options.now } : {}),
  });
}

/** Opt-in OpenCode ACP (`opencode acp`). Not registered by lazyTargetService. */
export function createExperimentalRegistryOpenCodeAcpHarness(options: {
  openTransport: AcpHarnessOptions["openTransport"];
  now?: () => number;
}): AcpHarnessAdapter {
  return createExperimentalRegistryAcpHarness({
    profile: openCodeAcpProfile,
    openTransport: options.openTransport,
    ...(options.now ? { now: options.now } : {}),
  });
}

/** Opt-in Goose ACP (`goose acp`). Not registered by lazyTargetService. */
export function createExperimentalRegistryGooseAcpHarness(options: {
  openTransport: AcpHarnessOptions["openTransport"];
  now?: () => number;
}): AcpHarnessAdapter {
  return createExperimentalRegistryAcpHarness({
    profile: gooseAcpProfile,
    openTransport: options.openTransport,
    ...(options.now ? { now: options.now } : {}),
  });
}
