import { describe, expect, it } from "vitest";
import { Engine, digest } from "../src/shared/engine";
import {
  currentVersion,
  emptyWorkspace,
  type Principal,
  type Proposal,
} from "../src/shared/model";
import { Service } from "../src/server/service";

const owner: Principal = { role: "owner", id: "owner" },
  connector: Principal = { role: "connector", id: "device" },
  mcp: Principal = { role: "mcp", id: "agent" };
export const proposal: Proposal = {
  objective: "Crear un contador accesible",
  scope: "Una pantalla local con pruebas.",
  alternatives: [
    {
      title: "React",
      explanation: "Estado de componente.",
      tradeoffs: "Dependencia de React.",
    },
    {
      title: "HTML",
      explanation: "DOM directo.",
      tradeoffs: "Más coordinación manual.",
    },
  ],
  recommendation: "React por consistencia con el proyecto.",
  critique: "Validar teclado y límites del contador.",
  prompt: "Implementa un contador accesible con pruebas.",
  tasks: [
    {
      id: "counter",
      title: "Contador",
      prompt: "Implementa el contador.",
      acceptance: ["Se puede operar con teclado."],
      dependsOn: [],
      skills: [],
      areas: ["src"],
    },
    {
      id: "test",
      title: "Pruebas",
      prompt: "Verifica el contador.",
      acceptance: ["Las pruebas pasan."],
      dependsOn: ["counter"],
      skills: [],
      areas: ["tests"],
    },
  ],
};
function setup() {
  const state = emptyWorkspace();
  state.projects.push({
    id: "project",
    name: "Proyecto",
    rootLabel: "project",
    connectorId: "device",
    createdAt: new Date().toISOString(),
  });
  state.connectors.push({
    id: "device",
    name: "Equipo",
    lastSeen: new Date().toISOString(),
    codex: true,
    opencode: true,
  });
  const e = new Engine(state);
  const s = e.createSession(owner, "project", "Contador", "Necesito un contador.");
  return { e, s };
}
function approve(e: Engine, sessionId: string) {
  const v = currentVersion(e.session(sessionId))!;
  e.decide(
    owner,
    sessionId,
    "approach",
    v.version,
    v.digest,
    "approved",
    "Enfoque revisado",
  );
  e.decide(
    owner,
    sessionId,
    "execution",
    v.version,
    v.digest,
    "approved",
    "Plan revisado",
  );
}
describe("Aprobaciones y coordinación", () => {
  it("reintenta solo la preparación fallida, conserva el intento anterior y la aprobación exacta", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    approve(e, s.id);
    const previous = e.claim(connector)!;
    e.finish(connector, previous.id, {
      status: "failed",
      error: "Error de carga",
      preflightFailure: true,
    });
    const retried = e.retryPreflight(owner, previous.id)!;
    expect(retried.id).not.toBe(previous.id);
    expect(previous.status).toBe("failed");
    expect(retried.approvedDigest).toBe(previous.approvedDigest);
    expect(retried.approvedVersion).toBe(previous.approvedVersion);
    expect(e.claim(connector)?.id).toBe(retried.id);
  });
  it.each([connector, mcp])(
    "$role no puede solicitar el reintento humano de una tarea",
    (principal) => {
      const { e, s } = setup();
      e.propose(owner, s.id, proposal);
      approve(e, s.id);
      const run = e.claim(connector)!;
      e.finish(connector, run.id, { status: "failed", preflightFailure: true });
      expect(() => e.retryPreflight(principal, run.id)).toThrow("Solo el propietario");
    },
  );
  it.each(["externalSessionId", "worktree", "branch", "baseCommit"] as const)(
    "no reintenta si existe evidencia de inicio: %s",
    (field) => {
      const { e, s } = setup();
      e.propose(owner, s.id, proposal);
      approve(e, s.id);
      const run = e.claim(connector)!;
      e.finish(connector, run.id, {
        status: "failed",
        preflightFailure: true,
        [field]: "started",
      });
      expect(() => e.retryPreflight(owner, run.id)).toThrow("antes de iniciar");
    },
  );
  it("no reintenta resultados inciertos ni una versión modificada", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    approve(e, s.id);
    const run = e.claim(connector)!;
    e.finish(connector, run.id, { status: "uncertain", preflightFailure: true });
    expect(() => e.retryPreflight(owner, run.id)).toThrow();
    run.status = "failed";
    currentVersion(s)!.digest = "modified";
    expect(() => e.retryPreflight(owner, run.id)).toThrow("perdió su aprobación");
  });
  it("entrega planificación al respaldo aunque OpenCode esté bloqueado, sin habilitar ejecución", () => {
    const { e, s } = setup();
    const c = e.state.connectors[0];
    c.opencode = false;
    c.planning = true;
    c.planningModel = "gpt-6-luna · alto";
    e.plan(owner, s.id, "Hola");
    expect(e.claim(connector)?.kind).toBe("planning");
    expect(e.claim(connector)).toBeNull();
  });
  it("no entrega tareas antes de ambas aprobaciones", () => {
    const { e, s } = setup();
    e.propose(mcp, s.id, proposal);
    expect(e.claim(connector)).toBeNull();
    const v = currentVersion(s)!;
    e.decide(owner, s.id, "approach", v.version, v.digest, "approved", "");
    expect(e.claim(connector)).toBeNull();
    e.decide(owner, s.id, "execution", v.version, v.digest, "approved", "");
    expect(e.claim(connector)?.taskId).toBe("counter");
  });
  it.each([connector, mcp])("impide que $role apruebe", (principal) => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    const v = currentVersion(s)!;
    expect(() =>
      e.decide(principal, s.id, "approach", 1, v.digest, "approved", ""),
    ).toThrow("Solo el propietario");
  });
  it("requiere aprobar enfoque antes de ejecución", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    expect(() =>
      e.decide(owner, s.id, "execution", 1, currentVersion(s)!.digest, "approved", ""),
    ).toThrow("primero el enfoque");
  });
  it("una versión nueva invalida el enfoque previo", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    const old = currentVersion(s)!;
    e.decide(owner, s.id, "approach", old.version, old.digest, "approved", "");
    e.propose(owner, s.id, {
      ...proposal,
      prompt: "Nuevo prompt aprobado por revisar.",
    });
    expect(e.approved(s, "approach")).toBe(false);
    expect(() =>
      e.decide(owner, s.id, "execution", old.version, old.digest, "approved", ""),
    ).toThrow("cambió");
    expect(e.claim(connector)).toBeNull();
  });
  it("rechazar no lanza ejecuciones", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    e.decide(
      owner,
      s.id,
      "approach",
      1,
      currentVersion(s)!.digest,
      "rejected",
      "Cambiar enfoque",
    );
    expect(e.state.runs).toHaveLength(0);
    expect(s.phase).toBe("paused");
  });
  it("rechaza aprobaciones duplicadas", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    const v = currentVersion(s)!;
    e.decide(owner, s.id, "approach", 1, v.digest, "approved", "");
    expect(() =>
      e.decide(owner, s.id, "approach", 1, v.digest, "approved", ""),
    ).toThrow("ya está aprobado");
  });
  it("no permite cambiar un plan activo", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    approve(e, s.id);
    expect(() => e.propose(mcp, s.id, proposal)).toThrow("ejecución activa");
  });
  it("respeta dependencias y abre una revisión final independiente", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    approve(e, s.id);
    const a = e.claim(connector)!;
    expect(a.taskId).toBe("counter");
    expect(e.claim(connector)).toBeNull();
    e.finish(connector, a.id, {
      status: "completed",
      output: "Contador probado.",
    });
    const b = e.claim(connector)!;
    expect(b.taskId).toBe("test");
    e.finish(connector, b.id, {
      status: "completed",
      output: "2 pruebas pasan.",
    });
    expect(s.phase).toBe("review");
    const review = e.claim(connector)!;
    expect(review.kind).toBe("review");
    e.finish(connector, review.id, {
      status: "completed",
      output: "Sin hallazgos bloqueantes.",
    });
    expect(s.phase).toBe("completed");
  });
  it("limita a tres ejecutores simultáneos", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, {
      ...proposal,
      tasks: Array.from({ length: 5 }, (_, i) => ({
        ...proposal.tasks[0],
        id: "t" + i,
        dependsOn: [],
      })),
    });
    approve(e, s.id);
    expect(e.state.runs.filter((r) => r.kind === "task")).toHaveLength(3);
    const first = e.claim(connector)!;
    e.finish(connector, first.id, { status: "completed" });
    expect(
      e.state.runs.filter((r) => r.status === "queued" || r.status === "running"),
    ).toHaveLength(3);
  });
  it("rechaza ciclos y dependencias inexistentes", () => {
    const { e, s } = setup();
    expect(() =>
      e.propose(owner, s.id, {
        ...proposal,
        tasks: [{ ...proposal.tasks[0], dependsOn: ["counter"] }],
      }),
    ).toThrow("circulares");
    expect(() =>
      e.propose(owner, s.id, {
        ...proposal,
        tasks: [{ ...proposal.tasks[0], dependsOn: ["missing"] }],
      }),
    ).toThrow("desconocida");
  });
  it("un conector no puede finalizar el trabajo de otro", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    approve(e, s.id);
    const run = e.claim(connector)!;
    expect(() =>
      e.finish({ role: "connector", id: "other" }, run.id, {
        status: "completed",
      }),
    ).toThrow("otro conector");
  });
  it("cancelación impide ejecutar dependencias", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    approve(e, s.id);
    const run = e.claim(connector)!;
    e.cancel(owner, s.id);
    e.finish(connector, run.id, { status: "completed" });
    expect(s.phase).toBe("cancelled");
    expect(e.claim(connector)).toBeNull();
  });
  it("resultados terminales son idempotentes", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    approve(e, s.id);
    const run = e.claim(connector)!;
    e.finish(connector, run.id, { status: "completed", output: "primero" });
    e.finish(connector, run.id, { status: "failed", output: "duplicado" });
    expect(run.status).toBe("completed");
    expect(run.output).toBe("primero");
  });
  it("la desconexión pausa y no vuelve a entregar una tarea incierta", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    approve(e, s.id);
    const run = e.claim(connector)!;
    e.state.connectors[0].lastSeen = new Date(Date.now() - 120000).toISOString();
    e.recoverStale();
    expect(run.status).toBe("uncertain");
    expect(s.phase).toBe("paused");
    expect(e.claim(connector)).toBeNull();
  });
  it("continúa con la tarea dependiente cuando llega el resultado confirmado de la misma ejecución", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, proposal);
    approve(e, s.id);
    const run = e.claim(connector)!;
    e.state.connectors[0].lastSeen = new Date(Date.now() - 120000).toISOString();
    e.recoverStale();
    expect(e.claim(connector)).toBeNull();

    e.finish(connector, run.id, {
      status: "completed",
      output: "Contador implementado.",
    });

    expect(s.phase).toBe("executing");
    expect(e.claim(connector)?.taskId).toBe("test");
    expect(e.state.runs.filter((r) => r.taskId === "counter")).toEqual([run]);
  });
  it("el digest también cubre las dependencias y criterios", () => {
    expect(digest(proposal)).not.toBe(
      digest({
        ...proposal,
        tasks: [{ ...proposal.tasks[0], acceptance: ["Otro criterio."] }],
      }),
    );
  });
  it("una nueva versión idéntica no reutiliza la revisión de una ejecución anterior", () => {
    const { e, s } = setup();
    const one = { ...proposal, tasks: [proposal.tasks[0]] };
    e.propose(owner, s.id, one);
    approve(e, s.id);
    e.finish(connector, e.claim(connector)!.id, { status: "completed" });
    e.finish(connector, e.claim(connector)!.id, { status: "completed" });
    e.propose(owner, s.id, one);
    approve(e, s.id);
    const task = e.claim(connector)!;
    expect(task.approvedVersion).toBe(2);
    e.finish(connector, task.id, { status: "completed" });
    const review = e.claim(connector)!;
    expect(review.kind).toBe("review");
    expect(review.approvedVersion).toBe(2);
  });
  it("los IDs de tareas no colisionan con los nodos del mapa", () => {
    const { e, s } = setup();
    e.propose(owner, s.id, {
      ...proposal,
      tasks: [{ ...proposal.tasks[0], id: s.nodes[0].id }],
    });
    expect(new Set(s.nodes.map((n) => n.id)).size).toBe(s.nodes.length);
  });
});
describe("API y aislamiento de autorización", () => {
  function service() {
    let state = emptyWorkspace();
    const blobs = new Map<string, string>();
    return new Service(
      {
        read: () => state,
        write: (s) => {
          state = s;
        },
      },
      {
        put: async (k, v) => {
          blobs.set(k, v);
        },
        get: async (k) => blobs.get(k) ?? null,
      },
    );
  }
  const call = (s: Service, path: string, p: Principal, body: unknown = {}) =>
    s.handle(
      new Request("http://localhost" + path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
      p,
    );
  it("persiste registro y creación de sesión mediante HTTP", async () => {
    const s = service();
    expect(
      (
        await call(s, "/api/connector/register", connector, {
          name: "Equipo",
          codex: true,
          opencode: true,
          projects: [{ id: "project", name: "Proyecto", rootLabel: "project" }],
        })
      ).status,
    ).toBe(200);
    const response = await call(s, "/api/sessions", owner, {
      projectId: "project",
      title: "Idea",
      idea: "Crear un contador.",
    });
    expect(response.status).toBe(201);
    expect(s.repo.read().sessions).toHaveLength(1);
  });
  it("el primer mensaje del chat crea la sesión y se registra una sola vez", async () => {
    const s = service();
    await call(s, "/api/connector/register", connector, {
      name: "Equipo",
      codex: true,
      opencode: true,
      projects: [{ id: "project", name: "Proyecto", rootLabel: "project" }],
    });
    const response = await call(s, "/api/chat", owner, {
      projectId: "project",
      message: "Quiero mejorar los prompts de mi proyecto.",
    });
    expect(response.status).toBe(201);
    expect(s.repo.read().sessions[0].messages).toHaveLength(1);
    expect(s.repo.read().runs[0].kind).toBe("planning");
    expect(s.repo.read().sessions[0].approvals).toHaveLength(0);
  });
  it("el agente puede responder y pedir aclaraciones sin inventar un plan", async () => {
    const s = service();
    await call(s, "/api/connector/register", connector, {
      name: "Equipo",
      codex: true,
      opencode: true,
      projects: [{ id: "project", name: "Proyecto", rootLabel: "project" }],
    });
    await call(s, "/api/chat", owner, {
      projectId: "project",
      message: "Quiero una herramienta.",
    });
    const claim = await call(s, "/api/connector/claim", connector);
    const run = ((await claim.json()) as { run: { id: string } }).run;
    await call(s, "/api/runs/" + run.id + "/finish", connector, {
      status: "completed",
      reply: "¿Quién utilizará la herramienta?",
      output: "¿Quién utilizará la herramienta?",
    });
    expect(s.repo.read().sessions[0].messages.at(-1)?.content).toBe(
      "¿Quién utilizará la herramienta?",
    );
    expect(s.repo.read().sessions[0].versions).toHaveLength(0);
    expect(s.repo.read().sessions[0].phase).toBe("idea");
    expect(s.repo.read().runs).toHaveLength(1);
    expect(s.repo.read().artifacts).toHaveLength(0);
  });
  it("una mutación inválida no persiste cambios parciales", async () => {
    const s = service();
    const revision = s.repo.read().revision;
    expect(
      (
        await call(s, "/api/sessions", owner, {
          projectId: "missing",
          title: "Idea",
          idea: "Idea",
        })
      ).status,
    ).toBe(404);
    expect(s.repo.read().revision).toBe(revision);
  });
  it("tokens se guardan como hashes y la revocación tiene efecto inmediato", async () => {
    const s = service();
    const response = await call(s, "/api/credentials", owner, {
      label: "Agente",
      role: "mcp",
    });
    const result = (await response.json()) as {
      token: string;
      credential: { id: string };
    };
    expect(s.authenticate(result.token)?.role).toBe("mcp");
    expect(JSON.stringify(s.repo.read())).not.toContain(result.token);
    await call(s, "/api/credentials/" + result.credential.id + "/revoke", owner);
    expect(s.authenticate(result.token)).toBeNull();
  });
  it("un token MCP no puede crear credenciales ni sesiones", async () => {
    const s = service();
    expect(
      (
        await call(s, "/api/credentials", mcp, {
          label: "Elevación",
          role: "connector",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(s, "/api/sessions", mcp, {
          projectId: "project",
          title: "Idea",
          idea: "Idea",
        })
      ).status,
    ).toBe(403);
  });
  it("no permite secuestrar un proyecto registrado", async () => {
    const s = service();
    const body = {
      name: "Equipo",
      codex: true,
      opencode: true,
      projects: [{ id: "project", name: "Proyecto", rootLabel: "project" }],
    };
    await call(s, "/api/connector/register", connector, body);
    expect(
      (
        await call(
          s,
          "/api/connector/register",
          { role: "connector", id: "other" },
          body,
        )
      ).status,
    ).toBe(409);
    expect(s.repo.read().connectors).toHaveLength(1);
  });
  it("impide traversal y revisiones no fijadas al archivar skills", async () => {
    const s = service();
    expect(
      (
        await call(s, "/api/skill-resources", connector, {
          source: "superpowers",
          revision: "0".repeat(40),
          path: "../../secret",
          content: "x",
        })
      ).status,
    ).toBe(400);
  });
  async function approvedService() {
    const serviceInstance = service();
    await call(serviceInstance, "/api/connector/register", connector, {
      name: "Equipo",
      codex: true,
      opencode: true,
      projects: [{ id: "project", name: "Proyecto", rootLabel: "project" }],
    });
    const response = await call(serviceInstance, "/api/sessions", owner, {
      projectId: "project",
      title: "Verificación",
      idea: "Crear contador",
    });
    const session = (await response.json()) as { id: string };
    await call(
      serviceInstance,
      "/api/sessions/" + session.id + "/proposal",
      owner,
      proposal,
    );
    const v = currentVersion(serviceInstance.repo.read().sessions[0])!;
    for (const milestone of ["approach", "execution"])
      await call(serviceInstance, "/api/sessions/" + session.id + "/decision", owner, {
        milestone,
        version: v.version,
        digest: v.digest,
        decision: "approved",
      });
    const job = await call(serviceInstance, "/api/connector/claim", connector);
    const run = ((await job.json()) as { run: { id: string } }).run;
    return { serviceInstance, sessionId: session.id, runId: run.id };
  }
  it("el agente puede solicitar un permiso pero solo el propietario puede resolverlo una vez", async () => {
    const { serviceInstance: s, runId } = await approvedService();
    const permissionId = crypto.randomUUID();
    expect(
      (
        await call(s, "/api/runs/" + runId + "/permission", connector, {
          id: permissionId,
          method: "item/fileChange/requestApproval",
          description: "Modificar src/counter.ts",
          details: {},
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(s, "/api/permissions/" + permissionId, connector, {
          decision: "accept",
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(s, "/api/permissions/" + permissionId, owner, { decision: "accept" }))
        .status,
    ).toBe(200);
    expect(
      (await call(s, "/api/permissions/" + permissionId, owner, { decision: "accept" }))
        .status,
    ).toBe(409);
  });
  it("cancelar invalida los permisos pendientes", async () => {
    const { serviceInstance: s, runId, sessionId } = await approvedService();
    const permissionId = crypto.randomUUID();
    await call(s, "/api/runs/" + runId + "/permission", connector, {
      id: permissionId,
      method: "item/fileChange/requestApproval",
      description: "Editar archivo",
      details: {},
    });
    await call(s, "/api/sessions/" + sessionId + "/cancel", owner);
    expect(
      (await call(s, "/api/permissions/" + permissionId, owner, { decision: "accept" }))
        .status,
    ).toBe(409);
  });
  it("un resultado duplicado no cambia el artefacto ya publicado", async () => {
    const { serviceInstance: s, runId } = await approvedService();
    await call(s, "/api/runs/" + runId + "/finish", connector, {
      status: "completed",
      output: "Evidencia original",
    });
    await call(s, "/api/runs/" + runId + "/finish", connector, {
      status: "completed",
      output: "Evidencia modificada",
    });
    expect(await s.blobs.get("artifacts/" + runId + "/result.md")).toBe(
      "Evidencia original",
    );
    expect(s.repo.read().artifacts.filter((a) => a.runId === runId)).toHaveLength(1);
  });
  it("consultar el estado detecta una desconexión aunque no haya mutaciones", async () => {
    const { serviceInstance: s, runId } = await approvedService();
    const state = s.repo.read();
    state.connectors[0].lastSeen = new Date(Date.now() - 120000).toISOString();
    s.repo.write(state);
    s.view(owner);
    expect(s.repo.read().runs.find((r) => r.id === runId)?.status).toBe("uncertain");
  });
  it("la reconciliación exige propietario y evidencia", async () => {
    const { serviceInstance: s, runId } = await approvedService();
    await call(s, "/api/runs/" + runId + "/finish", connector, {
      status: "uncertain",
      error: "Interrupción",
    });
    expect(
      (
        await call(s, "/api/runs/" + runId + "/reconcile", mcp, {
          outcome: "failed",
          evidence: "Inspección local completada.",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(s, "/api/runs/" + runId + "/reconcile", owner, {
          outcome: "failed",
          evidence: "Inspección local completada.",
        })
      ).status,
    ).toBe(200);
    expect(s.repo.read().runs.find((r) => r.id === runId)?.status).toBe("failed");
  });
});
