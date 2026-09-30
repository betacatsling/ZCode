import { invalidRequest } from "../domain/errors.js";

export function parseMessagesJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    invalidRequest("Request body must be valid JSON");
  }
}

export function encodeMessagesSse(
  event: Record<string, unknown> & { readonly type: string },
): Uint8Array {
  return new TextEncoder().encode(
    "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n",
  );
}

export function encodeMessagesError(message: string): Uint8Array {
  return encodeMessagesSse({
    type: "error",
    error: { type: "api_error", message },
  });
}
