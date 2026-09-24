import { expect, test } from "@playwright/test";

test("execution-unknown blocks duplicate admission; remount queries receipt without resending", async ({
  page,
}) => {
  await page.goto("/session-mounted.html");
  await expect(page.locator('[data-session-id="pi-one"]')).toBeVisible();
  await page.getByRole("button", { name: "Unknown next send" }).click();
  await page.getByTestId("external-draft-fixture").fill("one command");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Outcome unknown; check Host before a new command")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  const before = await page.getByTestId("dispatch-log").textContent();
  expect(before?.match(/pi-one:send:/g)).toHaveLength(1);
  await page.getByRole("button", { name: "Reconnect view" }).click();
  await page.getByRole("button", { name: "Reconnect view" }).click();
  await expect(page.locator('[data-session-id="pi-one"]')).toBeVisible();
  await expect(page.getByTestId("dispatch-log")).toHaveText(before ?? "");
  await expect(page.getByTestId("external-draft-fixture")).toHaveValue("");
  await expect(page.getByTestId("native-calls")).toHaveText("0");
});

test("unsupported text capability explains disabled composer and never calls native", async ({
  page,
}) => {
  await page.goto("/session-mounted.html");
  await expect(page.locator('[data-session-id="pi-one"]')).toBeVisible();
  await page.getByRole("button", { name: "Toggle text capability" }).click();
  await page.getByRole("button", { name: "Reconnect view" }).click();
  await expect(page.locator('[data-session-id="pi-one"]')).toBeVisible();
  await expect(page.getByTestId("external-draft-fixture")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveAttribute(
    "title",
    "Not supported by this harness",
  );
  await expect(page.getByTestId("dispatch-log")).toHaveText("");
  await expect(page.getByTestId("native-calls")).toHaveText("0");
});
