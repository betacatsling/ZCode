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
  route: z
    .enum(["native", "pi-sdk", "responses-gateway", "messages-gateway", "harness-managed", "mock"])
    .optional(),
  credentialRef: z.string().min(1).optional(),
  support: capabilityReportSchema,
  capabilities: z.record(z.string(), capabilityReportSchema),
});
export type BindingPlan = z.infer<typeof bindingPlanSchema>;

/** Persist once per admitted turn before any model call; main/auxiliary calls share this frozen route. */
export const frozenTurnModelRouteSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    hostSessionId: bindingPlanSchema.shape.hostSessionId,
    turnId: z.string().trim().min(1),
    runtimeEpoch: z.string().trim().min(1),
    targetId: bindingPlanSchema.shape.targetId,
    workspaceId: z.string().trim().min(1),
    harnessId: bindingPlanSchema.shape.harnessId,
    adapterVersion: bindingPlanSchema.shape.adapterVersion,
    catalogFingerprint: bindingPlanSchema.shape.catalogFingerprint,
    requested: modelBindingRequestSchema,
    effective: modelSelectionSchema.optional(),
    route: bindingPlanSchema.shape.route.unwrap(),
    credentialRef: bindingPlanSchema.shape.credentialRef,
  })
  .superRefine((turn, context) => {
    if (
      turn.requested.kind === "host-managed" &&
      (!turn.effective ||
        turn.effective.providerId !== turn.requested.selection.providerId ||
        turn.effective.modelId !== turn.requested.selection.modelId ||
        turn.effective.options?.reasoningLevel !== turn.requested.selection.options?.reasoningLevel)
    )
      context.addIssue({
        code: "custom",
        path: ["effective"],
        message: "host-managed effective model must match the selected model",
      });
    if (
      turn.requested.kind === "harness-managed" &&
      (turn.effective || turn.route !== "harness-managed")
    )
      context.addIssue({
        code: "custom",
        path: ["route"],
        message: "native model cannot be represented as a host-managed route",
      });
    if (turn.requested.kind === "host-managed" && turn.route === "harness-managed")
      context.addIssue({
        code: "custom",
        path: ["route"],
        message: "host-managed request cannot silently fall back to native account",
      });
  });
export type FrozenTurnModelRoute = z.infer<typeof frozenTurnModelRouteSchema>;
