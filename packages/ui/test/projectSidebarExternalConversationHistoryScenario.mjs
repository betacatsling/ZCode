import {
  externalBodySelector,
  externalTimelineSelector,
  readHostCounters,
  visibleRowTextExpression,
  visibleTextInBodyExpression,
} from "./projectSidebarExternalConversationBrowserSupport.mjs";

export async function runProjectSidebarExternalConversationHistoryScenario(context) {
  const {
    browser,
    pageValue,
    waitFor,
    capture,
    assertStep,
    record,
    screenshots,
    hostDriverUrl,
    initialReviewSnapshot,
    snapshotA,
  } = context;
  const body = externalBodySelector("pi-review");
  const timeline = `${body} ${externalTimelineSelector}`;
  const counters = await readHostCounters(hostDriverUrl);
  const rangePages = counters.calls.filter(
    (call) => call.method === "conversationRowsRange" && call.sessionId === "pi-review",
  );
  const windowCount = pageValue(
    `Number(document.querySelector(${JSON.stringify(timeline)})?.dataset.windowRowCount)`,
  );
  const totalCount = snapshotA.rows.totalCount;
  const visibleFirstRowCursors = new Set([
    initialReviewSnapshot.rows.window[0]?.rowId,
    snapshotA.rows.window[0]?.rowId,
  ]);
  const loadedIds = [
    ...new Set([
      ...initialReviewSnapshot.rows.window.map((row) => row.rowId),
      ...snapshotA.rows.window.map((row) => row.rowId),
      ...rangePages.flatMap((call) => call.rowIds ?? []),
    ]),
  ].sort((left, right) => left - right);
  const pagesHaveExclusiveOrderedIds = rangePages.every((call) => {
    const ids = call.rowIds ?? [];
    const isValidPage =
      ids.length > 0 &&
      visibleFirstRowCursors.has(call.beforeRowId) &&
      ids.every(
        (rowId, index) =>
          rowId < (call.beforeRowId ?? 0) && (index === 0 || ids[index - 1] < rowId),
      ) &&
      new Set(ids).size === ids.length &&
      call.hasMore === ids[0] > 1;
    if (isValidPage) visibleFirstRowCursors.add(ids[0]);
    return isValidPage;
  });
  record(
    `Host pagination pages: ${JSON.stringify({ windowCount, totalCount, loadedIds: loadedIds.length, rangePages: rangePages.map((call) => ({ beforeRowId: call.beforeRowId, rowIds: call.rowIds, hasMore: call.hasMore })), pagesHaveExclusiveOrderedIds })}`,
  );
  assertStep(
    windowCount === totalCount &&
      loadedIds.length === totalCount &&
      loadedIds[0] === 1 &&
      loadedIds.at(-1) === totalCount &&
      loadedIds.every((rowId, index) => rowId === index + 1) &&
      pagesHaveExclusiveOrderedIds,
    "Host range pages and tail snapshots compose into one ordered, duplicate-free UI window",
  );

  browser("scroll", "up", "10000", "--selector", timeline);
  await waitFor(
    "oldest Host user row after scrolling older history",
    visibleRowTextExpression("pi-review", 2, "fixture-history-user-0"),
    10_000,
  );
  assertStep(
    pageValue(
      `Number(document.querySelector(${JSON.stringify(timeline)})?.dataset.windowRowCount)===${totalCount}`,
    ),
    "user scrolling exposes the actual Host history marker in the existing SessionPane",
  );
  const historyTriggerId = pageValue(
    `(() => { const body=document.querySelector(${JSON.stringify(body)}); const button=Array.from(body?.querySelectorAll('button[data-history-open="false"]') ?? []).find((item)=>item.getClientRects().length>0); return button?.getAttribute('data-testid') ?? null; })()`,
  );
  assertStep(
    Boolean(historyTriggerId),
    "paged older assistant history exposes its existing expand control",
  );
  browser("click", `button[data-testid="${historyTriggerId}"]`);
  await waitFor(
    "expanded oldest assistant message",
    visibleTextInBodyExpression("pi-review", "fixture-history-assistant-0"),
  );
  assertStep(
    pageValue(visibleTextInBodyExpression("pi-review", "fixture-history-assistant-0")),
    "expanding the older history row reveals its actual Host assistant message",
  );
  capture("first Pi expanded older history page", screenshots.externalHistoryPage);

  const backToBottomSelector = `${body} [data-testid="v4-timeline-bottom"]`;
  await waitFor(
    "existing back-to-bottom control after reading older history",
    `Boolean(document.querySelector(${JSON.stringify(backToBottomSelector)}))`,
  );
  browser("click", backToBottomSelector);
  await waitFor(
    "Pi A returns to its completed tail",
    `(() => { const timeline=document.querySelector(${JSON.stringify(timeline)}); return Boolean(timeline && timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 3); })()`,
  );
}
