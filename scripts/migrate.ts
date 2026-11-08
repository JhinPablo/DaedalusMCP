import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import {
  emptyWorkspace,
  normalizeWorkspace,
  activeStatuses,
  type Workspace,
} from "../src/shared/model";
import { digest } from "../src/shared/engine";
import { inside } from "../src/connector/config";
const mode = process.argv[2];
if (!["export", "import"].includes(mode)) throw new Error("Usa export o import.");
const setup = JSON.parse(await readFile(".daedalus/bootstrap.json", "utf8"));
const access = JSON.parse(
  await readFile(".daedalus/cloud-service-tokens.json", "utf8"),
);
const configuration = JSON.parse(await readFile("connector.local.json", "utf8"));
const dir = path.resolve(".daedalus/migration");
await mkdir(dir, { recursive: true });
if (mode === "export") {
  const db = new DatabaseSync(".daedalus/development.sqlite", { readOnly: true });
  let state: Workspace;
  try {
    const row = db.prepare("SELECT value FROM workspace WHERE id=1").get() as {
      value: string;
    };
    state = normalizeWorkspace(JSON.parse(row.value));
  } finally {
    db.close();
  }
  if (
    state.runs.some((r) =>
      ["running", "waiting_permission", "uncertain"].includes(r.status),
    )
  )
    throw new Error(
      "Espera a que terminen las ejecuciones y reconcilia las inciertas antes de migrar.",
    );
  await writeFile(path.join(dir, "local-backup.json"), JSON.stringify(state));
  await copyFile("connector.local.json", path.join(dir, "connector-before.json"));
  for (const r of state.runs.filter((r) => r.status === "queued")) {
    r.status = "cancelled";
    r.finishedAt = new Date().toISOString();
    const session = state.sessions.find((s) => s.id === r.sessionId);
    if (session) {
      session.phase = "paused";
      const task = session.tasks.find((t) => t.runId === r.id);
      if (task) {
        task.runId = undefined;
        task.status = "pending";
      }
    }
  }
  for (const project of state.projects) project.connectorId = "cloud-connector";
  state.connectors = [];
  state.credentials = [
    {
      id: "cloud-connector",
      label: "Conector local estable",
      role: "connector",
      hash: digest(setup.production.connector),
      createdAt: new Date().toISOString(),
    },
    {
      id: "github-ci",
      label: "GitHub CI",
      role: "ci",
      hash: digest(setup.production.ci),
      createdAt: new Date().toISOString(),
    },
  ];
  const blobs: Array<{ key: string; content: string }> = [];
  const blobRoot = path.resolve(".daedalus/blobs");
  for (const artifact of state.artifacts) {
    const file = path.resolve(blobRoot, artifact.key);
    if (!inside(blobRoot, file))
      throw new Error("Ruta de artefacto fuera de su almacén.");
    try {
      const content = await readFile(file, "utf8");
      if (Buffer.byteLength(content) <= 512 * 1024)
        blobs.push({ key: artifact.key, content });
      else {
        artifact.storage = "local";
        artifact.localPath = file;
      }
    } catch {
      artifact.storage = "local";
      artifact.localPath = artifact.localPath ?? file;
    }
  }
  const payload = { migrationId: crypto.randomUUID(), state, blobs };
  if (Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024)
    throw new Error(
      "La instantánea supera 1 MiB. Divide los artefactos antes de importar; la copia local se conserva.",
    );
  await writeFile(path.join(dir, "production.json"), JSON.stringify(payload));
  const staging = emptyWorkspace();
  staging.credentials.push({
    id: "staging-ci",
    label: "Staging CI",
    role: "ci",
    hash: digest(setup.staging.ci),
    createdAt: new Date().toISOString(),
  });
  await writeFile(
    path.join(dir, "staging.json"),
    JSON.stringify({ migrationId: crypto.randomUUID(), state: staging, blobs: [] }),
  );
  console.log(
    `Copia privada preparada: ${state.sessions.length} conversaciones, ${state.runs.length} ejecuciones, ${blobs.length} artefactos.`,
  );
} else {
  for (const environment of ["staging", "production"] as const) {
    const url =
      environment === "production" ? process.env.DAEDALUS_URL : process.env.STAGING_URL;
    if (!url?.startsWith("https://"))
      throw new Error("Falta la URL HTTPS de " + environment);
    const machine = environment === "production" ? access.connector : access.stagingCi;
    const response = await fetch(url + "/api/migration", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + setup[environment].bootstrap,
        "CF-Access-Client-Id": machine.client_id,
        "CF-Access-Client-Secret": machine.client_secret,
      },
      body: await readFile(path.join(dir, environment + ".json"), "utf8"),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `${environment}: ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
    console.log(environment + ": " + (await response.text()));
  }
  const serverUrl = process.env.DAEDALUS_URL!;
  const connection = {
    DAEDALUS_CONNECTOR_TOKEN: setup.production.connector,
    CF_ACCESS_CLIENT_ID: access.connector.client_id,
    CF_ACCESS_CLIENT_SECRET: access.connector.client_secret,
  };
  await writeFile(".daedalus/connection.json", JSON.stringify(connection, null, 2));
  await writeFile(
    "connector.local.json",
    JSON.stringify(
      { ...configuration, serverUrl, publishRepository: "JhinPablo/DaedalusMCP" },
      null,
      2,
    ),
  );
  console.log(
    "El conector ya apunta al panel alojado. Inícialo con npm run connector:stable.",
  );
}
