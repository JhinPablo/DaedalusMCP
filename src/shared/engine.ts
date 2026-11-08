import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  activeStatuses,
  currentVersion,
  proposalInput,
  terminalStatuses,
  type AgentRun,
  type Principal,
  type Proposal,
  type Session,
  type Workspace,
} from "./model";
import { canRetryPreflight } from "./run-state";

export class DomainError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const digest = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
export function assertDag(proposal: Proposal) {
  const tasks = new Map(proposal.tasks.map((t) => [t.id, t]));
  if (tasks.size !== proposal.tasks.length)
    throw new DomainError(400, "Los identificadores de tareas deben ser únicos.");
  const visited = new Set<string>(),
    visiting = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key))
      throw new DomainError(400, "El plan contiene dependencias circulares.");
    if (visited.has(key)) return;
    const t = tasks.get(key);
    if (!t) throw new DomainError(400, `Dependencia desconocida: ${key}`);
    visiting.add(key);
    t.dependsOn.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  }
  tasks.forEach((t) => visit(t.id));
}
export class Engine {
  constructor(public state: Workspace) {}
  event(type: string, message: string, sessionId?: string, runId?: string) {
    this.state.events.push({
      id: id(),
      at: now(),
      type,
      message,
      sessionId,
      runId,
    });
    this.state.events = this.state.events.slice(-1000);
  }
  owner(p: Principal) {
    if (p.role !== "owner")
      throw new DomainError(403, "Solo el propietario puede tomar esta decisión.");
  }
  session(sessionId: string) {
    const s = this.state.sessions.find((s) => s.id === sessionId);
    if (!s) throw new DomainError(404, "Sesión no encontrada.");
    return s;
  }
  run(runId: string) {
    const r = this.state.runs.find((r) => r.id === runId);
    if (!r) throw new DomainError(404, "Ejecución no encontrada.");
    return r;
  }
  idle(s: Session) {
    if (
      this.state.runs.some(
        (r) => r.sessionId === s.id && activeStatuses.includes(r.status),
      )
    )
      throw new DomainError(
        409,
        "Detén o reconcilia la ejecución activa antes de cambiar el plan.",
      );
  }
  assigned(p: Principal, r: AgentRun) {
    if (p.role !== "connector" || r.connectorId !== p.id)
      throw new DomainError(403, "La ejecución pertenece a otro conector.");
  }
  queue(
    s: Session,
    kind: AgentRun["kind"],
    prompt: string,
    taskId?: string,
    skills: string[] = [],
  ) {
    const run: AgentRun = {
      id: id(),
      sessionId: s.id,
      projectId: s.projectId,
      kind,
      taskId,
      status: "queued",
      prompt,
      skills,
      approvedDigest: currentVersion(s)?.digest,
      approvedVersion: currentVersion(s)?.version,
      createdAt: now(),
      output: "",
    };
    this.state.runs.push(run);
    this.event(
      "run.queued",
      `${kind === "planning" ? "Planeación" : kind === "review" ? "Revisión final" : "Tarea"} en cola`,
      s.id,
      run.id,
    );
    return run;
  }
  createSession(p: Principal, projectId: string, title: string, idea: string) {
    this.owner(p);
    if (!this.state.projects.some((x) => x.id === projectId))
      throw new DomainError(404, "Proyecto no registrado por el conector.");
    const s: Session = {
      id: id(),
      projectId,
      title,
      phase: "idea",
      nodes: [{ id: id(), kind: "idea", title, content: idea }],
      messages: [{ id: id(), role: "user", content: idea, createdAt: now() }],
      versions: [],
      approvals: [],
      tasks: [],
      createdAt: now(),
    };
    this.state.sessions.push(s);
    this.event("session.created", "Idea creada", s.id);
    return s;
  }
  plan(p: Principal, sessionId: string, message: string, recordMessage = true) {
    this.owner(p);
    const s = this.session(sessionId);
    this.idle(s);
    const returnPhase = s.phase;
    if (recordMessage)
      s.messages.push({
        id: id(),
        role: "user",
        content: message,
        createdAt: now(),
      });
    s.phase = "planning";
    const context = s.messages
      .slice(-20)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");
    const run = this.queue(
      s,
      "planning",
      `${context}\n\nIdeas y ramas guardadas:\n${JSON.stringify(s.nodes.filter((n) => n.kind === "idea"))}\n\nPropuesta previa:\n${JSON.stringify(currentVersion(s)?.proposal ?? null)}`,
      undefined,
      ["superpowers:brainstorming", "superpowers:writing-plans"],
    );
    run.returnPhase = returnPhase;
    return run;
  }
  propose(p: Principal, sessionId: string, input: unknown) {
    if (!["owner", "mcp", "connector"].includes(p.role))
      throw new DomainError(403, "Acceso denegado.");
    const s = this.session(sessionId);
    this.idle(s);
    const proposal = proposalInput.parse(input);
    assertDag(proposal);
    s.versions.push({
      version: s.versions.length + 1,
      digest: digest(proposal),
      proposal,
      createdAt: now(),
    });
    s.phase = "approach";
    s.tasks = proposal.tasks.map((t) => ({ ...t, status: "pending" }));
    const root = s.nodes.find((n) => n.kind === "idea")!;
    const ideas = s.nodes.filter((n) => n.kind === "idea");
    const ideaIds = new Set(ideas.map((n) => n.id));
    for (const idea of ideas) {
      if (idea.parentId && !ideaIds.has(idea.parentId)) idea.parentId = root.id;
    }
    s.nodes = [
      ...ideas,
      ...proposal.alternatives.map((a) => ({
        id: id(),
        parentId: root.id,
        kind: "alternative" as const,
        title: a.title,
        content: `${a.explanation}\n\n${a.tradeoffs}`,
      })),
    ];
    const critique = {
      id: id(),
      parentId: root.id,
      kind: "critique" as const,
      title: "Crítica del enfoque",
      content: proposal.critique,
    };
    s.nodes.push(critique);
    const prompt = {
      id: id(),
      parentId: critique.id,
      kind: "prompt" as const,
      title: `Prompt · versión ${s.versions.length}`,
      content: proposal.prompt,
    };
    s.nodes.push(prompt);
    const taskNodes = new Map(s.tasks.map((t) => [t.id, id()]));
    s.tasks.forEach((t) =>
      s.nodes.push({
        id: taskNodes.get(t.id)!,
        taskId: t.id,
        parentId: t.dependsOn[0] ? taskNodes.get(t.dependsOn[0]) : prompt.id,
        kind: "task",
        title: t.title,
        content: t.prompt,
      }),
    );
    s.messages.push({
      id: id(),
      role: "assistant",
      content: proposal.recommendation,
      createdAt: now(),
    });
    this.event(
      "proposal.created",
      `Propuesta v${s.versions.length}; requiere nuevas aprobaciones`,
      s.id,
    );
    return currentVersion(s)!;
  }
  decide(
    p: Principal,
    sessionId: string,
    milestone: "approach" | "execution",
    version: number,
    fingerprint: string,
    decision: "approved" | "rejected" | "changes",
    explanation: string,
  ) {
    this.owner(p);
    const s = this.session(sessionId),
      v = currentVersion(s);
    if (!v || v.version !== version || v.digest !== fingerprint)
      throw new DomainError(409, "La propuesta cambió. Revisa la versión actual.");
    this.idle(s);
    if (
      s.approvals.some(
        (a) =>
          a.version === version &&
          a.digest === fingerprint &&
          a.milestone === milestone &&
          a.decision === "approved",
      )
    )
      throw new DomainError(409, "Este hito ya está aprobado.");
    if (milestone === "execution" && !this.approved(s, "approach"))
      throw new DomainError(409, "Aprueba primero el enfoque.");
    s.approvals.push({
      id: id(),
      milestone,
      version,
      digest: fingerprint,
      decision,
      explanation,
      createdAt: now(),
    });
    s.phase =
      decision !== "approved"
        ? "paused"
        : milestone === "approach"
          ? "plan"
          : "executing";
    this.event(
      "approval." + decision,
      `${milestone === "approach" ? "Enfoque" : "Ejecución"}: ${decision}. ${explanation}`,
      s.id,
    );
    if (milestone === "execution" && decision === "approved") this.schedule(s);
  }
  approved(s: Session, milestone: "approach" | "execution") {
    const v = currentVersion(s);
    return (
      !!v &&
      s.approvals.some(
        (a) =>
          a.milestone === milestone &&
          a.version === v.version &&
          a.digest === v.digest &&
          a.decision === "approved",
      )
    );
  }
  schedule(s: Session) {
    if (
      !this.approved(s, "execution") ||
      s.phase === "cancelled" ||
      s.phase === "paused"
    )
      return;
    const active = this.state.runs.filter(
      (r) => r.sessionId === s.id && activeStatuses.includes(r.status),
    );
    if (active.some((r) => r.status === "uncertain")) {
      s.phase = "paused";
      return;
    }
    let slots = Math.max(
      0,
      3 -
        this.state.runs.filter(
          (r) => r.kind === "task" && activeStatuses.includes(r.status),
        ).length,
    );
    for (const t of s.tasks) {
      if (slots === 0) break;
      if (
        t.status === "pending" &&
        !t.runId &&
        t.dependsOn.every(
          (d) => s.tasks.find((x) => x.id === d)?.status === "completed",
        )
      ) {
        const v = currentVersion(s)!;
        const r = this.queue(
          s,
          "task",
          `${v.proposal.prompt}\n\nTAREA ASIGNADA: ${t.title}\n${t.prompt}\n\nCriterios:\n${t.acceptance.join("\n")}\n\nÁreas autorizadas:\n${t.areas.join("\n")}`,
          t.id,
          t.skills,
        );
        t.runId = r.id;
        slots--;
      }
    }
    if (
      s.tasks.length &&
      s.tasks.every((t) => t.status === "completed") &&
      !this.state.runs.some(
        (r) =>
          r.sessionId === s.id &&
          r.kind === "review" &&
          r.approvedVersion === currentVersion(s)?.version,
      )
    ) {
      s.phase = "review";
      this.queue(
        s,
        "review",
        `Revisa de forma independiente el cumplimiento del plan. No modifiques archivos. Incluye hallazgos, pruebas verificadas, limitaciones y un veredicto.\n${JSON.stringify(currentVersion(s)!.proposal)}\nResultados:\n${JSON.stringify(this.state.runs.filter((r) => r.sessionId === s.id && r.kind === "task" && r.approvedVersion === currentVersion(s)?.version).map((r) => ({ output: r.output, branch: r.branch, changes: r.changes })))}`,
      );
    }
  }
  claim(p: Principal) {
    if (p.role !== "connector") throw new DomainError(403, "Se requiere un conector.");
    const c = this.state.connectors.find((c) => c.id === p.id);
    if (!c) throw new DomainError(409, "Registra el conector primero.");
    c.lastSeen = now();
    const run = this.state.runs.find(
      (r) =>
        r.status === "queued" &&
        this.session(r.sessionId).phase ===
          (r.kind === "planning"
            ? "planning"
            : r.kind === "review"
              ? "review"
              : "executing") &&
        this.state.projects.some(
          (x) => x.id === r.projectId && x.connectorId === p.id,
        ) &&
        (r.kind === "planning" ? (c.planning ?? c.opencode) : c.codex),
    );
    if (!run) return null;
    if (run.kind !== "planning") {
      const s = this.session(run.sessionId);
      if (
        !this.approved(s, "execution") ||
        currentVersion(s)?.digest !== run.approvedDigest ||
        currentVersion(s)?.version !== run.approvedVersion
      )
        throw new DomainError(409, "La ejecución perdió su aprobación.");
    }
    run.status = "running";
    run.connectorId = p.id;
    run.startedAt = now();
    const s = this.session(run.sessionId);
    const task = s.tasks.find((t) => t.id === run.taskId);
    if (task) task.status = "running";
    this.event("run.started", "El conector inició la ejecución", s.id, run.id);
    return run;
  }
  finish(
    p: Principal,
    runId: string,
    result: {
      status: "completed" | "failed" | "cancelled" | "uncertain";
      output?: string;
      error?: string;
      proposal?: unknown;
      reply?: string;
      externalSessionId?: string;
      worktree?: string;
      branch?: string;
      baseCommit?: string;
      changes?: string;
      preflightFailure?: boolean;
    },
  ) {
    const r = this.run(runId);
    this.assigned(p, r);
    if (terminalStatuses.includes(r.status)) return;
    const s = this.session(r.sessionId);
    r.status = result.status;
    r.output = result.output ?? r.output;
    r.error = result.error;
    r.preflightFailure = result.preflightFailure === true;
    r.finishedAt = now();
    for (const key of [
      "externalSessionId",
      "worktree",
      "branch",
      "baseCommit",
      "changes",
    ] as const)
      if (result[key]) r[key] = result[key];
    this.state.permissions
      .filter((x) => x.runId === r.id && !x.decision)
      .forEach((x) => (x.decision = "decline"));
    const task = s.tasks.find((t) => t.id === r.taskId);
    if (task) task.status = r.status === "completed" ? "completed" : "failed";
    this.event("run." + r.status, result.error ?? "Ejecución " + r.status, s.id, r.id);
    if (s.phase === "cancelled") return;
    if (r.status !== "completed") {
      s.phase = "paused";
      this.cancelQueued(s);
      return;
    }
    if (r.kind === "planning") {
      if (!result.proposal && result.reply) {
        s.messages.push({
          id: id(),
          role: "assistant",
          content: result.reply,
          model: r.model,
          createdAt: now(),
        });
        s.phase = r.returnPhase ?? (currentVersion(s) ? "approach" : "idea");
        this.event(
          "planner.replied",
          "El planificador respondió en el chat",
          s.id,
          r.id,
        );
        return;
      }
      if (!result.proposal) {
        r.status = "failed";
        r.error = "El planificador no devolvió una propuesta válida.";
        s.phase = "paused";
        return;
      }
      this.propose(p, s.id, result.proposal);
      const response = s.messages.at(-1);
      if (response?.role === "assistant") response.model = r.model;
    } else if (r.kind === "review") {
      s.phase = "completed";
      s.nodes.push({
        id: id(),
        parentId: s.nodes.filter((n) => n.kind === "task").at(-1)?.id,
        kind: "review",
        title: "Revisión final",
        content: r.output,
      });
    } else this.schedule(s);
    for (const other of this.state.sessions.filter(
      (x) => x.id !== s.id && x.phase === "executing",
    ))
      this.schedule(other);
  }
  retryPreflight(p: Principal, runId: string) {
    this.owner(p);
    const previous = this.run(runId),
      s = this.session(previous.sessionId),
      version = currentVersion(s);
    this.idle(s);
    if (!canRetryPreflight(previous) || s.phase !== "paused")
      throw new DomainError(
        409,
        "Solo se puede reintentar una tarea que falló antes de iniciar su ejecución. Reconcilia primero cualquier resultado incierto.",
      );
    if (
      !this.approved(s, "execution") ||
      !this.approved(s, "approach") ||
      version?.digest !== previous.approvedDigest ||
      version?.version !== previous.approvedVersion
    )
      throw new DomainError(
        409,
        "El plan cambió o perdió su aprobación. Revisa y aprueba la versión vigente.",
      );
    const task = s.tasks.find(
      (t) => t.id === previous.taskId && t.runId === previous.id,
    );
    if (!task || task.status !== "failed")
      throw new DomainError(409, "La tarea ya no corresponde a esta ejecución.");
    task.status = "pending";
    task.runId = undefined;
    s.phase = "executing";
    this.event(
      "run.retry_requested",
      "El propietario reintentó la preparación de una tarea que no llegó a ejecutarse.",
      s.id,
      previous.id,
    );
    this.schedule(s);
    return task.runId ? this.run(task.runId) : null;
  }
  cancelQueued(s: Session) {
    this.state.runs
      .filter((r) => r.sessionId === s.id && r.status === "queued")
      .forEach((r) => {
        r.status = "cancelled";
        const task = s.tasks.find((t) => t.runId === r.id);
        if (task) {
          task.runId = undefined;
          task.status = "pending";
        }
      });
  }
  cancel(p: Principal, sessionId: string) {
    this.owner(p);
    const s = this.session(sessionId);
    s.phase = "cancelled";
    this.cancelQueued(s);
    this.event(
      "session.cancelled",
      "Cancelación solicitada; los procesos activos deben confirmar su detención.",
      s.id,
    );
  }
  recoverStale() {
    const cutoff = Date.now() - 90000;
    for (const c of this.state.connectors.filter(
      (c) => Date.parse(c.lastSeen) < cutoff,
    )) {
      for (const r of this.state.runs.filter(
        (r) =>
          r.connectorId === c.id &&
          ["running", "waiting_permission"].includes(r.status),
      )) {
        r.status = "uncertain";
        const s = this.session(r.sessionId);
        s.phase = "paused";
        this.cancelQueued(s);
        this.event(
          "run.uncertain",
          "Conector desconectado; no se repetirá la ejecución automáticamente.",
          r.sessionId,
          r.id,
        );
      }
    }
  }
}
