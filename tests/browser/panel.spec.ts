import { expect, test } from "@playwright/test";
import { emptyWorkspace, type AgentRun } from "../../src/shared/model";
import { Engine } from "../../src/shared/engine";
test("configuración compacta y nuevo chat dentro de la navegación", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByLabel("Tu petición", { exact: true })).toBeVisible();
  await expect(page.locator("main .page-heading")).toHaveCount(0);
  await expect(page.locator("main .browser-notifications")).toHaveCount(0);
  const log = await page.getByLabel("Mensajes de la conversación").boundingBox();
  expect(log!.y).toBeLessThan(110);
  const entry = page
    .locator("nav .nav-entry")
    .filter({ has: page.getByRole("button", { name: "Chats", exact: true }) });
  await expect(
    entry.getByRole("button", { name: "Nuevo chat", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Nuevo chat", exact: true }),
  ).toHaveCount(1);
  await page
    .getByLabel("Tu petición", { exact: true })
    .fill("Un borrador antes de abrir los ajustes");
  for (const [width, height] of [
    [1440, 900],
    [390, 600],
  ]) {
    await page.setViewportSize({ width, height });
    await page.getByLabel("Configuración", { exact: true }).click();
    const settings = page.getByRole("region", { name: "Configuración del taller" });
    await expect(settings).toBeVisible();
    await expect(
      settings.getByRole("combobox", { name: "Tema", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: /Activar notificaciones|Pausar avisos/ }),
    ).toBeVisible();
    const box = await settings.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    if (width === 1440)
      await page.screenshot({
        path: ".daedalus/qa/settings-desktop.png",
        fullPage: true,
      });
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(page.getByLabel("Tu petición", { exact: true })).toHaveValue(
      "Un borrador antes de abrir los ajustes",
    );
    if (width === 390) {
      await page.getByLabel("Abrir navegación").click();
      await entry.getByRole("button", { name: "Nuevo chat", exact: true }).click();
      await expect(page.getByLabel("Tu petición", { exact: true })).toBeEmpty();
      await expect(page.getByLabel("Tu petición", { exact: true })).toBeFocused();
      await page.screenshot({
        path: ".daedalus/qa/chat-compact-mobile.png",
        fullPage: true,
      });
    }
  }
});
test("el editor aprovecha el ancho y el contexto se adapta sin perder el borrador", async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "dark" },
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "no-preference" },
    ],
  });
  await page.goto("/");
  await page
    .getByLabel("Tu petición", { exact: true })
    .fill("Este borrador permanece al abrir el contexto.");
  await expect(page.locator(".app-footer")).toHaveCount(0);
  await expect(page.getByText("Ingenio, con intención.")).toHaveCount(0);
  for (const [width, height] of [
    [1920, 900],
    [1440, 900],
    [1100, 800],
    [768, 900],
    [390, 844],
    [1280, 600],
  ]) {
    await page.setViewportSize({ width, height });
    const chat = await page.locator(".conversation-main").boundingBox();
    const composer = await page.locator(".conversation-main .composer").boundingBox();
    expect(composer!.width / chat!.width).toBeGreaterThan(0.94);
    expect(composer!.height).toBeLessThan(250);
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(height);
    if (width === 1920)
      await page.screenshot({ path: ".daedalus/qa/chat-wide.png", fullPage: true });
    await page.getByLabel("Ver flujo de ideas").click();
    const panel = page.getByLabel("Contexto de la conversación");
    await expect(panel).toBeVisible();
    const context = await panel.boundingBox();
    expect(context!.x + context!.width).toBeLessThanOrEqual(width);
    if (width > 900) {
      await expect(page.getByLabel("Tu petición", { exact: true })).toBeVisible();
      const remaining = await page.locator(".conversation-main").boundingBox();
      const editor = await page.locator(".conversation-main .composer").boundingBox();
      expect(remaining!.width).toBeGreaterThan(320);
      expect(editor!.width / remaining!.width).toBeGreaterThan(0.92);
      expect(editor!.x + editor!.width).toBeLessThanOrEqual(context!.x);
    } else await expect(page.getByLabel("Cerrar contexto")).toBeVisible();
    if (width === 1440)
      await page.screenshot({ path: ".daedalus/qa/chat-context.png", fullPage: true });
    await page.getByLabel("Cerrar contexto").click();
    await expect(page.getByLabel("Tu petición", { exact: true })).toHaveValue(
      "Este borrador permanece al abrir el contexto.",
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  }
});
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
  await page.getByRole("button", { name: "Chats", exact: true }).click();
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
  await page.getByLabel("Configuración", { exact: true }).click();
  await page
    .getByLabel("Intensidad del vidrio en modo claro", { exact: true })
    .fill("0.4");
  await page.getByLabel("Animar fondo", { exact: true }).uncheck();
  await expect(background).toHaveAttribute("data-motion", "paused");
  await page.getByLabel("Configuración", { exact: true }).click();
  await page.screenshot({ path: ".daedalus/qa/workshop-day.png", fullPage: true });
  await page.getByLabel("Configuración", { exact: true }).click();
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
  await page.getByLabel("Configuración", { exact: true }).click();
  await page.screenshot({ path: ".daedalus/qa/workshop-night.png", fullPage: true });
  await page.reload();
  await expect(background).toHaveAttribute("data-theme", "dark");
  await expect(background).toHaveAttribute("data-motion", "paused");
  await page.getByLabel("Configuración", { exact: true }).click();
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
  await page.getByLabel("Configuración", { exact: true }).click();
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
      Reflect.deleteProperty(window, "PushManager");
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
  await expect(
    page.getByRole("button", { name: "Activar notificaciones" }),
  ).toBeHidden();
  await page.getByLabel("Configuración", { exact: true }).click();
  await page.getByRole("button", { name: "Activar notificaciones" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("region", { name: "Configuración del taller" }),
  ).toBeHidden();
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
test("uso Go visible en móvil y selección remota de modelo y modalidad", async ({
  page,
}) => {
  const state = emptyWorkspace();
  state.projects.push({
    id: "go",
    name: "Go",
    rootLabel: "go",
    connectorId: "go",
    createdAt: new Date().toISOString(),
  });
  const window = {
    status: "ok",
    usedPercent: 7,
    remainingPercent: 93,
    resetsAt: new Date(Date.now() + 3600000).toISOString(),
  };
  state.connectors.push({
    id: "go",
    name: "Equipo",
    codex: true,
    opencode: true,
    lastSeen: new Date().toISOString(),
    model: "deepseek-v4.1-flash",
    modelVariant: "high",
    models: [
      {
        id: "deepseek-v4.1-flash",
        providerID: "opencode",
        name: "DeepSeek Flash",
        variants: ["low", "high", "max"],
      },
      {
        id: "deepseek-v4-pro",
        providerID: "opencode",
        name: "DeepSeek Pro",
        variants: ["high", "max"],
      },
    ],
    usage: {
      connected: true,
      updatedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      windows: { rolling: window, weekly: window, monthly: window },
    },
  });
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.route("**/api/engines/opencode", async (route) => {
    const selected = route.request().postDataJSON();
    state.engines = { opencode: { ...selected, updatedAt: new Date().toISOString() } };
    state.revision++;
    await route.fulfill({ json: state.engines.opencode });
  });
  await page.goto("/");
  const badge = page.getByRole("button", { name: "Consultar uso de OpenCode Go" });
  await expect(badge).toContainText("93%");
  await badge.click();
  const model = page.getByRole("combobox", { name: "Modelo de planeación y revisión" });
  const variant = page.getByRole("combobox", { name: "Modalidad de razonamiento" });
  await expect(variant).toHaveValue("high");
  await model.selectOption("deepseek-v4-pro");
  await variant.selectOption("max");
  await page.getByRole("button", { name: "Aplicar selección" }).click();
  await expect(model).toHaveValue("deepseek-v4-pro");
  state.engines = {
    opencode: {
      model: "deepseek-v4.1-flash",
      variant: "low",
      updatedAt: "2026-11-21T12:00:00Z",
    },
  };
  state.revision++;
  await page.getByLabel("Actualizar estado").click();
  await expect(variant).toHaveValue("low");
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(badge).toBeVisible();
  const box = await badge.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test("PWA manifest, installation control and private offline fallback", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  const manifest = await page.request
    .get("/manifest.webmanifest")
    .then((r) => r.json());
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toContain("512x512");
  for (const icon of manifest.icons)
    expect((await page.request.get(icon.src)).ok()).toBe(true);
  await page.getByLabel("Configuración", { exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Sonido de notificaciones" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt");
    Object.assign(event, {
      prompt: async () => {},
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    window.dispatchEvent(event);
  });
  await page.getByRole("button", { name: "Instalar Daedalus" }).click();
  await expect(page.getByRole("button", { name: "Instalar Daedalus" })).toHaveCount(0);
  await context.setOffline(true);
  try {
    await page.goto("/offline-check");
    await expect(
      page.getByRole("heading", { name: "Tu taller sigue aquí" }),
    ).toBeVisible();
    await expect(
      page.getByText("No se muestran copias privadas sin conexión.", { exact: false }),
    ).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("push opt-in, sound preferences and remote unsubscribe", async ({ page }) => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/push/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST")
      requests.push({ path, body: route.request().postDataJSON() });
    await route.fulfill({
      json: path.endsWith("/key") ? { publicKey: "B".repeat(87) } : { ok: true },
    });
  });
  await page.addInitScript(() => {
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/browser-test",
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/fcm/send/browser-test",
        expirationTime: null,
        keys: { auth: "a".repeat(22), p256dh: "b".repeat(87) },
      }),
      unsubscribe: async () => true,
    };
    const registration = {
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => subscription,
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        register: async () => registration,
        ready: Promise.resolve(registration),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    Object.defineProperty(window, "Notification", {
      value: class {
        static permission = "default";
        static requestPermission = async () => "granted";
      },
    });
  });
  await page.goto("/");
  await page.getByLabel("Configuración", { exact: true }).click();
  await page.getByRole("button", { name: "Activar notificaciones" }).click();
  await expect(page.getByText("Push conectado:", { exact: false })).toBeVisible();
  await page.getByRole("checkbox", { name: "Sonido de notificaciones" }).uncheck();
  await expect
    .poll(() =>
      requests.some((r) => r.path.endsWith("/subscribe") && r.body.sound === false),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Probar notificación push" }).click();
  await expect.poll(() => requests.some((r) => r.path.endsWith("/test"))).toBe(true);
  await page.getByRole("button", { name: "Pausar avisos" }).click();
  await expect(
    page.getByRole("button", { name: "Activar notificaciones" }),
  ).toBeVisible();
  expect(requests.some((r) => r.path.endsWith("/unsubscribe"))).toBe(true);
});
