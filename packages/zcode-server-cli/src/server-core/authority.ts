import type { ServiceCollection } from "@zcode/services";
import * as nodeServices from "@zcode/services/node";
import type { CoreMaintenanceAdmissionPort } from "./maintenanceAdmission.js";

/** Process-owned service writer. New admission stays closed until reconciliation succeeds. */
export interface CoreAuthority {
  services: ServiceCollection;
  maintenance: CoreMaintenanceAdmissionPort;
  reconcileBeforeAdmission(): Promise<void>;
  /** Close the profile/Target writer AND collection resources exactly once. */
  dispose(): Promise<void>;
}

export interface CoreAuthorityOptions {
  installationId: string;
  profileRoot: string;
  zcodeBuiltinProviderConfigFilePath: string;
}

/** Public Node composition port. Missing export must fail boot BEFORE Core advertises ready. */
export type CoreAuthorityFactory = (options: CoreAuthorityOptions) => Promise<CoreAuthority>;

export async function createProductionCoreAuthority(
  options: CoreAuthorityOptions,
): Promise<CoreAuthority> {
  const factory = (
    nodeServices as typeof nodeServices & { createCoreAuthority?: CoreAuthorityFactory }
  ).createCoreAuthority;
  if (!factory) throw new Error("Persistent Core authority composition unavailable");
  return factory(options);
}
