import { z } from "zod";
import { hostSessionIdSchema } from "./ids.js";

/** Binds one host session to one backend session, version and runtime epoch. */
export const backendBindingSchema = z.strictObject({
  hostSessionId: hostSessionIdSchema,
  backendSessionId: z.string().trim().min(1).max(512),
  backendVersion: z.string().trim().min(1).max(128),
  runtimeEpoch: z.string().trim().min(1).max(128),
});
export type BackendBinding = z.infer<typeof backendBindingSchema>;
