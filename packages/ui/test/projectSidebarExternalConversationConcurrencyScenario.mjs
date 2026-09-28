import {
  externalBodySelector,
  externalTimelineSelector,
  readHostCounters,
  readHostSnapshot,
  visibleApprovalExpression,
  visibleRowTextExpression,
  visibleTextInBodyExpression,
  waitForHostSnapshot,
} from "./projectSidebarExternalConversationBrowserSupport.mjs";

export async function runProjectSidebarExternalConversationConcurrencyScenario(context) {
  const {
    browser,
    pageValue,
    waitFor,
    click,
    fill,
    capture,
    assertStep,
    record,
    screenshots,
    sleep,
    hostDriverUrl,
    snapshotA,
    turnA,
    interactionA,
  } = context;
  const body = externalBodySelector("pi-idle");
  const timeline = `${body} ${externalTimelineSelector}`;
  await waitFor("visible Pi A concurrent approval", visibleApprovalExpression());
  const allowButtonASelected = pageValue(
    "document.querySelector('[data-permission-option-kind=\"allowOnce\"]')?.getAttribute('aria-selected') === 'true'",
  );
  if (!allowButtonASelected) click('button[data-permission-option-kind="allowOnce"]');
  if (pageValue("Boolean(document.querySelector('[data-permission-option-kind=\"allowOnce\"]'))")) {
    click('button[data-permission-option-kind="allowOnce"]');
  }
  const runningA = await waitForHostSnapshot(
    hostDriverUrl,
    "pi-review",
    "Pi A running after approval, without a modal blocking Stop",
    (snapshot) =>
      snapshot.control.activeWorks[0]?.foregroundExecutionId === turnA &&
      snapshot.pendingInteractions.length === 0,
    sleep,
  );
  const approvalCallA = (await readHostCounters(hostDriverUrl)).calls.find(
    (call) =>
      call.method === "dispatch" &&
      call.commandType === "resolveInteraction" &&
      call.sessionId === "pi-review" &&
      call.interactionId === interactionA.interactionId,
  );
  assertStep(
    runningA.control.phase === "running" &&
      approvalCallA?.turnId === turnA &&
      approvalCallA.runtimeEpoch === snapshotA.logEpoch &&
      approvalCallA.decision === "allow",
    "Pi A remains in its exact active turn after approval while its tool result is visible",
  );
  const stopButtonA = `${externalBodySelector("pi-review")} [data-testid="v4-stop"]`;
  await waitFor(
    "visible Pi A Stop control after its approval dialog closes",
    `Boolean(document.querySelector(${JSON.stringify(stopButtonA)})?.getClientRects().length)`,
  );
  assertStep(
    pageValue(
      `Boolean(document.querySelector(${JSON.stringify(stopButtonA)})?.getClientRects().length)`,
    ),
    "the existing SessionPane Stop control is visible for running Pi A",
  );

  click('button[data-project-sidebar-session="pi-idle"]');
  await waitFor(
    "Pi B returns to its empty conversation",
    `(() => { const timeline=document.querySelector(${JSON.stringify(timeline)}); return Boolean(window.__projectSidebarFixture.getSelectedExternalSessionId()==='pi-idle' && timeline && Number(timeline.dataset.windowRowCount)===0 && Number(timeline.dataset.totalRowCount)===0 && document.querySelector('[data-testid="v4-composer-input"]')); })()`,
  );
  assertStep(
    pageValue(
      `(() => { const timeline=document.querySelector(${JSON.stringify(timeline)}); const bounds=timeline?.getBoundingClientRect(); return Boolean(timeline && Number(timeline.dataset.totalRowCount)===0 && bounds && bounds.width>0 && bounds.height>0); })()`,
    ),
    "the existing SessionPane mounts a real empty Host transcript before its first message",
  );

  const piBPrompt =
    "Visible cold Pi B request start: review this linked workspace and prepare a fixture write. " +
    "Include the saved note and wait for the permission decision. ".repeat(16) +
    "COLD-USER-END-987";
  fill('[data-testid="v4-composer-input"]', piBPrompt);
  click('[data-testid="v4-composer-send"]');
  const snapshotB = await waitForHostSnapshot(
    hostDriverUrl,
    "pi-idle",
    "pending approval for turn B",
    (snapshot) =>
      snapshot.pendingInteractions.length === 1 && snapshot.control.activeWorks.length === 1,
    sleep,
  );
  const turnB = snapshotB.control.activeWorks[0]?.foregroundExecutionId;
  const interactionB = snapshotB.pendingInteractions[0];
  await waitFor(
    "cold transcript first Host rows",
    `(() => { const timeline=document.querySelector(${JSON.stringify(timeline)}); return Boolean(timeline && Number(timeline.dataset.totalRowCount)===${snapshotB.rows.totalCount} && Number(timeline.dataset.totalRowCount)>0); })()`,
  );
  const firstMessageScroll = pageValue(
    `JSON.stringify((()=>{const timeline=document.querySelector(${JSON.stringify(timeline)});return timeline?{following:timeline.dataset.following,scrollTop:timeline.scrollTop,clientHeight:timeline.clientHeight,scrollHeight:timeline.scrollHeight}:null})())`,
  );
  assertStep(
    firstMessageScroll.following === "true" &&
      firstMessageScroll.scrollTop + firstMessageScroll.clientHeight >=
        firstMessageScroll.scrollHeight - 3,
    "the first message after the empty Host snapshot lands at the visible timeline tail",
  );

  await waitFor(
    "Pi B expandable user input control",
    `(() => { const body=document.querySelector(${JSON.stringify(body)}); return Boolean(Array.from(body?.querySelectorAll('[data-v4-user-input-collapsible-content]') ?? []).some((content)=>content.scrollHeight>120 && content.closest('[data-row-id]')?.querySelector('button[aria-expanded="false"]'))); })()`,
  );
  const userExpandRowId = pageValue(
    `(() => { const body=document.querySelector(${JSON.stringify(body)}); const content=Array.from(body?.querySelectorAll('[data-v4-user-input-collapsible-content]') ?? []).find((item)=>item.scrollHeight>120); return content?.closest('[data-row-id]')?.getAttribute('data-row-id') ?? null; })()`,
  );
  assertStep(
    Boolean(userExpandRowId),
    "cold Pi B user text uses the existing expandable message control",
  );
  await waitFor(
    "visible collapsed Pi B user message beginning",
    visibleTextInBodyExpression("pi-idle", "Visible cold Pi B request start"),
  );
  assertStep(
    pageValue(visibleTextInBodyExpression("pi-idle", "Visible cold Pi B request start")),
    "the collapsed first user message visibly identifies the sent Pi B prompt",
  );
  click(`${body} [data-row-id="${userExpandRowId}"] button[aria-expanded="false"]`);
  browser("scroll", "up", "300", "--selector", timeline);
  await waitFor(
    "expanded Pi B user message tail",
    visibleTextInBodyExpression("pi-idle", "COLD-USER-END-987"),
  );
  assertStep(
    pageValue(visibleTextInBodyExpression("pi-idle", "COLD-USER-END-987")),
    "expanding the first Host user row reveals the previously clipped end of the sent text",
  );
  browser("scroll", "down", "4000", "--selector", timeline);
  await waitFor(
    "Pi B returns to the active tool row",
    `(() => { const timeline=document.querySelector(${JSON.stringify(timeline)}); return Boolean(timeline && timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 3); })()`,
  );
  await waitFor("visible Pi B approval dialog", visibleApprovalExpression());

  const [snapshotAWhileBPending, snapshotBWhilePending] = await Promise.all([
    readHostSnapshot(hostDriverUrl, "pi-review"),
    readHostSnapshot(hostDriverUrl, "pi-idle"),
  ]);
  const bothSessionsActive =
    snapshotAWhileBPending.control.activeWorks[0]?.foregroundExecutionId === turnA &&
    snapshotAWhileBPending.pendingInteractions.length === 0 &&
    snapshotBWhilePending.control.activeWorks[0]?.foregroundExecutionId === turnB &&
    snapshotBWhilePending.pendingInteractions.some(
      (interaction) => interaction.interactionId === interactionB.interactionId,
    ) &&
    turnA !== turnB;
  assertStep(
    bothSessionsActive,
    "real Host snapshots show running Pi A and pending Pi B simultaneously on the same worktree",
  );

  click('button[data-project-sidebar-session="pi-review"]');
  await waitFor(
    "Pi A pending owner selected for Stop",
    `Boolean(document.querySelector(${JSON.stringify(stopButtonA)}) && window.__projectSidebarFixture.getSelectedExternalSessionId()==='pi-review')`,
  );
  const stopGeometry = pageValue(
    `JSON.stringify((()=>{const stop=document.querySelector(${JSON.stringify(stopButtonA)});const aside=document.querySelector('aside');const button=stop?.getBoundingClientRect();const sidebar=aside?.getBoundingClientRect();const hit=button?document.elementFromPoint(button.left+button.width/2,button.top+button.height/2):null;return{stop:button?.toJSON(),sidebar:sidebar?.toJSON(),hitTag:hit?.tagName,hitText:hit?.innerText?.slice(0,80),owner:window.__projectSidebarFixture.getSelectedExternalSessionId()}})())`,
  );
  record(`Pi A Stop hit test: ${JSON.stringify(stopGeometry)}`);
  click(stopButtonA);
  const stoppedA = await waitForHostSnapshot(
    hostDriverUrl,
    "pi-review",
    "turn A cancelled while B remains pending",
    (snapshot) =>
      snapshot.control.activeWorks.length === 0 && snapshot.pendingInteractions.length === 0,
    sleep,
  );
  const stillPendingB = await readHostSnapshot(hostDriverUrl, "pi-idle");
  assertStep(
    stoppedA.control.phase === "completedInterrupted" &&
      stillPendingB.control.activeWorks[0]?.foregroundExecutionId === turnB &&
      stillPendingB.pendingInteractions.some(
        (interaction) => interaction.interactionId === interactionB.interactionId,
      ),
    "stopping Pi A cancels only A while Pi B remains running and pending in the Host",
  );

  click('button[data-project-sidebar-session="pi-idle"]');
  await waitFor(
    "Pi B owner and pending approval reachable after stopping A",
    `window.__projectSidebarFixture.getSelectedExternalSessionId()==='pi-idle' && Boolean(document.querySelector(${JSON.stringify(body)})) && ${visibleApprovalExpression()}`,
  );
  assertStep(
    pageValue(
      `window.__projectSidebarFixture.getSelectedExternalSessionId()==='pi-idle' && ${visibleApprovalExpression()}`,
    ),
    "after stopping A, Pi B remains selectable with its pending approval visible",
  );

  const allowButtonBSelected = pageValue(
    "document.querySelector('[data-permission-option-kind=\"allowOnce\"]')?.getAttribute('aria-selected') === 'true'",
  );
  if (!allowButtonBSelected) click('button[data-permission-option-kind="allowOnce"]');
  if (pageValue("Boolean(document.querySelector('[data-permission-option-kind=\"allowOnce\"]'))")) {
    click('button[data-permission-option-kind="allowOnce"]');
  }
  const completedB = await waitForHostSnapshot(
    hostDriverUrl,
    "pi-idle",
    "B approval result and assistant response",
    (snapshot) =>
      snapshot.control.activeWorks.length === 0 &&
      snapshot.pendingInteractions.length === 0 &&
      snapshot.rows.window.some(
        (row) =>
          row.kind === "assistantText" &&
          row.text === "The requested fixture file was written successfully.",
      ),
    sleep,
  );
  const resolvedCallB = (await readHostCounters(hostDriverUrl)).calls.find(
    (call) =>
      call.method === "dispatch" &&
      call.commandType === "resolveInteraction" &&
      call.sessionId === "pi-idle" &&
      call.interactionId === interactionB.interactionId,
  );
  assertStep(
    resolvedCallB?.turnId === turnB &&
      resolvedCallB.runtimeEpoch === snapshotBWhilePending.logEpoch &&
      resolvedCallB.decision === "allow" &&
      resolvedCallB.interactionId === interactionB.interactionId,
    "the real service-port approval choice carries B's exact pending interaction, turn, and runtime epoch",
  );

  const completedToolRowB = completedB.rows.window.find(
    (row) => row.kind === "toolCall" && row.turnId === turnB,
  );
  assertStep(
    completedToolRowB?.kind === "toolCall" &&
      completedToolRowB.status === "success" &&
      completedToolRowB.output?.text ===
        "AgentHost fixture write result: browser-proof.txt was written.",
    "Host projection records the approved tool result under B's turn",
  );
  await waitFor(
    "completed Pi B rows in the V4 timeline",
    `(() => { const timeline=document.querySelector(${JSON.stringify(timeline)}); return Boolean(timeline && Number(timeline.dataset.totalRowCount)===${completedB.rows.totalCount}); })()`,
  );
  const completedHistoryTrigger = pageValue(
    `(() => { const body=document.querySelector(${JSON.stringify(body)}); const trigger=Array.from(body?.querySelectorAll('button[data-history-open="false"]') ?? []).find((item)=>item.getClientRects().length>0); return trigger?.getAttribute('data-testid') ?? null; })()`,
  );
  if (completedHistoryTrigger) click(`button[data-testid="${completedHistoryTrigger}"]`);
  await waitFor(
    "visible Pi B final assistant output",
    visibleTextInBodyExpression("pi-idle", "The requested fixture file was written successfully."),
  );
  await waitFor(
    "visible Pi B successful file write summary",
    visibleRowTextExpression("pi-idle", completedToolRowB.rowId, "browser-proof.txt"),
  );
  assertStep(
    pageValue(
      visibleTextInBodyExpression(
        "pi-idle",
        "The requested fixture file was written successfully.",
      ),
    ) &&
      pageValue(visibleRowTextExpression("pi-idle", completedToolRowB.rowId, "browser-proof.txt")),
    "visible external body displays B's assistant reply and the successful file-write result summary",
  );
  capture("second Pi visible user, assistant and tool result", screenshots.externalResult);
}
