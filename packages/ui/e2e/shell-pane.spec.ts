import { expect, test } from "@playwright/test";

test("real shell routes two Pi sessions from Catalog without creating or native navigation", async ({
  page,
}) => {
  await page.goto("/shell-pane.html");
  await expect(page.getByRole("heading", { name: "Project", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Pi one/ }).click();
  await expect(page.locator('[data-session-id="pi-one"]')).toBeVisible();
  await expect(page.locator('[data-session-id="pi-one"]')).toContainText("model-one");
  await page.getByTestId("external-draft-workspace-main").fill("draft one");
  await page.getByRole("button", { name: /Pi two/ }).click();
  await expect(page.locator('[data-session-id="pi-two"]')).toBeVisible();
  await page.getByTestId("external-draft-workspace-main").fill("draft two");
  await page.getByRole("button", { name: /Pi one/ }).click();
  await expect(page.getByTestId("external-draft-workspace-main")).toHaveValue("draft one");
  await page.getByRole("button", { name: /Pi two/ }).click();
  await expect(page.getByTestId("external-draft-workspace-main")).toHaveValue("draft two");
  await expect(page.getByTestId("native-calls")).toHaveText("0");
  await expect(page.getByTestId("create-calls")).toHaveText("0");
  await expect(page.getByTestId("shell-events")).not.toContainText("native-navigation:pi-");
});

test("unresolved catalog row never opens native task or creates session", async ({ page }) => {
  await page.goto("/shell-pane.html");
  await page.getByRole("button", { name: /Unknown owner/ }).click();
  await expect(page.getByTestId("shell-events")).toContainText("resolve:orphan");
  await expect(page.getByTestId("shell-events")).not.toContainText("native-navigation:orphan");
  await expect(page.getByTestId("native-calls")).toHaveText("0");
  await expect(page.getByTestId("create-calls")).toHaveText("0");
});

test("restored unproven pane cannot subscribe native even when focused", async ({ page }) => {
  await page.goto("/shell-pane.html");
  await page.getByRole("button", { name: "Restore unproven binding" }).click();
  await expect(page.getByText("Session owner unresolved")).toBeVisible();
  await expect(page.getByTestId("native-calls")).toHaveText("0");
  await expect(page.getByTestId("create-calls")).toHaveText("0");
});

test("real shell uses original native ID rather than Catalog alias", async ({ page }) => {
  await page.goto("/shell-pane.html");
  await page.getByRole("button", { name: /Native session/ }).click();
  await expect(page.getByTestId("shell-events")).toContainText("native-navigation:original-native");
  await expect(page.getByTestId("shell-events")).not.toContainText(
    "native-navigation:alias-native",
  );
  await expect(page.getByTestId("create-calls")).toHaveText("0");
});
