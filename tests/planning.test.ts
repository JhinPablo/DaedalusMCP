import { expect, it, vi } from "vitest";
import { planWithFallback, planWithLuna } from "../src/connector/planning";
import type { CodexClient } from "../src/connector/codex";
import { configSchema } from "../src/connector/config";

const result = { reply: "Hola", output: "Hola" };
it("usa DeepSeek sin consumir Luna cuando responde", async () => {
  const luna = vi.fn();
  const event = vi.fn();
  await expect(
    planWithFallback(async () => result, luna, new AbortController().signal, event),
  ).resolves.toEqual(result);
  expect(luna).not.toHaveBeenCalled();
  expect(event).not.toHaveBeenCalled();
});
it("cambia una sola vez a Luna y registra el motivo del fallo de DeepSeek", async () => {
  const luna = vi.fn().mockResolvedValue(result),
    event = vi.fn().mockResolvedValue(undefined);
  await expect(
    planWithFallback(
      async () => {
        throw new Error("Cupo agotado");
      },
      luna,
      new AbortController().signal,
      event,
    ),
  ).resolves.toEqual(result);
  expect(luna).toHaveBeenCalledTimes(1);
  expect(event).toHaveBeenCalledWith("Cupo agotado");
});
it("no cambia de modelo al cancelar ni sin configuración explícita", async () => {
  const controller = new AbortController();
  controller.abort();
  const luna = vi.fn(),
    event = vi.fn();
  const failure = async () => {
    throw new Error("Cancelado");
  };
  await expect(
    planWithFallback(failure, luna, controller.signal, event),
  ).rejects.toThrow("Cancelado");
  await expect(
    planWithFallback(failure, undefined, new AbortController().signal, event),
  ).rejects.toThrow("Cancelado");
  expect(luna).not.toHaveBeenCalled();
  expect(event).not.toHaveBeenCalled();
  expect(
    configSchema.parse({
      serverUrl: "http://localhost:8787",
      projects: [{ id: "p", name: "P", root: "project" }],
    }).planningFallback,
  ).toBe("none");
});
it("conserva ambos errores si también falla Luna y no reintenta en bucle", async () => {
  const luna = vi.fn().mockRejectedValue(new Error("Luna no disponible"));
  await expect(
    planWithFallback(
      async () => {
        throw new Error("DeepSeek sin cuota");
      },
      luna,
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toThrow(/DeepSeek sin cuota[\s\S]*Luna no disponible/);
  expect(luna).toHaveBeenCalledTimes(1);
});
it("pide exactamente Luna alto en modo lectura y valida la respuesta", async () => {
  const execute = vi
    .fn()
    .mockResolvedValue(
      JSON.stringify({ kind: "message", message: "Hola", proposal: null }),
    );
  const signal = new AbortController().signal,
    onSession = async () => {};
  await expect(
    planWithLuna(
      { execute } as unknown as CodexClient,
      "Hola",
      "project",
      signal,
      onSession,
    ),
  ).resolves.toMatchObject({ reply: "Hola" });
  expect(execute).toHaveBeenCalledWith(
    "Hola",
    "project",
    true,
    signal,
    onSession,
    undefined,
    expect.objectContaining({
      model: "gpt-6-luna",
      effort: "high",
      schema: expect.any(Object),
    }),
  );
});
