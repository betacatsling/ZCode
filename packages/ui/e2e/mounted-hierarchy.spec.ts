import { expect, test } from "@playwright/test";

test("mounted hierarchy queries authoritative owner and keeps stale catalog on disconnect", async ({
  page,
}) => {
  await page.goto("/mounted-hierarchy.html");
  await expect(page.getByTestId("project-empty")).toBeVisible();
  await expect(page.getByTestId("workspace-ws-empty")).toContainText("Main checkout");
  await expect(page.getByRole("button", { name: /Remove Workspace empty/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Attention: Native original ID/ }).click();
  await expect(page.getByTestId("mounted-events")).toContainText(
    "resolve:active:ws-active:tree-alias",
  );
  await expect(page.getByTestId("mounted-events")).toContainText(
    "open:original-native-id:target:active",
  );
  await page.getByRole("button", { name: /Remove Workspace active/ }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "External processes may race after this preview",
  );
  await page.getByRole("button", { name: "Confirm remove" }).click();
  await expect(page.getByRole("dialog")).toContainText("Target removal rejected: dirty worktree");
  await expect(page.getByTestId("mounted-events")).toContainText("remove:ws-active:gen-active");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Toggle offline" }).click();
  await expect(page.getByRole("alert")).toContainText("offline");
  await expect(page.getByTestId("workspace-ws-active")).toBeVisible();
  await page.getByRole("button", { name: /Remove Workspace active/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Target removal preview unavailable");
  await expect(page.getByRole("button", { name: "Confirm remove" })).toBeDisabled();
});

test("import failure keeps form open and valid target adds a zero-session project", async ({
  page,
}) => {
  await page.goto("/mounted-hierarchy.html");
  await page.getByRole("button", { name: "Import project" }).click();
  await page.getByRole("textbox", { name: "Project name" }).fill("Imported");
  await page.getByRole("textbox", { name: "Trusted target ID" }).fill("unknown");
  await page.getByRole("textbox", { name: "Repository path" }).fill("/repo/new");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Unknown target");
  await expect(page.getByRole("textbox", { name: "Project name" })).toHaveValue("Imported");
  await page.getByRole("textbox", { name: "Trusted target ID" }).fill("active");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("mounted-events")).toContainText("import:active:/repo/new");
  await expect(page.getByRole("heading", { name: "Imported" })).toBeVisible();
});

test("mounted hierarchy creates an agent without creating a worktree", async ({ page }) => {
  await page.goto("/mounted-hierarchy.html");
  await page.getByRole("button", { name: /New agent in Workspace active/ }).click();
  await expect(page.getByRole("dialog")).toContainText("share the same files");
  await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
    "Provider A / Model B / high",
  );
  await expect(page.getByRole("combobox", { name: "Model" })).not.toContainText(
    "Other target only",
  );
  await expect(page.getByRole("radio", { name: /Codex/ })).toBeDisabled();
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("dialog")).toContainText("Host rejected creation");
  await expect(page.getByTestId("mounted-events")).toContainText(
    '"providerId":"provider-a","modelId":"model-b","options":{"reasoningLevel":"high"}',
  );
  await page.getByRole("button", { name: "Create agent" }).click();
  const commands = await page.getByTestId("mounted-events").textContent();
  const ids = [...(commands ?? "").matchAll(/create:ws-active:([a-f0-9-]+):/g)].map(
    (match) => match[1],
  );
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Allow create" }).click();
  await page.getByRole("button", { name: /New agent in Workspace active/ }).click();
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId("mounted-events")).toContainText("create:ws-active:");
  await expect(page.getByTestId("mounted-events")).toContainText("open:new-external:target:active");
  await expect(page.getByTestId("mounted-events")).not.toContainText("workspace:ws-active");
});

test("model outage disables only that workspace; no fabricated fallback", async ({ page }) => {
  await page.goto("/mounted-hierarchy.html");
  await expect(page.getByTestId("project-active")).toBeVisible();
  await page.getByRole("button", { name: "Disable active options" }).click();
  await page.getByRole("button", { name: /New agent in Workspace active/ }).click();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Model" })).not.toContainText("Harness-managed");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: /New agent in Workspace empty/ }).click();
  await expect(page.getByRole("combobox", { name: "Model" })).toContainText("Other target only");
});

test("model choices are scoped to the selected workspace, not the target intersection", async ({
  page,
}) => {
  await page.goto("/mounted-hierarchy.html");
  await page.getByRole("button", { name: /New agent in Workspace empty/ }).click();
  await expect(page.getByRole("radio", { name: /Codex/ })).toBeEnabled();
  await page.getByRole("radio", { name: /Codex/ }).check();
  await expect(page.getByRole("combobox", { name: "Model" })).toContainText("Codex target choice");
  await expect(page.getByRole("combobox", { name: "Model" })).not.toContainText(
    "Provider A / Model B / high",
  );
});

test("late old refresh rejection cannot offline a newer snapshot; current offline blocks navigation and recovers", async ({
  page,
}) => {
  await page.goto("/mounted-hierarchy.html");
  await expect(page.getByTestId("workspace-ws-active")).toBeVisible();
  await page.getByRole("button", { name: "Hold old refresh" }).click();
  await page.getByRole("button", { name: "Refresh now" }).click();
  await page.getByRole("button", { name: "Reject old refresh" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: /Attention: Native original ID/ }).click();
  await expect(page.getByTestId("mounted-events")).toContainText("open:original-native-id");
  await page.getByRole("button", { name: "Toggle offline" }).click();
  await expect(page.getByRole("alert")).toContainText("offline");
  const before = await page.getByTestId("mounted-events").textContent();
  await page.getByRole("button", { name: /Attention: Native original ID/ }).click();
  expect(await page.getByTestId("mounted-events").textContent()).toBe(before);
  await page.getByRole("button", { name: "Toggle offline" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: /Attention: Native original ID/ }).click();
  await expect(page.getByTestId("mounted-events")).not.toHaveText(before ?? "");
});

test("public hierarchy choices reject a mismatched generation and recover from Model outage", async ({
  page,
}) => {
  await page.goto("/mounted-hierarchy.html");
  await page.getByRole("button", { name: "Toggle stale options generation" }).click();
  await page.getByRole("button", { name: /New agent in Workspace active/ }).click();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Toggle stale options generation" }).click();
  await page.getByRole("button", { name: "Disable active options" }).click();
  await page.getByRole("button", { name: /New agent in Workspace active/ }).click();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Restore active options" }).click();
  await page.getByRole("button", { name: /New agent in Workspace active/ }).click();
  await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
    "Provider A / Model B / high",
  );
});
