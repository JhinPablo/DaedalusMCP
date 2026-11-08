import { expect, test } from "@playwright/test";
test("chat persistente, contexto secundario y publicaciones", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Enviar petición")).toBeVisible();
  await page
    .getByLabel("Tu petición", { exact: true })
    .fill("Conserva este borrador durante una actualización.");
  await page.reload();
  await expect(page.getByLabel("Tu petición", { exact: true })).toHaveValue(
    "Conserva este borrador durante una actualización.",
  );
  await page.getByLabel("Ver flujo de ideas").click();
  await expect(page.getByLabel("Contexto de la conversación")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Contexto de la conversación")).toHaveCount(0);
  await page.getByRole("button", { name: "Publicaciones", exact: true }).click();
  await expect(page.getByText("Todavía no hay candidatos")).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Enviar petición")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
