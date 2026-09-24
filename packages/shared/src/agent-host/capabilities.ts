import { z } from "zod";

/** Unknown/experimental never implies admission. Every non-supported result explains why. */
export const capabilityReportSchema = z
  .strictObject({
    support: z.enum(["supported", "unsupported", "experimental", "unknown"]),
    reason: z.string().trim().min(1).max(1024).optional(),
    constraints: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((report, context) => {
    if (report.support !== "supported" && !report.reason) {
      context.addIssue({ code: "custom", path: ["reason"], message: "unsupported or unverified capabilities need a reason" });
    }
  });
export type CapabilityReport = z.infer<typeof capabilityReportSchema>;

export const harnessCapabilitiesSchema = z.strictObject({
  text: capabilityReportSchema,
  tools: capabilityReportSchema,
  approvals: capabilityReportSchema,
  cancelTurn: capabilityReportSchema,
  resumeExecution: capabilityReportSchema,
  history: capabilityReportSchema,
  images: capabilityReportSchema,
  modelSwitch: capabilityReportSchema,
});
export type HarnessCapabilities = z.infer<typeof harnessCapabilitiesSchema>;

export const executionTargetSchema = z.strictObject({
  id: z.string().trim().min(1),
  kind: z.enum(["local", "ssh"]),
  platform: z.enum(["darwin", "linux", "win32"]),
  available: z.boolean(),
  reason: z.string().optional(),
});
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;
