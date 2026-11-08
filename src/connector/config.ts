import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
export const configSchema = z.object({
  serverUrl: z.string().url(),
  name: z.string().default("Equipo local"),
  tokenEnv: z.string().default("DAEDALUS_CONNECTOR_TOKEN"),
  codexCommand: z.string().default("codex"),
  opencodeUrl: z.string().url().default("http://127.0.0.1:4096"),
  opencodeModel: z.string().default("deepseek-v4.1-flash-free"),
  planningFallback: z.enum(["none", "luna-high"]).default("none"),
  publishRepository: z.literal("JhinPablo/DaedalusMCP").optional(),
  releaseControlUrl: z.string().url().startsWith("https://").optional(),
  projects: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        name: z.string().min(1),
        root: z.string(),
      }),
    )
    .min(1),
  skillsRoot: z.string().default(".daedalus/skills"),
  journalRoot: z.string().default(".daedalus/connector"),
  maxParallel: z.number().int().min(1).max(3).default(3),
});
export type ConnectorConfig = z.infer<typeof configSchema>;
export function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export async function loadConfig(file: string) {
  const c = configSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const configRoot = path.dirname(path.resolve(file));
  c.skillsRoot = path.resolve(configRoot, c.skillsRoot);
  c.journalRoot = path.resolve(configRoot, c.journalRoot);
  const url = new URL(c.serverUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
  )
    throw new Error("El servidor debe usar HTTPS o localhost.");
  const local = new URL(c.opencodeUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(local.hostname))
    throw new Error("OpenCode debe escuchar en localhost.");
  for (const p of c.projects) {
    p.root = await realpath(path.resolve(p.root));
    if (p.root === path.parse(p.root).root)
      throw new Error("No se permite registrar la raíz del disco.");
  }
  if (new Set(c.projects.map((p) => p.id)).size !== c.projects.length)
    throw new Error("Los proyectos deben tener identificadores únicos.");
  return c;
}
