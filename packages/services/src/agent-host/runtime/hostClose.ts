import { EventStreamFailure, SessionHostBusyError, type SessionHost } from "../sessionHost.js";

/**
 * Closes every host (one failing never leaves the others open) and returns the failures in close
 * order. Per host: wait for idle (a broken stream stops that wait and close() force-closes with
 * EventStreamFailure); a close() refused only because a send is still starting is retried once
 * after that send settles; if it started running, the retry refuses with "active-turn".
 */
export async function closeSessionHosts(
  hosts: Iterable<SessionHost>,
): Promise<{ hostSessionId: string; error: unknown }[]> {
  const failures: { hostSessionId: string; error: unknown }[] = [];
  for (const host of hosts) {
    const error = await closeSessionHost(host);
    if (error !== undefined) failures.push({ hostSessionId: host.spec.hostSessionId, error });
  }
  return failures;
}

async function closeSessionHost(host: SessionHost): Promise<unknown> {
  const idle = await host.whenIdle().then(
    () => undefined,
    (error: unknown) => error ?? new Error("host failed to settle"),
  );
  let closeError = await attemptClose(host);
  if (closeError instanceof SessionHostBusyError && closeError.reason === "starting-send") {
    await host.whenStartingSendsSettled();
    closeError = await attemptClose(host);
  }
  if (closeError === undefined) return idle;
  // Force-closed: the typed stream failure is the outcome. Otherwise an earlier settle error wins.
  if (closeError instanceof EventStreamFailure) return closeError;
  return idle ?? closeError;
}

function attemptClose(host: SessionHost): Promise<unknown> {
  return host.close().then(
    () => undefined,
    (error: unknown) => error ?? new Error("host failed to close"),
  );
}
