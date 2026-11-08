import { z } from "zod";
import { Engine, DomainError, digest } from "../shared/engine";
import { type Principal, type Workspace } from "../shared/model";
import skillLock from "../../skills-lock.json";

export interface Repository {
  read(): Workspace;
  write(state: Workspace): void;
}
export interface BlobStore {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
}
const text = z.string().min(1).max(30000),
  short = z.string().min(1).max(200),
  ident = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const registration = z.object({
  name: short,
  codex: z.boolean(),
  opencode: z.boolean(),
  planning: z.boolean().optional(),
  planningModel: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  error: z.string().max(2000).optional(),
  projects: z.array(z.object({ id: ident, name: short, rootLabel: short })).max(50),
});
const completion = z.object({
  status: z.enum(["completed", "failed", "cancelled", "uncertain"]),
  output: z.string().max(150000).optional(),
  error: z.string().max(6000).optional(),
  proposal: z.unknown().optional(),
  reply: z.string().min(1).max(30000).optional(),
  externalSessionId: z.string().max(200).optional(),
  worktree: z.string().max(1000).optional(),
  branch: z.string().max(200).optional(),
  baseCommit: z.string().max(64).optional(),
  changes: z.string().max(50000).optional(),
  preflightFailure: z.boolean().optional(),
});

