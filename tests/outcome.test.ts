import { expect, it } from "vitest";
import { taskReport } from "../src/connector/outcome";
it("una respuesta de planeación bloqueada no cuenta como implementación completada", () => {
  expect(() =>
    taskReport(
      JSON.stringify({
        status: "blocked",
        summary: "Falta una decisión de alcance.",
        tests: [],
        limitations: ["No se implementó el cambio."],
      }),
    ),
  ).toThrow("Falta una decisión");
});
it("conserva pruebas y limitaciones del resultado estructurado", () => {
  const result = taskReport(
    JSON.stringify({
      status: "completed",
      summary: "Implementación terminada.",
      tests: ["node --test: 2 pasan"],
      limitations: ["No se verificó en producción."],
    }),
  );
  expect(result).toContain("2 pasan");
  expect(result).toContain("No se verificó en producción.");
});
