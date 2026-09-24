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
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId("mounted-events")).toContainText("create:ws-active:");
  await expect(page.getByTestId("mounted-events")).toContainText("open:new-external:target:active");
  await expect(page.getByTestId("mounted-events")).not.toContainText("workspace:ws-active");
});
