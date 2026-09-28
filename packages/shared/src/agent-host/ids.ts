import { z } from "zod";

/** Stable host identity. Not required to equal a native agent session id. */
export const hostSessionIdSchema = z.string().trim().min(1).max(256);
