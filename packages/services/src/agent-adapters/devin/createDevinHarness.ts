import { DevinHarnessAdapter } from "./devinHarnessAdapter.js";

/** Explicit opt-in factory; Host registers after Wave 1 Devin admission lands. */
export function createExperimentalRegistryDevinHarness(options: {
  root: string;
  executablePath?: string;
}): DevinHarnessAdapter {
  return new DevinHarnessAdapter({
    root: options.root,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  });
}

/** Alias matching the Wave 1 brief (`createDevinHarness`). */
export function createDevinHarness(options: {
  root: string;
  executablePath?: string;
}): DevinHarnessAdapter {
  return createExperimentalRegistryDevinHarness(options);
}

export { DevinHarnessAdapter } from "./devinHarnessAdapter.js";
export { DEVIN_ADAPTER_VERSION } from "./devinExecutable.js";
