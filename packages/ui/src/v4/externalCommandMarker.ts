/* Renderer-only command recovery clue. Host queryCommand/receipts remain authoritative;
 * this marker is never replayed and never contains a prompt or a model credential. */
export function externalCommandMarkerKey(input: {
  targetId: string;
  workspaceId: string;
  sessionId: string;
}): string {
  return `zcode-agent-host-command:v1:${encodeURIComponent(JSON.stringify([input.targetId, input.workspaceId, input.sessionId]))}`;
}

export function readExternalCommandMarker(key: string): string | null {
  try {
    const id = globalThis.localStorage?.getItem(key);
    return id && id.length <= 256 ? id : id ? "invalid-command-marker" : null;
  } catch {
    return null;
  }
}

/** False means no durable recovery clue can be written: refuse new admission. */
export function writeExternalCommandMarker(key: string, commandId: string): boolean {
  try {
    if (globalThis.localStorage.getItem(key)) return false;
    globalThis.localStorage.setItem(key, commandId);
    return globalThis.localStorage.getItem(key) === commandId;
  } catch {
    return false;
  }
}

export function clearExternalCommandMarker(key: string, commandId: string): boolean {
  try {
    if (globalThis.localStorage.getItem(key) === commandId) globalThis.localStorage.removeItem(key);
    return globalThis.localStorage.getItem(key) === null;
  } catch {
    return false; /* Retain ambiguous marker; never silently authorize replay. */
  }
}
