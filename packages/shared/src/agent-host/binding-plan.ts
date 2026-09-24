import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import { capabilityReportSchema } from "./capabilities.js";
import { modelBindingRequestSchema } from "./session-spec.js";

/** Produced by target host after verifying the registry and adapter, not by UI. */
export const bindingPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hostSessionId: z.string().min(1),
  targetId: z.string().min(1),
  harnessId: z.string().min(1),
  adapterVersion: z.string().min(1),
  catalogFingerprint: z.string().min(1),
  requested: modelBindingRequestSchema,
  effective: modelSelectionSchema.optional(),
  route: z.enum(["native", "pi-sdk", "responses-gateway", "messages-gateway", "harness-managed", "mock"]).optional(),
  credentialRef: z.string().min(1).optional(),
  support: capabilityReportSchema,
  capabilities: z.record(z.string(), capabilityReportSchema),
});
export type BindingPlan = z.infer<typeof bindingPlanSchema>;
