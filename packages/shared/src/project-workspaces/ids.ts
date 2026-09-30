import { z } from "zod";

/** Host-minted identity. Display names, branches and paths are not substitutes. */
export const stableIdSchema = z.string().trim().min(1).max(256);

/** Opaque filesystem path. Trimming would change a legal path that ends in space. */
export const pathSchema = z.string().min(1).max(4096);
