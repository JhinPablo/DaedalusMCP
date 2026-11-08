import { expect, it, vi } from "vitest";
import { inside } from "../src/connector/config";
import { OpenCodeClient, parsePlannerReply } from "../src/connector/opencode";
import path from "node:path";
it("limita rutas por componentes y no por prefijos", () => {
  const root = path.resolve("project");
  expect(inside(root, path.join(root, "src", "index.ts"))).toBe(true);
  expect(inside(root, root + "-other")).toBe(false);
  expect(inside(root, path.resolve(root, "..", "secret"))).toBe(false);
});
it("rechaza modelos DeepSeek de pago antes de hacer red", async () => {
  await expect(
    new OpenCodeClient("http://127.0.0.1:4096", "deepseek-v4.1-flash").available(),
  ).rejects.toThrow("gratuito");
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
it("interrumpe la petición y marca el modelo no disponible al agotar el cupo gratuito", async () => {
  const client = new OpenCodeClient(
    "http://127.0.0.1:4096",
    "deepseek-v4.1-flash-free",
  );
  const available = vi.spyOn(client, "available").mockResolvedValue(true);
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
                  action: { reason: "free_tier_limit" },
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
    ).rejects.toThrow("límite gratuito");
    available.mockRestore();
    await expect(client.available()).rejects.toThrow("No se usará un modelo de pago");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    call.mockRestore();
    available.mockRestore();
    fetchMock.mockRestore();
  }
});
