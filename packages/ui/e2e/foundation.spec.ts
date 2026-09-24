import { expect, test } from "@playwright/test";

// Fixture-only smoke: these selectors are NOT ProjectSidebar/facade acceptance selectors.
test("published UI button preserves keyboard focus and fixture draft through rerender", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Fixture draft" });
  const button = page.getByRole("button", { name: "Fixture update" });
  await expect(button).toHaveAttribute("data-slot", "button");

  await page.keyboard.press("Tab");
  await expect(draft).toBeFocused();
  await page.keyboard.type("isolated draft");
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("fixture-updates")).toHaveText("1");
  await expect(draft).toHaveValue("isolated draft");

  await draft.focus();
  await page
    .getByTestId("fixture-external-update")
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByTestId("fixture-updates")).toHaveText("2");
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("isolated draft");
  await testInfo.attach(`${testInfo.project.name}-smoke`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});
