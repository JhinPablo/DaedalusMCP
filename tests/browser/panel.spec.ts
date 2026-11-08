import { expect, test } from "@playwright/test";
import { emptyWorkspace, type AgentRun } from "../../src/shared/model";
import { Engine } from "../../src/shared/engine";
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

test("fondos Remotion día/noche, preferencias de vidrio y accesibilidad", async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  const media = (motion: string, transparency: string, forced = "none") =>
    cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: "light" },
        { name: "prefers-reduced-motion", value: motion },
        { name: "prefers-reduced-transparency", value: transparency },
        { name: "forced-colors", value: forced },
      ],
    });
  await media("no-preference", "no-preference");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const background = page.getByTestId("animated-background");
  await expect(background).toHaveAttribute("data-motion", "playing");
  await expect(background).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".sheet")).toHaveAttribute("data-glass", "clear");
  await expect
    .poll(() =>
      page.locator(".sheet").evaluate((el) => getComputedStyle(el).backdropFilter),
    )
    .not.toBe("none");
  const firstFrame = await background
    .locator("[data-frame]")
    .getAttribute("data-frame");
  await expect
    .poll(() => background.locator("[data-frame]").getAttribute("data-frame"))
    .not.toBe(firstFrame);
  const fontsBefore = await page
    .getByRole("heading", { name: "Habla con Daedalus" })
    .evaluate((el) => getComputedStyle(el).fontFamily);
  await page.getByLabel("Apariencia", { exact: true }).click();
  await page
    .getByLabel("Intensidad del vidrio en modo claro", { exact: true })
    .fill("0.4");
  await page.getByLabel("Animar fondo", { exact: true }).uncheck();
  await expect(background).toHaveAttribute("data-motion", "paused");
  await page.getByLabel("Apariencia", { exact: true }).click();
  await page.screenshot({ path: ".daedalus/qa/workshop-day.png", fullPage: true });
  await page.getByLabel("Apariencia", { exact: true }).click();
  await page.getByRole("combobox", { name: "Tema", exact: true }).selectOption("dark");
  await page
    .getByLabel("Intensidad del vidrio en modo oscuro", { exact: true })
    .fill("1.3");
  await expect(background).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".sheet")).toHaveAttribute("data-glass", "dark");
  await expect(background.locator("image")).toHaveAttribute(
    "href",
    /workshop-night\.png$/,
  );
  expect((await page.request.get("/backgrounds/workshop-night.png")).status()).toBe(
    200,
  );
  await page.getByLabel("Apariencia", { exact: true }).click();
  await page.screenshot({ path: ".daedalus/qa/workshop-night.png", fullPage: true });
  await page.reload();
  await expect(background).toHaveAttribute("data-theme", "dark");
  await expect(background).toHaveAttribute("data-motion", "paused");
  await page.getByLabel("Apariencia", { exact: true }).click();
  await expect(
    page.getByLabel("Intensidad del vidrio en modo claro", { exact: true }),
  ).toHaveValue("0.4");
  await expect(
    page.getByLabel("Intensidad del vidrio en modo oscuro", { exact: true }),
  ).toHaveValue("1.3");
  await page.getByLabel("Animar fondo", { exact: true }).check();
  await media("reduce", "reduce");
  await expect(background).toHaveAttribute("data-motion", "paused");
  await expect
    .poll(() =>
      page.locator(".sheet").evaluate((el) => getComputedStyle(el).backdropFilter),
    )
    .toBe("none");
  await expect(page.getByLabel("Animar fondo", { exact: true })).toBeDisabled();
  await page.getByLabel("Apariencia", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Enviar petición")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(
    await page
      .getByRole("heading", { name: "Habla con Daedalus" })
      .evaluate((el) => getComputedStyle(el).fontFamily),
  ).toBe(fontsBefore);
  await media("reduce", "no-preference");
  await page.screenshot({
    path: ".daedalus/qa/workshop-night-mobile.png",
    fullPage: true,
  });
  await media("reduce", "reduce", "active");
  await expect(background).toBeHidden();
  await expect(page.getByLabel("Enviar petición")).toBeVisible();
});

