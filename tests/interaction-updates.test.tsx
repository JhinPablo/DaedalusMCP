import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionDetails, permissionDescription } from "../src/web/PermissionDetails";
import { workspaceNotices } from "../src/web/notifications";
import { emptyWorkspace, type AgentRun } from "../src/shared/model";
import { Engine } from "../src/shared/engine";
import { reportRelease } from "../src/server/releases";
import { Service } from "../src/server/service";

it("presenta JSON anidado como alcance legible sin ejecutar HTML ni ocultar campos desconocidos", () => {
  const html = renderToStaticMarkup(
    <PermissionDetails
      details={JSON.stringify({
        command: ["npm", "test"],
        cwd: "C:/proyecto",
        permissions: { network: { enabled: true } },
        customField: "<script>bad()</script>",
        threadId: "internal-id",
      })}
    />,
  );
  expect(html).toContain("Comando");
  expect(html).toContain("Carpeta de trabajo");
  expect(html).toContain("Permisos solicitados");
  expect(html).toContain("Sí");
  expect(html).toContain("custom Field");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("internal-id");
  expect(permissionDescription('{"reason":"Ejecutar las pruebas"}')).toBe(
    "Ejecutar las pruebas",
  );
  expect(permissionDescription("Texto sin JSON")).toBe("Texto sin JSON");
});
it("identifica permisos pendientes y resultados finales sin notificar tareas en curso o permisos resueltos", () => {
  const state = emptyWorkspace();
  state.runs.push({
    id: "run",
    sessionId: "chat",
    status: "running",
    kind: "task",
  } as AgentRun);
  state.permissions.push({
    id: "p",
    runId: "run",
    description: "Ejecutar pruebas",
    method: "command",
    details: {},
    createdAt: "now",
  });
  expect(workspaceNotices(state).map((n) => n.id)).toEqual(["permission:p"]);
  state.permissions[0].decision = "accept";
  state.runs[0].status = "completed";
  expect(workspaceNotices(state).map((n) => n.id)).toEqual(["run:run:completed"]);
  expect(workspaceNotices(state)[0].sessionId).toBe("chat");
});
it("la preview verificada llega al chat una sola vez y se vincula al commit", () => {
  const state = emptyWorkspace(),
    e = new Engine(state),
    at = new Date().toISOString();
  state.projects.push({
    id: "p",
    name: "p",
    rootLabel: "p",
    connectorId: "c",
    createdAt: at,
  });
  const s = e.createSession({ role: "owner", id: "o" }, "p", "Cambio", "Implementar");
  const release = {
    id: "release",
    sessionId: s.id,
    repository: "JhinPablo/DaedalusMCP",
    branch: "daedalus/test",
    commit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    tree: "c".repeat(40),
    prNumber: 1,
    prUrl: "https://github.com/JhinPablo/DaedalusMCP/pull/1",
    checks: "pending" as const,
    status: "testing" as const,
    createdAt: at,
    updatedAt: at,
  };
  state.releases.push(release);
  const result = {
    commit: release.commit,
    baseCommit: release.baseCommit,
    tree: release.tree,
    artifactDigest: "d".repeat(64),
    artifactId: "1",
    ciRunId: "2",
    checks: "passed" as const,
    previewUrl: "https://staging.workers.dev",
  };
  for (let i = 0; i < 2; i++)
    reportRelease(e, { role: "ci", id: "ci" }, release.id, result, result.previewUrl);
  const messages = s.messages.filter((m) => m.id.startsWith("release-result:"));
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toContain("preview=" + release.commit);
  expect(messages[0].content).toContain("pull/1/files");
  expect(state.releases[0].approval).toBeUndefined();
});
it("solo el conector asignado puede registrar enlaces de avances y los reintentos no duplican mensajes", async () => {
  let state = emptyWorkspace();
  const e = new Engine(state),
    at = new Date().toISOString();
  state.projects.push({
    id: "p",
    name: "p",
    rootLabel: "p",
    connectorId: "c",
    createdAt: at,
  });
  const session = e.createSession(
    { role: "owner", id: "o" },
    "p",
    "Cambio",
    "Implementar",
  );
  state.runs.push({
    id: "run",
    sessionId: session.id,
    projectId: "p",
    kind: "task",
    status: "completed",
    connectorId: "c",
    branch: "daedalus/task",
    createdAt: at,
    output: "",
    prompt: "",
    skills: [],
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
  const call = (id: string) =>
    service.handle(
      new Request("https://test/api/runs/run/progress", {
        method: "POST",
        body: JSON.stringify({ commit: "a".repeat(40) }),
      }),
      { role: "connector", id },
    );
  expect((await call("other")).status).toBe(403);
  expect((await call("c")).status).toBe(200);
  expect((await call("c")).status).toBe(200);
  expect(
    state.sessions[0].messages.filter((m) => m.id.startsWith("task-progress:")),
  ).toHaveLength(1);
});
