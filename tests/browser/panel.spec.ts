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