test("permisos legibles, enlaces de entrega y avisos sin duplicados", async ({
  page,
}) => {
  const state = emptyWorkspace(),
    at = new Date().toISOString();
  state.projects.push({
    id: "test",
    name: "Prueba",
    rootLabel: "fixture",
    connectorId: "test",
    createdAt: at,
  });
  const session = new Engine(state).createSession(
    { role: "owner", id: "owner" },
    "test",
    "Preview del cambio",
    "Cambiar la interfaz",
  );
  await page.addInitScript(
    ({ sessionId }) => {
      localStorage.setItem("daedalus:v1:selected-session", JSON.stringify(sessionId));
      const notices: Array<{ title: string; tag?: string }> = [];
      Object.assign(window, { __notices: notices });
      class FakeNotification {
        static permission = "default";
        static requestPermission = async () => {
          FakeNotification.permission = "granted";
          return "granted";
        };
        onclick = null;
        constructor(title: string, options: { tag?: string }) {
          notices.push({ title, tag: options.tag });
        }
        close() {}
      }
      Object.defineProperty(window, "Notification", { value: FakeNotification });
      Object.defineProperty(navigator, "serviceWorker", {
        value: {
          register: async () => {
            throw new Error("Desktop fallback test");
          },
          addEventListener() {},
          removeEventListener() {},
        },
      });
    },
    { sessionId: session.id },
  );
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.goto("/");
  expect(
    await page.evaluate(
      () => (window as unknown as { __notices: unknown[] }).__notices.length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Activar notificaciones" }).click();
  const run = {
    id: "run",
    sessionId: session.id,
    projectId: "test",
    kind: "task",
    taskId: "test-task",
    status: "waiting_permission",
    connectorId: "test",
    prompt: "",
    skills: [],
    createdAt: at,
    output: "",
  } as AgentRun;
  state.runs.push(run);
  state.permissions.push({
    id: "permission",
    runId: run.id,
    method: "item/commandExecution/requestApproval",
    description: '{"reason":"Ejecutar las pruebas del proyecto"}',
    details: {
      command: ["npm", "test"],
      cwd: "C:/proyecto",
      permissions: { network: { enabled: true } },
    },
    createdAt: at,
  });
  state.revision++;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(
    page.getByText("Ejecutar las pruebas del proyecto", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Carpeta de trabajo", { exact: true })).toBeVisible();
  await expect(page.getByText("C:/proyecto", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __notices: unknown[] }).__notices.length,
      ),
    )
    .toBe(1);
  state.revision++;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(
    page.getByText("Codex solicita tu autorización", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __notices: unknown[] }).__notices.length,
    ),
  ).toBe(1);
  state.permissions[0].decision = "accept";
  run.status = "completed";
  state.releases.push({
    id: "release",
    sessionId: session.id,
    repository: "JhinPablo/DaedalusMCP",
    branch: "daedalus/preview",
    commit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    tree: "c".repeat(40),
    prNumber: 2,
    prUrl: "https://github.com/JhinPablo/DaedalusMCP/pull/2",
    checks: "passed",
    status: "ready",
    previewUrl: "https://staging.workers.dev/?preview=" + "a".repeat(40),
    createdAt: at,
    updatedAt: at,
  });
  state.revision++;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(
    page.getByRole("link", { name: "Abrir preview verificada" }),
  ).toHaveAttribute("href", /preview=aaaa/);
  await expect(
    page.getByRole("link", { name: "Ver cambios del PR #2" }),
  ).toHaveAttribute("href", /pull\/2\/files$/);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __notices: unknown[] }).__notices.length,
      ),
    )
    .toBe(3);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: ".daedalus/qa/preview-alerts-mobile.png",
    fullPage: true,
  });
  state.permissions[0].decision = undefined;
  run.status = "waiting_permission";
  state.revision++;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Carpeta de trabajo", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".daedalus/qa/permissions-desktop.png",
    fullPage: true,
  });
  await page.goto("/?preview=" + "a".repeat(40));
  await expect(
    page.getByRole("alert").filter({ hasText: "Esta preview fue reemplazada" }),
  ).toBeVisible();
});
