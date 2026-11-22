import { expect, it, vi } from "vitest";
import { inside } from "../src/connector/config";
import { OpenCodeClient, modelRef, parsePlannerReply } from "../src/connector/opencode";
import path from "node:path";
import { ExecutionOutcomeError } from "../src/connector/outcome";
import { CodexClient, codexAppServerArgs } from "../src/connector/codex";

it("prefers native Windows isolation only for the local App Server process", () => {
  expect(codexAppServerArgs("win32")).toEqual([
    "app-server",
    "-c",
    "features.prefer_mxc=true",
    "--listen",
    "stdio://",
  ]);
  expect(codexAppServerArgs("linux")).toEqual(["app-server", "--listen", "stdio://"]);
});

it("does not advertise an unprovisioned Windows executor as ready", async () => {
  const client = Object.create(CodexClient.prototype) as CodexClient;
  const request = vi.spyOn(client, "request");
  request.mockResolvedValue({ status: "updateRequired" });
  await expect(client.requireExecutionReady("win32")).rejects.toThrow("no está listo");
  request.mockResolvedValue({ status: "ready" });
  await expect(client.requireExecutionReady("win32")).resolves.toBeUndefined();
  request.mockClear();
  await client.requireExecutionReady("linux");
  expect(request).not.toHaveBeenCalled();
});
it("limita rutas por componentes y no por prefijos", () => {
  const root = path.resolve("project");
  expect(inside(root, path.join(root, "src", "index.ts"))).toBe(true);
  expect(inside(root, root + "-other")).toBe(false);
  expect(inside(root, path.resolve(root, "..", "secret"))).toBe(false);
});
it("interpreta el proveedor y el modelo de OpenCode", () => {
  expect(modelRef("deepseek-v4.1-flash")).toEqual({
    providerID: "opencode",
    modelID: "deepseek-v4.1-flash",
    label: "opencode/deepseek-v4.1-flash",
  });
  expect(modelRef("opencode-go/deepseek-v4.1-flash")).toEqual({
    providerID: "opencode-go",
    modelID: "deepseek-v4.1-flash",
    label: "opencode-go/deepseek-v4.1-flash",
  });
});
it("acepta un modelo DeepSeek de pago disponible en el catálogo", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      providers: [
        {
          id: "opencode",
          models: {
            "deepseek-v4.1-flash": {
              name: "DeepSeek V4.1 Flash",
              cost: { input: 0.3, output: 1.2 },
              variants: { low: {}, high: {}, max: {} },
            },
          },
        },
      ],
    }),
  );
  try {
    await expect(
      new OpenCodeClient("http://127.0.0.1:4096", "deepseek-v4.1-flash").available(),
    ).resolves.toMatchObject([
      expect.objectContaining({
        id: "deepseek-v4.1-flash",
        providerID: "opencode",
        variants: ["low", "high", "max"],
      }),
    ]);
  } finally {
    fetchMock.mockRestore();
  }
});
it("rechaza modelos gratuitos y modelos ausentes del catálogo", async () => {
  await expect(
    new OpenCodeClient("http://127.0.0.1:4096", "deepseek-v4.1-flash-free").available(),
  ).rejects.toThrow("gratuito");
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ providers: [{ id: "opencode", models: {} }] }));
  try {
    await expect(
      new OpenCodeClient("http://127.0.0.1:4096", "deepseek-v4.1-flash").available(),
    ).rejects.toThrow("no está disponible");
  } finally {
    fetchMock.mockRestore();
  }
});
it("permite conversar sin fabricar una propuesta y conserva bloques de código", () => {
  const message = "Puedes pedir: ```tsx\n<App />\n```";
  const json = JSON.stringify({ kind: "message", message });
  expect(parsePlannerReply(json)).toEqual({ reply: message, output: json });
  expect(parsePlannerReply("```json\n" + json + "\n```").reply).toBe(message);
});
it("rechaza una propuesta incompleta y texto sin contrato", () => {
  expect(() => parsePlannerReply('{"kind":"proposal","message":"Listo"}')).toThrow(
    "sin incluirla",
  );
  expect(() => parsePlannerReply("Voy a ejecutar ahora")).toThrow("JSON");
});
it("interrumpe la petición y marca el modelo no disponible al agotar la cuota", async () => {
  const client = new OpenCodeClient("http://127.0.0.1:4096", "deepseek-v4.1-flash");
  const available = vi.spyOn(client, "available").mockResolvedValue([]);
  const call = vi
    .spyOn(client, "call")
    .mockImplementation(async (route, _body, signal) => {
      if (route.startsWith("/session?")) return { id: "test-session" };
      if (route.includes("/abort")) return true;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      });
    });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const event = {
              type: "session.status",
              properties: {
                sessionID: "test-session",
                status: {
                  type: "retry",
                  next: Date.now() + 60000,
                  action: { reason: "subscription_limit" },
                },
              },
            };
            controller.enqueue(
              new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n"),
            );
            controller.close();
          },
        }),
      ),
  );
  try {
    await expect(
      client.plan("Hola", process.cwd(), AbortSignal.timeout(1000), async () => {}),
    ).rejects.toThrow("límite de la suscripción");
    available.mockRestore();
    await expect(client.available()).rejects.toThrow("límite de la suscripción");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    call.mockRestore();
    available.mockRestore();
    fetchMock.mockRestore();
  }
});
it("envía la modalidad por separado y bloquea una revisión negativa", async () => {
  const client = new OpenCodeClient(
    "http://127.0.0.1:4096",
    "deepseek-v4.1-flash",
    undefined,
    "max",
  );
  vi.spyOn(client, "available").mockResolvedValue([]);
  const call = vi.spyOn(client, "call").mockImplementation(async (route) =>
    route.startsWith("/session?")
      ? { id: "review" }
      : {
          info: {},
          parts: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "changes_requested",
                report: "No cumple. Falta verificar las pruebas.",
              }),
            },
          ],
        },
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      ),
  );
  try {
    await expect(
      client.review(
        "Revisa",
        process.cwd(),
        new AbortController().signal,
        async () => {},
      ),
    ).rejects.toBeInstanceOf(ExecutionOutcomeError);
    expect(call).toHaveBeenCalledWith(
      expect.stringContaining("/message"),
      expect.objectContaining({
        model: { providerID: "opencode", modelID: "deepseek-v4.1-flash" },
        variant: "max",
        tools: expect.objectContaining({ edit: false, task: false }),
      }),
      expect.any(AbortSignal),
    );
  } finally {
    vi.restoreAllMocks();
  }
});