export async function readJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      throw new DomainError(413, "Solicitud demasiado grande.");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new DomainError(400, "JSON inválido.");
  }
}
export function errorResponse(e: unknown) {
  if (e instanceof z.ZodError)
    return Response.json(
      {
        error: "Datos inválidos.",
        details: e.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      { status: 400 },
    );
  if (e instanceof DomainError)
    return Response.json({ error: e.message }, { status: e.status });
  console.error(
    JSON.stringify({
      type: "server.error",
      message: e instanceof Error ? e.message : "Error inesperado",
    }),
  );
  return Response.json(
    { error: "Error interno. Consulta los registros del servidor." },
    { status: 500 },
  );
}
export class Service {
  constructor(
    public repo: Repository,
    public blobs: BlobStore,
    public notify: () => void = () => {},
  ) {}
  mutate<T>(fn: (e: Engine) => T): T {
    const state = structuredClone(this.repo.read()),
      e = new Engine(state);
    e.recoverStale();
    const result = fn(e);
    state.revision++;
    this.repo.write(state);
    this.notify();
    return result;
  }
  authenticate(token: string): Principal | null {
    const hash = digest(token);
    const c = this.repo.read().credentials.find((c) => c.hash === hash && !c.revokedAt);
    return c ? { id: c.id, role: c.role } : null;
  }
  view(p: Principal) {
    const before = this.repo.read();
    if (
      before.runs.some(
        (r) =>
          ["running", "waiting_permission"].includes(r.status) &&
          before.connectors.some(
            (c) =>
              c.id === r.connectorId && Date.parse(c.lastSeen) < Date.now() - 90000,
          ),
      )
    )
      this.mutate((e) => e.recoverStale());
    const s = structuredClone(this.repo.read());
    s.credentials = s.credentials.map((c) => ({ ...c, hash: "" }));
    if (p.role === "connector")
      throw new DomainError(403, "Usa los endpoints de conector.");
    return s;
  }
  async handle(request: Request, p: Principal): Promise<Response> {
    try {
      const path = new URL(request.url).pathname,
        method = request.method;
      if (method === "GET" && path === "/api/state") return Response.json(this.view(p));
      if (method === "GET" && path === "/api/identity") return Response.json(p);
      if (method === "POST" && path === "/api/chat") {
        const body = z
          .object({
            sessionId: ident.optional(),
            projectId: ident.optional(),
            message: text,
          })
          .parse(await readJson(request));
        const result = this.mutate((e) => {
          e.owner(p);
          const existing = body.sessionId ? e.session(body.sessionId) : undefined;
          if (!existing && !body.projectId)
            throw new DomainError(
              400,
              "Selecciona un proyecto para esta conversación.",
            );
          const session =
            existing ??
            e.createSession(
              p,
              body.projectId!,
              body.message.replace(/\s+/g, " ").slice(0, 80),
              body.message,
            );
          const run = e.plan(p, session.id, body.message, !!existing);
          return { sessionId: session.id, runId: run.id };
        });
        return Response.json(result, { status: 201 });
      }
      if (method === "POST" && path === "/api/credentials") {
        const body = z
          .object({ label: short, role: z.enum(["connector", "mcp"]) })
          .parse(await readJson(request));
        const token =
          "ddl_" +
          crypto.randomUUID().replaceAll("-", "") +
          crypto.randomUUID().replaceAll("-", "");
        const credential = this.mutate((e) => {
          e.owner(p);
          const c = {
            id: crypto.randomUUID(),
            label: body.label,
            role: body.role,
            hash: digest(token),
            createdAt: new Date().toISOString(),
          };
          e.state.credentials.push(c);
          e.event("credential.created", "Credencial " + body.role + " creada");
          return { ...c, hash: undefined };
        });
        return Response.json({ credential, token }, { status: 201 });
      }
      const revoke = path.match(/^\/api\/credentials\/([^/]+)\/revoke$/);
      if (method === "POST" && revoke) {
        this.mutate((e) => {
          e.owner(p);
          const c = e.state.credentials.find((c) => c.id === revoke[1]);
          if (!c) throw new DomainError(404, "Credencial no encontrada.");
          c.revokedAt = new Date().toISOString();
          e.event("credential.revoked", "Credencial revocada");
        });
        return Response.json({ ok: true });
      }
      if (method === "POST" && path === "/api/connector/register") {
        if (p.role !== "connector")
          throw new DomainError(403, "Se requiere un conector.");
        const body = registration.parse(await readJson(request));
        this.mutate((e) => {
          const c = {
            id: p.id,
            name: body.name,
            codex: body.codex,
            opencode: body.opencode,
            planning: body.planning,
            planningModel: body.planningModel,
            model: body.model,
            error: body.error,
            lastSeen: new Date().toISOString(),
          };
          const i = e.state.connectors.findIndex((x) => x.id === p.id);
          if (i < 0) e.state.connectors.push(c);
          else e.state.connectors[i] = c;
          for (const project of body.projects) {
            const existing = e.state.projects.find((x) => x.id === project.id);
            if (existing && existing.connectorId !== p.id)
              throw new DomainError(409, "El proyecto pertenece a otro conector.");
            if (!existing)
              e.state.projects.push({
                ...project,
                connectorId: p.id,
                createdAt: new Date().toISOString(),
              });
          }
        });
        return Response.json({ ok: true, connectorId: p.id });
      }
      if (method === "POST" && path === "/api/connector/claim")
        return Response.json(
          this.mutate((e) => {
            const run = e.claim(p);
            return {
              run,
              relatedRuns: run
                ? e.state.runs.filter(
                    (r) =>
                      r.sessionId === run.sessionId &&
                      r.status === "completed" &&
                      r.approvedVersion === run.approvedVersion,
                  )
                : [],
            };
          }),
        );
      if (method === "GET" && path === "/api/connector/control") {
        if (p.role !== "connector")
          throw new DomainError(403, "Se requiere un conector.");
        const s = this.repo.read(),
          runs = s.runs.filter((r) => r.connectorId === p.id);
        return Response.json({
          cancelledSessions: s.sessions
            .filter((s) => s.phase === "cancelled")
            .map((s) => s.id),
          permissions: s.permissions.filter((x) => runs.some((r) => r.id === x.runId)),
          runs: runs.map((r) => ({ id: r.id, status: r.status })),
        });
      }
      const retryRoute = path.match(/^\/api\/runs\/([^/]+)\/retry$/);
      if (method === "POST" && retryRoute) {
        const run = this.mutate((e) => e.retryPreflight(p, retryRoute[1]));
        return Response.json({ ok: true, run });
      }
      const runRoute = path.match(/^\/api\/runs\/([^/]+)\/(finish|event|permission)$/);
      if (method === "POST" && runRoute) {
        const runId = runRoute[1],
          action = runRoute[2],
          body = await readJson(request);
        if (action === "finish") {
          const data = completion.parse(body);
          const before = new Engine(this.repo.read()),
            run = before.run(runId);
          before.assigned(p, run);
          if (["completed", "failed", "cancelled"].includes(run.status))
            return Response.json({ ok: true });
          const key = `artifacts/${runId}/result.md`;
          if (data.output) await this.blobs.put(key, data.output);
          this.mutate((e) => {
            e.finish(p, runId, data);
            if (
              data.output &&
              !e.state.artifacts.some((a) => a.id === runId + "-result")
            )
              e.state.artifacts.push({
                id: runId + "-result",
                runId,
                key,
                name: "resultado.md",
                mediaType: "text/markdown",
                size: new TextEncoder().encode(data.output).length,
                createdAt: new Date().toISOString(),
              });
          });
        }
        if (action === "event") {
          const data = z
            .object({
              message: z.string().max(12000),
              externalSessionId: z.string().max(200).optional(),
              model: z.string().max(200).optional(),
            })
            .parse(body);
          this.mutate((e) => {
            const r = e.run(runId);
            e.assigned(p, r);
            if (data.externalSessionId) r.externalSessionId = data.externalSessionId;
            if (data.model) r.model = data.model;
            e.event("agent.output", data.message, r.sessionId, r.id);
          });
        }
        if (action === "permission") {
          const data = z
            .object({
              id: ident,
              method: short,
              description: z.string().max(3000),
              details: z.unknown(),
            })
            .parse(body);
          this.mutate((e) => {
            const r = e.run(runId);
            e.assigned(p, r);
            if (!["running", "waiting_permission"].includes(r.status))
              throw new DomainError(409, "Ejecución inactiva.");
            if (!e.state.permissions.some((x) => x.id === data.id)) {
              e.state.permissions.push({
                ...data,
                runId,
                createdAt: new Date().toISOString(),
              });
              r.status = "waiting_permission";
              e.event("permission.requested", data.description, r.sessionId, r.id);
            }
          });
        }
        return Response.json({ ok: true });
      }
      const reconcileRoute = path.match(/^\/api\/runs\/([^/]+)\/reconcile$/);
      if (method === "POST" && reconcileRoute) {
        const body = z
          .object({
            outcome: z.enum(["completed", "failed"]),
            evidence: z.string().min(10).max(6000),
          })
          .parse(await readJson(request));
        this.mutate((e) => {
          e.owner(p);
          const r = e.run(reconcileRoute[1]);
          if (r.status !== "uncertain")
            throw new DomainError(409, "Solo se reconcilian ejecuciones inciertas.");
          if (body.outcome === "completed" && r.kind === "planning")
            throw new DomainError(
              409,
              "Descarta esta planeación y solicita una propuesta nueva.",
            );
          r.status = body.outcome;
          r.output += "\n\nReconciliación del propietario: " + body.evidence;
          const s = e.session(r.sessionId);
          const task = s.tasks.find((t) => t.id === r.taskId);
          if (task) task.status = body.outcome === "completed" ? "completed" : "failed";
          if (r.kind === "review" && body.outcome === "completed")
            s.phase = "completed";
          e.state.permissions
            .filter((p) => p.runId === r.id && !p.decision)
            .forEach((p) => (p.decision = "decline"));
          e.event("run.reconciled", body.evidence, s.id, r.id);
        });
        return Response.json({ ok: true });
      }
      const permission = path.match(/^\/api\/permissions\/([^/]+)$/);
      if (method === "POST" && permission) {
        const body = z
          .object({
            decision: z.enum(["accept", "decline"]),
            answers: z
              .record(z.string().max(100), z.array(z.string().max(3000)).max(10))
              .optional(),
          })
          .parse(await readJson(request));
        this.mutate((e) => {
          e.owner(p);
          const x = e.state.permissions.find((x) => x.id === permission[1]);
          if (!x) throw new DomainError(404, "Permiso no encontrado.");
          if (x.decision) throw new DomainError(409, "El permiso ya fue resuelto.");
          const r = e.run(x.runId);
          if (
            !["running", "waiting_permission"].includes(r.status) ||
            e.session(r.sessionId).phase === "cancelled"
          )
            throw new DomainError(409, "El permiso ya no está activo.");
          x.decision = body.decision;
          x.answers = body.answers;
          if (!e.state.permissions.some((v) => v.runId === r.id && !v.decision))
            r.status = "running";
          e.event("permission." + body.decision, x.description, r.sessionId, r.id);
        });
        return Response.json({ ok: true });
      }
      if (method === "POST" && path === "/api/sessions") {
        const body = z
          .object({ projectId: ident, title: short, idea: text })
          .parse(await readJson(request));
        return Response.json(
          this.mutate((e) => e.createSession(p, body.projectId, body.title, body.idea)),
          { status: 201 },
        );
      }
      const sessionRoute = path.match(
        /^\/api\/sessions\/([^/]+)\/(plan|proposal|decision|branch|node|cancel|resume)$/,
      );
      if (method === "POST" && sessionRoute) {
        const sessionId = sessionRoute[1],
          action = sessionRoute[2],
          body = await readJson(request);
        const result = this.mutate((e) => {
          if (action === "plan") {
            const data = z.object({ message: text }).parse(body);
            return e.plan(p, sessionId, data.message);
          }
          if (action === "proposal") {
            if (p.role === "connector")
              throw new DomainError(
                403,
                "Entrega propuestas mediante el resultado del run.",
              );
            return e.propose(p, sessionId, body);
          }
          if (action === "decision") {
            const data = z
              .object({
                milestone: z.enum(["approach", "execution"]),
                version: z.number().int().positive(),
                digest: short,
                decision: z.enum(["approved", "rejected", "changes"]),
                explanation: z.string().max(3000).default(""),
              })
              .parse(body);
            if (data.decision === "changes" && !data.explanation.trim())
              throw new DomainError(400, "Explica qué cambios quieres solicitar.");
            e.decide(
              p,
              sessionId,
              data.milestone,
              data.version,
              data.digest,
              data.decision,
              data.explanation,
            );
            if (data.decision === "changes")
              return e.plan(
                p,
                sessionId,
                "Revisa la propuesta según esta solicitud del propietario: " +
                  data.explanation,
              );
            return;
          }
          e.owner(p);
          const s = e.session(sessionId);
          if (action === "cancel") return e.cancel(p, sessionId);
          if (action === "branch") {
            const data = z
              .object({ parentId: short, title: short, content: text })
              .parse(body);
            if (!s.nodes.some((n) => n.id === data.parentId))
              throw new DomainError(404, "Nodo no encontrado.");
            const n = {
              ...data,
              id: crypto.randomUUID(),
              kind: "idea" as const,
            };
            s.nodes.push(n);
            e.event("idea.branched", data.title, s.id);
            return n;
          }
          if (action === "node") {
            const data = z.object({ id: short, collapsed: z.boolean() }).parse(body);
            const n = s.nodes.find((n) => n.id === data.id);
            if (!n) throw new DomainError(404, "Nodo no encontrado.");
            n.collapsed = data.collapsed;
            return n;
          }
          if (action === "resume") {
            e.idle(s);
            if (
              !e.approved(s, "execution") ||
              s.tasks.some((t) => t.status === "failed")
            )
              throw new DomainError(
                409,
                "Revisa y vuelve a proponer el plan antes de continuar.",
              );
            s.phase = "executing";
            e.schedule(s);
          }
        });
        return Response.json(result ?? { ok: true });
      }
      if (method === "POST" && path === "/api/artifacts") {
        const body = z
          .object({
            runId: ident,
            name: short,
            content: z.string().max(400000),
            mediaType: z.enum(["text/plain", "text/markdown", "application/json"]),
          })
          .parse(await readJson(request));
        const e = new Engine(this.repo.read());
        e.assigned(p, e.run(body.runId));
        const artifactId = crypto.randomUUID(),
          key = `artifacts/${body.runId}/${artifactId}`;
        await this.blobs.put(key, body.content);
        const artifact = {
          id: artifactId,
          runId: body.runId,
          key,
          name: body.name,
          mediaType: body.mediaType,
          size: new TextEncoder().encode(body.content).length,
          createdAt: new Date().toISOString(),
        };
        this.mutate((e) => {
          e.assigned(p, e.run(body.runId));
          e.state.artifacts.push(artifact);
        });
        return Response.json(artifact, { status: 201 });
      }
      const artifactRoute = path.match(/^\/api\/artifacts\/([^/]+)$/);
      if (method === "GET" && artifactRoute) {
        if (p.role !== "owner") throw new DomainError(403, "Acceso denegado.");
        const a = this.repo.read().artifacts.find((a) => a.id === artifactRoute[1]);
        if (!a) throw new DomainError(404, "Artefacto no encontrado.");
        const content = await this.blobs.get(a.key);
        return new Response(content, {
          headers: {
            "Content-Type": a.mediaType + "; charset=utf-8",
            "Content-Disposition": `attachment; filename="${a.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
          },
        });
      }
      if (method === "POST" && path === "/api/skill-resources") {
        if (p.role !== "connector")
          throw new DomainError(403, "Se requiere un conector.");
        const body = z
          .object({
            source: short,
            revision: z.string().regex(/^[a-f0-9]{40}$/),
            path: z.string().min(1).max(500),
            content: z.string().max(400000),
          })
          .parse(await readJson(request));
        if (
          !skillLock.sources.some(
            (s) => s.id === body.source && s.revision === body.revision,
          ) ||
          body.path.split(/[\\/]/).some((p) => p === ".." || p === "." || !p) ||
          body.path.startsWith("/")
        )
          throw new DomainError(400, "Recurso fuera de las fuentes fijadas.");
        await this.blobs.put(
          `skills/${body.source}/${body.revision}/${body.path}`,
          body.content,
        );
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Ruta no encontrada." }, { status: 404 });
    } catch (e) {
      return errorResponse(e);
    }
  }
}
