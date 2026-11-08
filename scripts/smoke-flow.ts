import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Service } from "../src/server/service";
import { digest } from "../src/shared/engine";
import {
  currentVersion,
  emptyWorkspace,
  type Principal,
  type Session,
} from "../src/shared/model";
import { git } from "../src/connector/worktrees";

await mkdir(".daedalus/verification", { recursive: true });
const directory = await mkdtemp(path.resolve(".daedalus/smoke-")),
  project = path.join(directory, "project");
await mkdir(project);
await git(project, "init", "-b", "main");
await writeFile(
  path.join(project, "README.md"),
  "Proyecto aislado de verificación de Daedalus.\n",
);
await git(project, "add", "README.md");
await git(
  project,
  "-c",
  "user.name=Daedalus",
  "-c",
  "user.email=daedalus@localhost",
  "commit",
  "-m",
  "Base de verificación",
);
let state = emptyWorkspace();
const token = "ddl_" + crypto.randomUUID(),
  connectorId = crypto.randomUUID();
state.credentials.push({
  id: connectorId,
  role: "connector",
  label: "Verificación aislada",
  hash: digest(token),
  createdAt: new Date().toISOString(),
});
const service = new Service(
  {
    read: () => state,
    write: (s) => {
      state = s;
    },
  },
  { put: async () => {}, get: async () => null },
);
const server = createServer(async (req, res) => {
  try {
    const p = service.authenticate(req.headers.authorization?.slice(7) ?? "");
    if (!p) {
      res.writeHead(401).end();
      return;
    }
    const init: RequestInit & { duplex?: string } = {
      method: req.method,
      headers: req.headers as Record<string, string>,
    };
    if (req.method !== "GET") {
      init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    const response = await service.handle(
      new Request("http://localhost" + req.url, init),
      p,
    );
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(await response.text());
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No se pudo abrir el servidor aislado.");
const configFile = path.join(directory, "connector.json");
await writeFile(
  configFile,
  JSON.stringify({
    serverUrl: `http://127.0.0.1:${address.port}`,
    name: "Verificación real",
    projects: [{ id: "smoke", name: "Verificación aislada", root: project }],
    skillsRoot: path.resolve(".daedalus/skills"),
    journalRoot: path.join(directory, "journal"),
  }),
);
const child = spawn(
  process.execPath,
  ["--import", "tsx", "src/connector/index.ts", "--config", configFile],
  {
    windowsHide: true,
    env: { ...process.env, DAEDALUS_CONNECTOR_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let diagnostics = "";
child.stderr.on("data", (data) => {
  diagnostics += data.toString();
});
child.stdout.on("data", (data) => process.stdout.write(data));
const owner: Principal = { role: "owner", id: "smoke-owner" };
async function call(route: string, body: unknown) {
  const response = await service.handle(
    new Request("http://localhost" + route, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    owner,
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
async function waitFor(check: () => boolean, label: string, timeout = 240000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`Tiempo agotado: ${label}. ${diagnostics.slice(-1000)}`);
    const error = state.runs.find((r) => ["failed", "uncertain"].includes(r.status));
    if (error) throw new Error(`${label}: ${error.error}`);
    if (state.permissions.some((p) => !p.decision))
      throw new Error("La prueba requiere permiso adicional: no se autoaprobará.");
    await delay(500);
  }
}
try {
  await waitFor(() => state.connectors.length > 0, "registro del conector", 30000);
  const session = (await call("/api/sessions", {
    projectId: "smoke",
    title: "Verificación real aislada",
    idea: "Crea únicamente result.txt con el contenido exacto DAEDALUS_SMOKE_OK. Esta es una prueba aislada, no un cambio en el proyecto del usuario.",
  })) as Session;
  await call("/api/sessions/" + session.id + "/plan", {
    message:
      "Genera exactamente una tarea sin dependencias ni skills adicionales que cree result.txt con el texto DAEDALUS_SMOKE_OK. Compara dos formas de hacerlo y devuelve tu propuesta sin ejecutar nada. Incluye la verificación del contenido como criterio de aceptación.",
  });
  await waitFor(() => state.sessions[0]?.phase === "approach", "planeación real");
  const version = currentVersion(state.sessions[0])!;
  if (version.proposal.tasks.length !== 1)
    throw new Error("La prueba requiere exactamente una tarea.");
  for (const milestone of ["approach", "execution"])
    await call("/api/sessions/" + session.id + "/decision", {
      milestone,
      version: version.version,
      digest: version.digest,
      decision: "approved",
      explanation:
        "Autorización del escenario aislado de pruebas de la implementación.",
    });
  await waitFor(
    () => state.sessions[0]?.phase === "completed",
    "ejecución y revisión reales",
    360000,
  );
  const task = state.runs.find((r) => r.kind === "task")!;
  const value = (
    await readFile(path.join(task.worktree!, "result.txt"), "utf8")
  ).trim();
  if (value !== "DAEDALUS_SMOKE_OK")
    throw new Error("El resultado escrito no coincide.");
  const report = {
    at: new Date().toISOString(),
    passed: true,
    project,
    phases: state.events.map((e) => e.type),
    runs: state.runs.map((r) => ({
      kind: r.kind,
      status: r.status,
      branch: r.branch,
      worktree: r.worktree,
      output: r.output,
    })),
    approvals: state.sessions[0].approvals.length,
  };
  await writeFile(
    ".daedalus/verification/smoke-flow.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    "FLUJO REAL VERIFICADO: DeepSeek → dos aprobaciones → Codex escribe en worktree → revisión independiente.",
  );
} finally {
  child.kill();
  server.closeAllConnections();
  server.close();
}
