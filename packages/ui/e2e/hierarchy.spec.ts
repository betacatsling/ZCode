import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/hierarchy.html");
});

test("actual hierarchy preserves draft, caret and focus through background summary updates", async ({
  page,
}) => {
  await expect(page.getByTestId("workspace-main")).toContainText("Main checkout");
  await expect(page.getByTestId("workspace-main")).toContainText("Default");
  await expect(page.getByTestId("workspace-secret")).toHaveCount(0);
  await page.getByRole("button", { name: "1 hidden workspaces" }).click();
  await expect(page.getByTestId("session-s3").getByTestId("harness-icon")).toHaveAttribute(
    "data-harness",
    "unknown",
  );
  await expect(page.getByTestId("session-s3").getByTestId("harness-icon")).toContainText("U");
  await page.getByRole("button", { name: "1 hidden workspaces" }).click();
  await expect(page.getByTestId("workspace-remote")).toContainText("server1");
  await expect(page.getByTestId("workspace-remote")).toContainText("main");
  await expect(page.getByTestId("workspace-linked")).toContainText("2 agents");
  await expect(page.getByTestId("project-one")).toContainText("3 agents");
  await expect(page.getByTestId("project-one")).toContainText("1 waiting");
  await page.getByRole("button", { name: /Attention: Session s3/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("events")).toContainText("attention:s3");
  await expect(page.getByTestId("session-s1")).toBeVisible();
  await expect(page.getByTestId("session-s2")).toBeVisible();
  await expect(
    page.getByTestId("session-s1").getByTestId("harness-icon").locator("img"),
  ).toHaveCount(0);
  await expect(page.getByTestId("session-s1").getByTestId("harness-icon")).toContainText("P");
  await expect(page.getByTestId("session-s1").getByTestId("harness-icon")).toHaveAttribute(
    "data-harness",
    "pi",
  );
  await expect(page.getByTestId("session-s2").getByTestId("harness-icon")).toHaveAttribute(
    "data-harness",
    "pi",
  );
  await page.getByRole("button", { name: /New agent in linked/ }).click();
  const draft = page.getByRole("textbox", { name: "Draft" });
  await draft.fill("hello world");
  await draft.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5));
  await page
    .getByTestId("background-update")
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("hello world");
  expect(await draft.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(5);
  await expect(page.getByTestId("session-s2")).toHaveAttribute("title", /Provider C\/model3/);
  await expect(page.getByTestId("session-s2").getByTestId("harness-icon")).toHaveAttribute(
    "data-harness",
    "pi",
  );
  await expect(page.locator('[data-testid^="workspace-bulk-"]')).toHaveCount(50);
  for (let n = 0; n < 10; n++)
    await page
      .getByTestId("background-update")
      .evaluate((element: HTMLButtonElement) => element.click());
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("hello world");
});

test("separate create, adopt, hide, archive, remove and shared workspace agent actions", async ({
  page,
}) => {
  await page.getByRole("button", { name: /New agent in linked/ }).click();
  await expect(page.getByRole("dialog")).toContainText("share the same files");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId("events")).toContainText("agent:linked:pi");
  await page.getByRole("button", { name: /Create isolated workspace in Project one/ }).click();
  await expect(page.getByRole("dialog")).toContainText("isolated");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /Create isolated workspace in Project one/ }).click();
  await page.getByRole("textbox", { name: "Workspace title" }).fill("new workspace");
  await page.getByRole("textbox", { name: "Base ref" }).fill("main");
  await page.getByRole("textbox", { name: "Branch" }).fill("feature/new");
  await page.getByRole("textbox", { name: "Target directory" }).fill("/repos/new");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByTestId("events")).toContainText("create:binding-one");
  await page.getByRole("button", { name: /Discover worktrees in Project one/ }).click();
  await expect(page.getByTestId("events")).toContainText("discover:binding-one");
  await page.getByRole("button", { name: /Adopt candidate/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Adopt");
  await page.getByRole("button", { name: "Confirm adopt" }).click();
  await expect(page.getByTestId("events")).toContainText("adopt:binding-one:/repos/candidate");
  await page.getByRole("button", { name: /Hide linked/ }).click();
  await page.getByRole("button", { name: "Confirm hide" }).click();
  await expect(page.getByTestId("events")).toContainText("hide:linked");
  await page.getByRole("button", { name: /Archive linked/ }).click();
  await page.getByRole("button", { name: "Confirm archive" }).click();
  await expect(page.getByTestId("events")).toContainText("archive:linked");
  await page.getByRole("button", { name: /Remove linked/ }).click();
  await expect(page.getByRole("dialog")).toContainText("External activity");
  await page.getByRole("button", { name: "Confirm remove" }).click();
  await expect(page.getByTestId("events")).toContainText("remove:linked");
});
