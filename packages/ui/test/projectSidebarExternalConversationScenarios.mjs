import { runProjectSidebarExternalConversationConcurrencyScenario } from "./projectSidebarExternalConversationConcurrencyScenario.mjs";
import { runProjectSidebarExternalConversationHistoryScenario } from "./projectSidebarExternalConversationHistoryScenario.mjs";
import {
  externalBodySelector,
  externalTimelineSelector,
  postHoldAfterApproval,
  postStaleApprovalProbe,
  readHostCounters,
  readHostSnapshot,
  visibleApprovalExpression,
  visibleRowTextExpression,
  waitForHostSnapshot,
} from "./projectSidebarExternalConversationBrowserSupport.mjs";

export async function runProjectSidebarExternalConversationScenarios(context) {
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
    hostWorkspacePath,
  } = context;
  const reviewBody = externalBodySelector("pi-review");
  const timeline = externalTimelineSelector;

  await pageValue("window.__projectSidebarFixture.switchScope('/fixture/repo')");
  browser("set", "viewport", "780", "900");
  await pageValue(
    `window.__projectSidebarFixture.installHierarchyFixture(${JSON.stringify(hostWorkspacePath)})`,
  );
  click("button[aria-label='Refresh project workspaces']");
  await waitFor(
    "external owner Project row",
    "Boolean(document.querySelector('[data-project-sidebar-project-toggle=\"external-conversation-project\"]'))",
  );
  click('button[data-project-sidebar-project-toggle="external-conversation-project"]');
  await waitFor(
    "external owner workspace row",
    "Boolean(document.querySelector('[data-project-sidebar-workspace=\"one-linked\"]'))",
  );
  click('[data-project-sidebar-workspace="one-linked"] button[aria-expanded="false"]');
  await pageValue("window.__projectSidebarFixture.expandSessionRows()");
  const expandedRows = pageValue(
    "JSON.stringify({view:window.__projectSidebarFixture.getViewState(),rows:Array.from(document.querySelectorAll('[data-project-sidebar-session]')).map(row=>row.getAttribute('data-project-sidebar-session'))})",
  );
  record(`expanded linked rows: ${JSON.stringify(expandedRows)}`);
  await waitFor(
    "linked Pi rows",
    "Boolean(document.querySelector('[data-project-sidebar-session=\"pi-review\"]') && document.querySelector('[data-project-sidebar-session=\"pi-idle\"]'))",
    5_000,
  );
  const piRowState = pageValue(
    "JSON.stringify({disabled:document.querySelector('[data-project-sidebar-session=\"pi-review\"]')?.disabled, ownerKind:document.querySelector('[data-project-sidebar-session=\"pi-review\"]')?.getAttribute('data-project-sidebar-owner-kind'), ownerLocatorAvailable:document.querySelector('[data-project-sidebar-session=\"pi-review\"]')?.getAttribute('data-project-sidebar-owner-locator-available'), label:document.querySelector('[data-project-sidebar-session=\"pi-review\"]')?.getAttribute('aria-label'), title:document.querySelector('[data-project-sidebar-session=\"pi-review\"]')?.getAttribute('title')})",
  );
  record(`external Pi row state: ${JSON.stringify(piRowState)}`);
  assertStep(
    piRowState.disabled === false &&
      piRowState.ownerKind === "agent-host" &&
      piRowState.ownerLocatorAvailable === "true",
    "linked Pi row is enabled by the exact Host summary mapping",
  );
  const fixtureControlsHidden = pageValue(
    `(() => { const label=document.querySelector('[data-fixture-type="isolated-service-port"]'); const toolbar=label?.parentElement; if(!toolbar) return false; toolbar.hidden=true; return toolbar.hidden; })()`,
  );
  assertStep(
    fixtureControlsHidden,
    "hide isolated browser-driver controls before inspecting conversation UI",
  );

  browser("find", "role", "button", "click", "--name", "Review the project hierarchy");
  await waitFor(
    "AppShell external owner selection callback",
    "window.__projectSidebarFixture.getSelectedExternalSessionId() === 'pi-review'",
    5_000,
  );
  await waitFor(
    "recoverable V4 subscription fault",
    "Boolean(document.querySelector('[data-testid=\"v4-retry-subscribe\"]'))",
    5_000,
  );
  assertStep(
    pageValue(
      `Boolean(document.querySelector(${JSON.stringify(reviewBody)})?.innerText.includes('fixture-subscribe-failure'))`,
    ),
    "failed Host subscribe is shown in the selected V4 reconnect panel",
  );
  click('[data-testid="v4-retry-subscribe"]');
  await waitFor(
    "external SessionPane body",
    `Boolean(document.querySelector(${JSON.stringify(reviewBody)}) && document.querySelector('[data-testid="v4-composer-input"]'))`,
  );

  const initialReviewSnapshot = await readHostSnapshot(hostDriverUrl, "pi-review");
  await waitFor(
    "Host history snapshot in V4 timeline",
    `(() => { const body=document.querySelector(${JSON.stringify(reviewBody)}); const timeline=body?.querySelector(${JSON.stringify(timeline)}); return Boolean(timeline && Number(timeline.dataset.totalRowCount)===${initialReviewSnapshot.rows.totalCount}); })()`,
  );
  assertStep(
    pageValue(
      `(() => { const body=document.querySelector(${JSON.stringify(reviewBody)}); const timeline=body?.querySelector(${JSON.stringify(timeline)}); return Boolean(timeline && Number(timeline.dataset.totalRowCount)===${initialReviewSnapshot.rows.totalCount} && Number(timeline.dataset.windowRowCount)>=${initialReviewSnapshot.rows.window.length} && Number(timeline.dataset.windowRowCount)<=${initialReviewSnapshot.rows.totalCount}); })()`,
    ),
    "the existing SessionPane timeline reflects the Host history and any bounded older page",
  );

  fill('[data-testid="v4-composer-input"]', "draft focus survives sidebar refresh");
  pageValue("window.__projectSidebarFixture.prepareFocusedChatInput()");
  pageValue("window.__projectSidebarFixture.emitBackgroundEvent()");
  const focusAfterRefresh = pageValue(
    "JSON.stringify(window.__projectSidebarFixture.checkFocusedChatInput())",
  );
  assertStep(
    focusAfterRefresh.sameNode &&
      focusAfterRefresh.focused &&
      focusAfterRefresh.anchorOffset === 3 &&
      focusAfterRefresh.focusOffset === 3,
    "background summary update preserves the V4 composer node, focus, draft, and caret",
  );

  click('[data-testid="v4-composer-input"]');
  browser("press", "Control+A");
  browser("press", "Backspace");
  await waitFor(
    "composer draft cleared before the next prompt",
    `(() => { const input=document.querySelector('[data-testid="v4-composer-input"]'); return Boolean(input && String(input.value ?? input.innerText ?? '').trim()===''); })()`,
  );
  const piAPrompt =
    "Visible Pi A request: inspect the linked workspace and prepare one fixture write.";
  fill('[data-testid="v4-composer-input"]', piAPrompt);
  click('[data-testid="v4-composer-send"]');
  const snapshotA = await waitForHostSnapshot(
    hostDriverUrl,
    "pi-review",
    "pending approval for turn A",
    (snapshot) =>
      snapshot.pendingInteractions.length === 1 && snapshot.control.activeWorks.length === 1,
    sleep,
  );
  await waitFor(
    "V4 timeline receives the current Pi A rows",
    `(() => { const body=document.querySelector(${JSON.stringify(reviewBody)}); const timeline=body?.querySelector(${JSON.stringify(timeline)}); return Boolean(timeline && Number(timeline.dataset.totalRowCount)===${snapshotA.rows.totalCount}); })()`,
  );
  const piAScrollAfterSend = pageValue(
    `JSON.stringify((()=>{const timeline=document.querySelector(${JSON.stringify(reviewBody + " " + timeline)});return timeline?{following:timeline.dataset.following,scrollTop:timeline.scrollTop,clientHeight:timeline.clientHeight,scrollHeight:timeline.scrollHeight,windowRows:timeline.dataset.windowRowCount}:null})())`,
  );
  record(`Pi A timeline after pending Host events: ${JSON.stringify(piAScrollAfterSend)}`);
  assertStep(
    piAScrollAfterSend.following === "true" &&
      piAScrollAfterSend.scrollTop + piAScrollAfterSend.clientHeight >=
        piAScrollAfterSend.scrollHeight - 3,
    "a newly appended Host turn leaves Pi A following its conversation tail",
  );

  const interactionA = snapshotA.pendingInteractions[0];
  const turnA = snapshotA.control.activeWorks[0]?.foregroundExecutionId;
  const toolRowA = snapshotA.rows.window.find(
    (row) => row.kind === "toolCall" && row.turnId === turnA,
  );
  const userRowA = snapshotA.rows.window.find(
    (row) => row.kind === "userInput" && row.text === piAPrompt,
  );
  const assistantRowA = snapshotA.rows.window.find(
    (row) =>
      row.kind === "assistantText" &&
      row.text === "The Pi prepared the requested fixture write and is waiting for approval.",
  );
  record(
    `Pi A Host rows for turn ${turnA}: ${JSON.stringify(snapshotA.rows.window.filter((row) => row.turnId === turnA).map((row) => ({ rowId: row.rowId, kind: row.kind, text: "text" in row ? row.text : undefined, status: row.kind === "toolCall" ? row.status : undefined })))}`,
  );
  capture("first Pi pending approval choices", screenshots.externalApproval);
  assertStep(
    turnA !== undefined &&
      interactionA?.payload.kind === "permission" &&
      toolRowA?.kind === "toolCall" &&
      toolRowA.status === "pendingApproval" &&
      interactionA.anchorRowId === toolRowA.rowId &&
      userRowA?.kind === "userInput" &&
      assistantRowA?.kind === "assistantText",
    "Host snapshot ties Pi A's user and assistant rows, pending approval, and tool row to the active turn",
  );
  record(
    `Pi A Host rows: user=${userRowA.rowId}, assistant=${assistantRowA.rowId}, tool=${toolRowA.rowId}`,
  );
  await waitFor("visible Pi A approval dialog", visibleApprovalExpression());
  assertStep(
    pageValue(visibleApprovalExpression()),
    "the existing permission dialog visibly shows Pi A's pending approval",
  );

  const sendCallA = (await readHostCounters(hostDriverUrl)).calls.find(
    (call) =>
      call.method === "dispatch" && call.commandType === "send" && call.sessionId === "pi-review",
  );
  assertStep(
    sendCallA?.text === piAPrompt &&
      sendCallA.turnId === turnA &&
      interactionA.interactionId.endsWith(turnA),
    "the browser send reaches Host with the exact current Pi A turn",
  );

  const staleEpochProbe = await postStaleApprovalProbe(hostDriverUrl, "pi-review", "epoch");
  const staleTurnProbe = await postStaleApprovalProbe(hostDriverUrl, "pi-review", "turn");
  const staleProbesRemainPending = [staleEpochProbe, staleTurnProbe].every(
    (probe) =>
      probe.receipt.status === "rejected" &&
      probe.before.logEpoch === snapshotA.logEpoch &&
      probe.after.logEpoch === snapshotA.logEpoch &&
      probe.after.seq === probe.before.seq &&
      probe.after.turnId === turnA &&
      probe.after.interactionIds.includes(interactionA.interactionId),
  );
  assertStep(
    staleProbesRemainPending,
    "stale epoch and stale turn approval answers are rejected without releasing Host pending state",
  );
  const approvalCallsA = (await readHostCounters(hostDriverUrl)).calls.filter(
    (call) =>
      call.method === "dispatch" &&
      call.commandType === "resolveInteraction" &&
      call.sessionId === "pi-review",
  );
  assertStep(
    approvalCallsA.length === 0,
    "no approval choice is dispatched before the pending dialog receives the user's answer",
  );

  const allowButtonSelected = pageValue(
    "document.querySelector('[data-permission-option-kind=\"allowOnce\"]')?.getAttribute('aria-selected') === 'true'",
  );
  if (!allowButtonSelected) click('button[data-permission-option-kind="allowOnce"]');
  if (pageValue("Boolean(document.querySelector('[data-permission-option-kind=\"allowOnce\"]'))")) {
    click('button[data-permission-option-kind="allowOnce"]');
  }
  const completedA = await waitForHostSnapshot(
    hostDriverUrl,
    "pi-review",
    "Pi A approval result and assistant response",
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
  const resolveCallA = (await readHostCounters(hostDriverUrl)).calls.find(
    (call) =>
      call.method === "dispatch" &&
      call.commandType === "resolveInteraction" &&
      call.sessionId === "pi-review" &&
      call.interactionId === interactionA.interactionId,
  );
  assertStep(
    resolveCallA?.turnId === turnA &&
      resolveCallA.runtimeEpoch === snapshotA.logEpoch &&
      resolveCallA.decision === "allow" &&
      resolveCallA.interactionId === interactionA.interactionId,
    "Pi A's service-port approval choice carries its exact pending interaction, turn, and runtime epoch",
  );
  const finalAssistantRowA = completedA.rows.window.find(
    (row) =>
      row.kind === "assistantText" &&
      row.text === "The requested fixture file was written successfully.",
  );
  const completedToolRowA = completedA.rows.window.find(
    (row) => row.kind === "toolCall" && row.turnId === turnA,
  );
  assertStep(
    completedToolRowA?.kind === "toolCall" &&
      completedToolRowA.status === "success" &&
      completedToolRowA.output?.text ===
        "AgentHost fixture write result: browser-proof.txt was written.",
    "Host projection records Pi A's approved tool result under the matching turn",
  );
  await waitFor(
    "completed Pi A rows in the V4 timeline",
    `(() => { const body=document.querySelector(${JSON.stringify(reviewBody)}); const timeline=body?.querySelector(${JSON.stringify(timeline)}); return Boolean(timeline && Number(timeline.dataset.totalRowCount)===${completedA.rows.totalCount}); })()`,
  );
  const completedHistoryTriggerA = pageValue(
    `(() => { const body=document.querySelector(${JSON.stringify(reviewBody)}); const triggers=Array.from(body?.querySelectorAll('button[data-history-open="false"]') ?? []).filter((item)=>item.getClientRects().length>0); return triggers.at(-1)?.getAttribute('data-testid') ?? null; })()`,
  );
  if (completedHistoryTriggerA) click(`button[data-testid="${completedHistoryTriggerA}"]`);
  await waitFor(
    "tall transcript viewport follows the completed Pi A turn",
    `(() => { const timeline=document.querySelector(${JSON.stringify(reviewBody + " " + timeline)}); return Boolean(timeline && timeline.clientHeight>=600 && timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 3); })()`,
  );
  await waitFor(
    "visible Pi A sent user message",
    visibleRowTextExpression("pi-review", userRowA.rowId, piAPrompt),
  );
  await waitFor(
    "visible Pi A completed assistant output",
    visibleRowTextExpression(
      "pi-review",
      finalAssistantRowA.rowId,
      "The requested fixture file was written successfully.",
    ),
  );
  await waitFor(
    "visible Pi A successful file write summary",
    visibleRowTextExpression("pi-review", completedToolRowA.rowId, "browser-proof.txt"),
  );
  assertStep(
    pageValue(visibleRowTextExpression("pi-review", userRowA.rowId, piAPrompt)) &&
      pageValue(
        visibleRowTextExpression(
          "pi-review",
          finalAssistantRowA.rowId,
          "The requested fixture file was written successfully.",
        ),
      ) &&
      pageValue(
        visibleRowTextExpression("pi-review", completedToolRowA.rowId, "browser-proof.txt"),
      ),
    "first Pi's existing conversation body visibly renders the user message, assistant reply, and matching tool result",
  );
  capture("first Pi visible user, assistant and tool result", screenshots.externalConversation);

  await runProjectSidebarExternalConversationHistoryScenario({
    ...context,
    hostDriverUrl,
    initialReviewSnapshot,
    snapshotA: completedA,
  });

  const holdAfterApproval = await postHoldAfterApproval(hostDriverUrl, "pi-review");
  assertStep(
    holdAfterApproval.accepted,
    "the fixture keeps Pi A running after its next approval for Stop",
  );
  const concurrentPromptA =
    "Pi A second request: hold this write for the cross-session Stop check.";
  fill('[data-testid="v4-composer-input"]', concurrentPromptA);
  click('[data-testid="v4-composer-send"]');
  const concurrentSnapshotA = await waitForHostSnapshot(
    hostDriverUrl,
    "pi-review",
    "second Pi A pending approval for concurrency",
    (snapshot) =>
      snapshot.pendingInteractions.length === 1 && snapshot.control.activeWorks.length === 1,
    sleep,
  );
  const concurrentTurnA = concurrentSnapshotA.control.activeWorks[0]?.foregroundExecutionId;
  const concurrentInteractionA = concurrentSnapshotA.pendingInteractions[0];
  assertStep(
    concurrentTurnA !== undefined && concurrentInteractionA !== undefined,
    "Pi A is running a new pending turn before Pi B starts",
  );
  await runProjectSidebarExternalConversationConcurrencyScenario({
    ...context,
    hostDriverUrl,
    snapshotA: concurrentSnapshotA,
    turnA: concurrentTurnA,
    interactionA: concurrentInteractionA,
  });

  const nativeCalls = pageValue(
    "JSON.stringify(window.__projectSidebarFixture.getNativeServiceCalls())",
  );
  assertStep(
    nativeCalls.every((call) => !["pi-review", "pi-idle"].includes(call.sessionId ?? "")),
    "native service ports never receive either external Host session ID",
  );
  click('button[data-project-sidebar-session="pi-review"]');
  await waitFor(
    "second Pi row selects its Host session under the same worktree",
    "window.__projectSidebarFixture.getSelectedExternalSessionId() === 'pi-review' && document.querySelector('[data-external-conversation-body]')?.getAttribute('data-owner-session-id') === 'pi-review'",
  );
  assertStep(true, "second Pi row selects its own Host session under the same worktree");
  click('button[data-project-sidebar-session="native-session"]');
  await waitFor(
    "native selection callback",
    "window.__projectSidebarFixture.getSelectedExternalSessionId() === null && !document.querySelector('[data-external-conversation-body]')",
  );
  assertStep(
    pageValue(
      "window.__projectSidebarFixture.getSelectedTasks().some(value => value.endsWith(':native-session'))",
    ),
    "native sidebar selection stays on the native callback when no external owner is selected",
  );
  record(
    "external-only browser slice passed with the production SessionPane, local AgentHost service-port/bridge, and a credential-free fake Pi Harness; no Provider, SSH, or Electron session was used",
  );
}
