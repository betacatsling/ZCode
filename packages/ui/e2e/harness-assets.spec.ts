import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/harness-assets.html");
});

test("actual HarnessIcon switches light/dark without changing harness identity on model update", async ({
  page,
}) => {
  const icon = page.getByTestId("harness-icon").first();
  await expect(icon.locator("img")).toBeVisible();
  const light = await icon.locator("img").getAttribute("src");
  expect(light).toMatch(/^data:image\/png;base64,/);
  await page.getByRole("button", { name: "Theme" }).click();
  await expect(icon.locator("img")).not.toHaveAttribute("src", light!);
  const dark = await icon.locator("img").getAttribute("src");
  expect(dark).toMatch(/^data:image\/png;base64,/);
  await page.getByRole("button", { name: "Model" }).click();
  await expect(page.getByTestId("model")).toHaveText("model2");
  await expect(icon).toHaveAttribute("data-harness", "pi");
  await expect(icon.locator("img")).toHaveAttribute("src", dark!);
  await expect(page.getByTestId("harness-icon").last()).toContainText("U");
});

test("missing/broken/malicious descriptors fall back with no external request", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:4179/")) external.push(request.url());
  });
  const icon = page.getByTestId("harness-icon").first();
  for (const mode of ["missing", "url", "svg", "oversized", "broken", "trailing", "throw"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(icon).toContainText("P");
    await expect(icon.locator("img")).toHaveCount(0);
  }
  expect(external).toEqual([]);
});
