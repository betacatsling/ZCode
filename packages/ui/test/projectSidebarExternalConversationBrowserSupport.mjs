import { request as httpRequest } from "node:http";

export const externalTimelineSelector = '[data-v4-timeline-scroll="true"]';

export function externalBodySelector(sessionId) {
  return `[data-external-conversation-body="true"][data-owner-session-id="${sessionId}"]`;
}

export function visibleTextInBodyExpression(sessionId, text) {
  return `(() => {
    const body = document.querySelector(${JSON.stringify(externalBodySelector(sessionId))});
    const timeline = body?.querySelector(${JSON.stringify(externalTimelineSelector)});
    if (!body || !timeline) return false;
    const viewport = timeline.getBoundingClientRect();
    const needle = ${JSON.stringify(text)};
    for (const row of body.querySelectorAll("[data-row-id]")) {
      if (!(row.innerText ?? "").includes(needle)) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const segments = [];
      let combined = "";
      let node;
      while ((node = walker.nextNode())) {
        const content = node.textContent ?? "";
        segments.push({ node, start: combined.length, end: combined.length + content.length });
        combined += content;
      }
      const start = combined.indexOf(needle);
      if (start < 0) continue;
      const end = start + needle.length;
      const first = segments.find((segment) => segment.end > start);
      const last = segments.findLast((segment) => segment.start < end);
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      for (const rect of range.getClientRects()) {
        let left = Math.max(rect.left, viewport.left);
        let right = Math.min(rect.right, viewport.right);
        let top = Math.max(rect.top, viewport.top);
        let bottom = Math.min(rect.bottom, viewport.bottom);
        let parent = first.node.parentElement;
        let visible = rect.width > 0 && rect.height > 0;
        while (visible && parent && body.contains(parent)) {
          const style = getComputedStyle(parent);
          if (parent.hidden || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            visible = false;
            break;
          }
          const bounds = parent.getBoundingClientRect();
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) {
            left = Math.max(left, bounds.left);
            right = Math.min(right, bounds.right);
          }
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) {
            top = Math.max(top, bounds.top);
            bottom = Math.min(bottom, bounds.bottom);
          }
          if (parent === body) break;
          parent = parent.parentElement;
        }
        if (visible && right > left && bottom > top) return true;
      }
    }
    return false;
  })()`;
}

export function visibleRowExpression(sessionId, rowId) {
  return `(() => {
    const body = document.querySelector(${JSON.stringify(externalBodySelector(sessionId))});
    const timeline = body?.querySelector(${JSON.stringify(externalTimelineSelector)});
    if (!body || !timeline) return false;
    const viewport = timeline.getBoundingClientRect();
    return Array.from(body.querySelectorAll("[data-row-id]"))
      .filter((row) => row.getAttribute("data-row-id") === ${JSON.stringify(String(rowId))})
      .some((row) => {
        const style = getComputedStyle(row);
        const bounds = row.getBoundingClientRect();
        return !row.hidden && style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 && bounds.width > 0 && bounds.height > 0 &&
          bounds.bottom > viewport.top && bounds.top < viewport.bottom &&
          bounds.right > viewport.left && bounds.left < viewport.right;
      });
  })()`;
}

export function visibleRowTextExpression(sessionId, rowId, text) {
  return `(() => {
    const body = document.querySelector(${JSON.stringify(externalBodySelector(sessionId))});
    const timeline = body?.querySelector(${JSON.stringify(externalTimelineSelector)});
    if (!body || !timeline) return false;
    const viewport = timeline.getBoundingClientRect();
    const needle = ${JSON.stringify(text)};
    return Array.from(body.querySelectorAll("[data-row-id]"))
      .filter((row) => row.getAttribute("data-row-id") === ${JSON.stringify(String(rowId))})
      .some((row) => {
        const content = row.querySelector('[data-conversation-selectable="true"]') ?? row;
        if (!(content.innerText ?? "").includes(needle)) return false;
        let left = Math.max(content.getBoundingClientRect().left, viewport.left);
        let right = Math.min(content.getBoundingClientRect().right, viewport.right);
        let top = Math.max(content.getBoundingClientRect().top, viewport.top);
        let bottom = Math.min(content.getBoundingClientRect().bottom, viewport.bottom);
        let parent = content;
        while (parent && body.contains(parent)) {
          const style = getComputedStyle(parent);
          if (parent.hidden || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const bounds = parent.getBoundingClientRect();
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) {
            left = Math.max(left, bounds.left);
            right = Math.min(right, bounds.right);
          }
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) {
            top = Math.max(top, bounds.top);
            bottom = Math.min(bottom, bounds.bottom);
          }
          if (parent === body) break;
          parent = parent.parentElement;
        }
        return right > left && bottom > top;
      });
  })()`;
}

export function visibleApprovalExpression() {
  return `(() => {
    const button = document.querySelector('[data-permission-option-kind="allowOnce"]');
    if (!button) return false;
    const buttonBounds = button.getBoundingClientRect();
    const buttonStyle = getComputedStyle(button);
    if (button.hidden || buttonStyle.display === "none" || buttonStyle.visibility === "hidden" ||
        Number(buttonStyle.opacity) === 0 || buttonBounds.width === 0 || buttonBounds.height === 0) return false;
    let region = button;
    while (region && region !== document.body) {
      if ((region.innerText ?? "").includes("Write fixture file?")) {
        const bounds = region.getBoundingClientRect();
        const style = getComputedStyle(region);
        return !region.hidden && style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 && bounds.width > 0 && bounds.height > 0;
      }
      region = region.parentElement;
    }
    return false;
  })()`;
}

export async function readHostCounters(hostDriverUrl) {
  return requestHostJson(`${hostDriverUrl}/__agent-host/counters`);
}

export async function readHostSnapshot(hostDriverUrl, sessionId) {
  const { snapshots } = await readHostCounters(hostDriverUrl);
  const snapshot = snapshots[sessionId];
  if (!snapshot) throw new Error(`Host snapshot missing for ${sessionId}`);
  return snapshot;
}

export async function waitForHostSnapshot(
  hostDriverUrl,
  sessionId,
  label,
  predicate,
  sleep,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await readHostSnapshot(hostDriverUrl, sessionId);
    if (predicate(snapshot)) return snapshot;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for Host ${label}: ${JSON.stringify(snapshot)}`);
}

export async function postStaleApprovalProbe(hostDriverUrl, sessionId, mismatch) {
  return requestHostJson(`${hostDriverUrl}/__agent-host/test/stale-approval`, {
    method: "POST",
    body: { sessionId, mismatch },
  });
}

export async function postHoldAfterApproval(hostDriverUrl, sessionId) {
  return requestHostJson(`${hostDriverUrl}/__agent-host/test/hold-after-approval`, {
    method: "POST",
    body: { sessionId },
  });
}

async function requestHostJson(url, { method = "GET", body } = {}) {
  const endpoint = new URL(url);
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: endpoint.hostname,
        port: Number(endpoint.port),
        path: `${endpoint.pathname}${endpoint.search}`,
        method,
        ...(serializedBody === undefined
          ? {}
          : {
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(serializedBody),
              },
            }),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(
              new Error(`Host request failed (${response.statusCode}): ${JSON.stringify(result)}`),
            );
            return;
          }
          resolve(result);
        });
      },
    );
    request.on("error", reject);
    request.end(serializedBody);
  });
}
