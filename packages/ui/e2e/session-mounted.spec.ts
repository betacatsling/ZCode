import { expect, test } from "@playwright/test";

test("actual mounted SessionPane keeps Pi sessions separate; reattach does not resend", async ({
  page,
}, testInfo) => {
  await page.goto("/session-mounted.html");
  const pane = page.locator('[data-session-id="pi-one"]');
  const first = page.getByTestId("external-draft-fixture");
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-harness="pi"]')).toBeVisible();
  await expect(pane).toContainText("fixture-provider / model-one");
  await first.fill("first draft");
  await page.getByRole("button", { name: "Pi two" }).click();
  await expect(page.locator('[data-session-id="pi-two"]')).toBeVisible();
  await expect(page.locator('[data-session-id="pi-two"]')).toContainText(
    "fixture-provider / model-two",
  );
  await page.getByTestId("external-draft-fixture").fill("second prompt");
  await page.getByRole("button", { name: "Pi one" }).click();
  await expect(page.getByTestId("external-draft-fixture")).toHaveValue("first draft");
  await page.getByRole("button", { name: "Pi two" }).click();
  await expect(page.getByTestId("external-draft-fixture")).toHaveValue("second prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("dispatch-log")).toContainText("pi-two:send:");
  await expect(page.getByTestId("native-calls")).toHaveText("0");
  const before = await page.getByTestId("dispatch-log").textContent();
  await page.getByRole("button", { name: "Reconnect view" }).click();
  await expect(page.getByText("View detached; Host continues")).toBeVisible();
  await page.getByRole("button", { name: "Reconnect view" }).click();
  await expect(page.locator('[data-session-id="pi-two"]')).toBeVisible();
  await expect(page.getByTestId("dispatch-log")).toHaveText(before ?? "");
  await page.getByRole("button", { name: "Native unknown" }).click();
  await expect(page.getByRole("alert")).toHaveText("Session owner unresolved");
  await expect(page.getByTestId("native-calls")).toHaveText("0");
  await testInfo.attach(`${testInfo.project.name}-mounted-session`, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("background Host event does not steal another Pi draft focus", async ({ page }) => {
  await page.goto("/session-mounted.html");
  await expect(page.locator('[data-session-id="pi-one"]')).toBeVisible();
  await page.getByTestId("external-draft-fixture").fill("first prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("dispatch-log")).toContainText("pi-one:send:");
  await page.getByRole("button", { name: "Pi two" }).click();
  const draft = page.getByTestId("external-draft-fixture");
  await draft.fill("unsent second draft");
  await expect(draft).toBeFocused();
  await page.evaluate(() =>
    (window as Window & { __mountedBackgroundEvent: () => void }).__mountedBackgroundEvent(),
  );
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("unsent second draft");
  await expect(page.getByTestId("native-calls")).toHaveText("0");
});

test("mounted approval rejects without optimistic success, then accepts against current turn", async ({
  page,
}) => {
  await page.goto("/session-mounted.html");
  await expect(page.locator('[data-session-id="pi-one"]')).toBeVisible();
  await page.getByTestId("external-draft-fixture").fill("request tool");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("dispatch-log")).toContainText("pi-one:send:");
  await page.getByRole("button", { name: "Request approval" }).click();
  const approval = page.getByTestId("external-approval-approval-1");
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("alert")).toContainText("unsupported");
  await expect(approval).toBeVisible();
  await page.getByRole("button", { name: "Accept next approval" }).click();
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(approval).not.toBeVisible();
  await expect(page.getByTestId("native-calls")).toHaveText("0");
});
