import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexClient } from "../src/connector/codex";
import { OpenCodeClient } from "../src/connector/opencode";
const exec = promisify(execFile);
const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    checks.push({ check: name, ok: true, detail: await fn() });
  } catch (e) {
    checks.push({
      check: name,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
await check("Node.js", async () => process.version);
await check("Git", async () =>
  (await exec("git", ["--version"], { windowsHide: true })).stdout.trim(),
);
await check("Codex · ChatGPT", async () => {
  const c = new CodexClient(
    process.env.DAEDALUS_CODEX_COMMAND ?? "codex",
    process.cwd(),
    async () => ({ decision: "decline" }),
  );
  try {
    await c.initialize();
    await c.account();
    return "App Server disponible y autenticado con ChatGPT.";
  } finally {
    c.close();
  }
});
await check("OpenCode · DeepSeek gratuito", async () => {
  const model = process.env.DAEDALUS_OPENCODE_MODEL ?? "deepseek-v4.1-flash-free";
  await new OpenCodeClient(
    process.env.DAEDALUS_OPENCODE_URL ?? "http://127.0.0.1:4096",
    model,
  ).available();
  return model + " disponible con coste cero.";
});
await check("Skills fijadas", async () => {
  const lock = JSON.parse(await readFile("skills-lock.json", "utf8")) as {
    sources: Array<{ id: string; revision: string }>;
  };
  for (const s of lock.sources) {
    const revision = (
      await readFile(".daedalus/skills/" + s.id + "/.daedalus-revision", "utf8")
    ).trim();
    if (revision !== s.revision)
      throw new Error("Sincroniza " + s.id + " con npm run skills:sync.");
  }
  return `${lock.sources.length} fuentes sincronizadas.`;
});
for (const c of checks)
  console.log(`${c.ok ? "OK" : "PENDIENTE"} · ${c.check}: ${c.detail}`);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
