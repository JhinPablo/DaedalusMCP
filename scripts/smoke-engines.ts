import { CodexClient } from "../src/connector/codex";
import { OpenCodeClient } from "../src/connector/opencode";
import { mkdir, writeFile } from "node:fs/promises";
const result: Record<string, unknown> = { at: new Date().toISOString() };
const codex = new CodexClient(
  process.env.DAEDALUS_CODEX_COMMAND ?? "codex",
  process.cwd(),
  async () => ({ decision: "decline" }),
);
try {
  result.codex = await codex.execute(
    "Prueba de integración de Daedalus. Responde exactamente DAEDALUS_CODEX_OK. No uses herramientas ni modifiques archivos.",
    process.cwd(),
    true,
    AbortSignal.timeout(120000),
    async () => {},
  );
  if (!String(result.codex).includes("DAEDALUS_CODEX_OK"))
    throw new Error("La respuesta de Codex no coincide con la prueba.");
} finally {
  codex.close();
}
const planner = new OpenCodeClient(
  process.env.DAEDALUS_OPENCODE_URL ?? "http://127.0.0.1:4096",
  "deepseek-v4.1-flash-free",
);
const plan = await planner.plan(
  'Prueba de integración de Daedalus. Planea una sola tarea que cree un archivo result.txt con el texto DAEDALUS_SMOKE_OK. No implementes nada. Compara dos enfoques para escribir el archivo, critica riesgos y devuelve exactamente una tarea sin dependencias, sin skills adicionales, con áreas ["result.txt"].',
  process.cwd(),
  AbortSignal.timeout(180000),
  async () => {},
);
if (!plan.proposal) throw new Error("La prueba esperaba una propuesta completa.");
result.opencode = {
  objective: plan.proposal.objective,
  tasks: plan.proposal.tasks.length,
  valid: true,
};
await mkdir(".daedalus", { recursive: true });
await writeFile(".daedalus/smoke-engines.json", JSON.stringify(result, null, 2));
console.log(
  "Codex: turno real con ChatGPT verificado.\nOpenCode: propuesta real de DeepSeek validada con el esquema.",
);
