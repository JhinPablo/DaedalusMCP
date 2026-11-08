import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config";
import { CodexClient } from "./codex";
import { OpenCodeClient } from "./opencode";
import { planWithFallback, planWithLuna } from "./planning";
import { loadPlanningSession, isRunJournalFile } from "./planning-session";
import { Worktrees } from "./worktrees";
import { projectContext } from "./context";
import { taskReport, ExecutionOutcomeError } from "./outcome";
import { loadSkills, skillCatalog, type SkillEntry } from "./skills";
import type { AgentRun, PermissionRequest } from "../shared/model";
import type { ReleaseCandidate } from "../shared/model";
import { publishReviews, publishTaskProgress } from "./publisher";

interface Journal {
  run: AgentRun;
  stage: "started" | "finished";
  outcome?: Record<string, unknown>;
}
const args = process.argv.slice(2),
  configPath = args.includes("--config")
    ? args[args.indexOf("--config") + 1]
    : "connector.local.json";
const config = await loadConfig(configPath),
  base = config.serverUrl.replace(/\/$/, "");
let token = process.env[config.tokenEnv];
if (!token && new URL(base).hostname === "127.0.0.1") {
  try {
    token = (
      await readFile(
        path.join(
          path.dirname(path.resolve(configPath)),
          ".daedalus/dev-connector-token",
        ),
        "utf8",
      )
    ).trim();
  } catch {
    /* explicit setup error below */
  }
}
if (!token)
  throw new Error(
    `Falta ${config.tokenEnv}. Crea una credencial de conector en el panel.`,
  );
const root = path.resolve(config.journalRoot);
await mkdir(root, { recursive: true });
const log = (message: string) => console.log(new Date().toISOString() + " " + message);
async function api<T = unknown>(route: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  const res = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok)
    throw new Error(`Daedalus (${res.status}): ${(await res.text()).slice(0, 1000)}`);
  return res.json() as Promise<T>;
}
async function save(journal: Journal) {
  const f = path.join(root, journal.run.id + ".json");
  await writeFile(f + ".tmp", JSON.stringify(journal, null, 2));
  await rename(f + ".tmp", f);
}
const openCode = new OpenCodeClient(
  config.opencodeUrl,
  config.opencodeModel,
  path.join(root, "..", "opencode-availability.json"),
);
let codex = false,
  opencode = false,
  luna = false,
  planningModel = "",
  capabilityError = "";
let catalog: SkillEntry[] = [];
let lastReleasePoll = 0;
async function pollRepositoryReleases() {
  if (
    !config.releaseControlUrl ||
    !config.publishRepository ||
    Date.now() - lastReleasePoll < 60000
  )
    return;
  lastReleasePoll = Date.now();
  const publisherToken = process.env.DAEDALUS_PUBLISHER_TOKEN;
  if (!publisherToken)
    throw new Error("Falta la credencial del publicador de staging.");
  const releaseApi = async <T = unknown>(route: string, body?: unknown): Promise<T> => {
    const response = await fetch(config.releaseControlUrl!.replace(/\/$/, "") + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + publisherToken,
        "Content-Type": "application/json",
        "CF-Access-Client-Id": process.env.STAGING_ACCESS_CLIENT_ID ?? "",
        "CF-Access-Client-Secret": process.env.STAGING_ACCESS_CLIENT_SECRET ?? "",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Publicador staging: " + response.status);
    return response.json() as Promise<T>;
  };
  const releases = await releaseApi<ReleaseCandidate[]>("/api/releases");
  await publishReviews(
    config.publishRepository,
    path.join(root, "repository-releases"),
    [],
    releases.filter((r) => r.kind === "repository"),
    releaseApi,
    [],
    "staging",
  );
}
async function probe() {
  const errors: string[] = [];
  luna = false;
  try {
    const c = new CodexClient(
      config.codexCommand,
      config.projects[0].root,
      async () => ({ decision: "decline" }),
    );
    try {
      await c.initialize();
      await c.account();
      codex = true;
      if (config.planningFallback === "luna-high") {
        try {
          await c.requireLunaHigh();
          luna = true;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      c.close();
    }
  } catch (e) {
    codex = false;
    errors.push(e instanceof Error ? e.message : String(e));
  }
  try {
    catalog = await skillCatalog(config.skillsRoot);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  try {
    opencode = await openCode.available();
  } catch (e) {
    opencode = false;
    errors.push(e instanceof Error ? e.message : String(e));
  }
  capabilityError = errors.join("\n");
  planningModel = opencode
    ? "opencode/" + config.opencodeModel
    : luna
      ? "gpt-6-luna · alto"
      : "Sin planificador disponible";
}
async function register() {
  await api("/api/connector/register", {
    name: config.name,
    codex,
    opencode,
    planning: opencode || luna,
    planningModel,
    model: "opencode/" + config.opencodeModel,
    error: capabilityError || undefined,
    projects: config.projects.map((p) => ({
      id: p.id,
      name: p.name,
      rootLabel: path.basename(p.root),
    })),
  });
}
const active = new Map<string, AbortController>();
let permissions: PermissionRequest[] = [];
let stopping = false;
let draining = false;
async function permission(
  run: AgentRun,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    run.kind === "review" &&
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(method)
  ) {
    await api("/api/runs/" + run.id + "/event", {
      message: "Permiso adicional denegado: la revisión final es de solo lectura.",
    });
    return { decision: "decline" };
  }
  const supported = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
  ];
  if (!supported.includes(method)) {
    await api("/api/runs/" + run.id + "/event", {
      message: "Solicitud no compatible bloqueada: " + method,
    });
    if (method === "item/permissions/requestApproval")
      return { permissions: {}, scope: "turn" };
    if (method === "mcpServer/elicitation/request")
      return { action: "decline", content: null };
    throw new Error("Solicitud de Codex no compatible; no se concedieron permisos.");
  }
  const permissionId = crypto.randomUUID();
  await api("/api/runs/" + run.id + "/permission", {
    id: permissionId,
    method,
    description: String(
      params.reason ??
        params.command ??
        "Codex solicita autorización para modificar archivos.",
    ),
    details: params,
  });
  while (!stopping && !active.get(run.id)?.signal.aborted) {
    const pending = permissions.find((p) => p.id === permissionId);
    if (pending?.decision) {
      if (method === "item/tool/requestUserInput")
        return {
          answers: Object.fromEntries(
            Object.entries(pending.answers ?? {}).map(([id, answers]) => [
              id,
              { answers },
            ]),
          ),
        };
      if (method === "item/permissions/requestApproval") {
        const requested = params.permissions as { network?: unknown } | undefined;
        return {
          permissions:
            pending.decision === "accept" && requested?.network
              ? { network: requested.network }
              : {},
          scope: "turn",
        };
      }
      return { decision: pending.decision };
    }
    await delay(500);
  }
  if (method === "item/permissions/requestApproval")
    return { permissions: {}, scope: "turn" };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  return { decision: "cancel" };
}
async function execute(run: AgentRun, relatedRuns: AgentRun[]) {
  const controller = new AbortController();
  active.set(run.id, controller);
  const journal: Journal = { run, stage: "started" };
  await save(journal);
  let client: CodexClient | undefined;
  let worktree: string | undefined;
  let branch: string | undefined;
  let baseCommit: string | undefined;
  let preflight = true;
  try {
    const project = config.projects.find((p) => p.id === run.projectId);
    if (!project) throw new Error("El proyecto no está autorizado en este conector.");
    const skills = await loadSkills(config.skillsRoot, run.skills);
    preflight = false;
    const onSession = async (externalSessionId: string) => {
      run.externalSessionId = externalSessionId;
      await save(journal);
      await api("/api/runs/" + run.id + "/event", {
        message: "Conversación local conectada.",
        externalSessionId,
        model: run.model,
      });
    };
    if (run.kind === "planning") {
      const deepseekSession = await loadPlanningSession(
        root,
        run,
        "OpenCode · DeepSeek V4.1 Flash Free",
      );
      const lunaSession =
        config.planningFallback === "luna-high"
          ? await loadPlanningSession(root, run, "GPT-6 Luna · alto")
          : undefined;
      run.model = "OpenCode · DeepSeek V4.1 Flash Free";
      const planningPrompt =
        run.prompt +
        "\n\n" +
        (await projectContext(project.root)) +
        "\n\nSkills disponibles para asignar a tareas (usa exclusivamente estos identificadores; deja [] si no corresponde):\n" +
        catalog.map((s) => s.id + " — " + s.description).join("\n") +
        "\n\n" +
        skills;
      const result = await planWithFallback(
        () =>
          openCode.plan(
            planningPrompt,
            project.root,
            controller.signal,
            onSession,
            deepseekSession,
          ),
        config.planningFallback === "luna-high"
          ? async () => {
              client = new CodexClient(config.codexCommand, project.root, async () => ({
                decision: "decline",
              }));
              return planWithLuna(
                client,
                planningPrompt,
                project.root,
                controller.signal,
                onSession,
                lunaSession,
              );
            }
          : undefined,
        controller.signal,
        async (reason) => {
          run.model = "GPT-6 Luna · alto";
          run.externalSessionId = undefined;
          planningModel = "gpt-6-luna · alto";
          try {
            await openCode.available();
          } catch {
            opencode = false;
          }
          capabilityError = reason;
          await api("/api/runs/" + run.id + "/event", {
            model: run.model,
            message:
              "DeepSeek no completó la petición. Cambio automático a GPT-6 Luna con esfuerzo alto (ChatGPT, solo lectura). Motivo: " +
              reason,
          });
          await register();
        },
      );
      journal.outcome = {
        status: "completed",
        ...result,
        externalSessionId: run.externalSessionId,
      };
    } else {
      const manager = new Worktrees(project.root, path.join(root, "worktrees"));
      const baseFile = path.join(
        root,
        "session-" + run.sessionId + "-v" + run.approvedVersion + ".base",
      );
      try {
        baseCommit = (await readFile(baseFile, "utf8")).trim();
      } catch {
        baseCommit = await manager.baseline();
        await writeFile(baseFile, baseCommit);
      }
      // Every completed branch is included so a task sees already integrated work. Independent active tasks remain isolated.
      const branches = relatedRuns
        .filter((r) => r.kind === "task" && r.branch)
        .map((r) => r.branch!);
      const workspace = await manager.prepare(run.id, baseCommit, branches);
      worktree = workspace.worktree;
      branch = workspace.branch;
      run.worktree = worktree;
      run.branch = branch;
      run.baseCommit = baseCommit;
      await save(journal);
      const events: Array<string> = [];
      client = new CodexClient(
        config.codexCommand,
        worktree,
        (m, p) => permission(run, m, p),
        (m) => {
          if (
            m.method === "item/agentMessage/delta" &&
            typeof m.params?.delta === "string"
          )
            events.push(m.params.delta);
        },
      );
      const stream = setInterval(() => {
        if (events.length) {
          const message = events.splice(0).join("").slice(0, 12000);
          void api("/api/runs/" + run.id + "/event", { message }).catch(() => {});
        }
      }, 1200);
      let output: string;
      try {
        output = await client.execute(
          run.prompt + "\n\n" + skills,
          worktree,
          run.kind === "review",
          controller.signal,
          onSession,
          run.approvedVersion && run.approvedDigest
            ? { version: run.approvedVersion, digest: run.approvedDigest }
            : undefined,
        );
      } finally {
        clearInterval(stream);
      }
      if (run.kind === "task") output = taskReport(output);
      const result =
        run.kind === "task"
          ? await manager.finish(worktree)
          : { changes: "Revisión de solo lectura." };
      journal.outcome = {
        status: "completed",
        output,
        externalSessionId: run.externalSessionId,
        worktree,
        branch,
        baseCommit,
        ...result,
      };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (run.kind === "planning" && !controller.signal.aborted) {
      try {
        await openCode.available();
      } catch (availabilityError) {
        opencode = false;
        capabilityError =
          availabilityError instanceof Error
            ? availabilityError.message
            : String(availabilityError);
        await register().catch(() => {});
      }
    }
    journal.outcome = {
      status: controller.signal.aborted
        ? "cancelled"
        : e instanceof ExecutionOutcomeError
          ? "failed"
          : run.externalSessionId && run.kind !== "planning"
            ? "uncertain"
            : "failed",
      error: message,
      preflightFailure: preflight && run.kind === "task",
      externalSessionId: run.externalSessionId,
      worktree,
      branch,
      baseCommit,
    };
  } finally {
    client?.close();
    journal.stage = "finished";
    await save(journal);
    try {
      await api("/api/runs/" + run.id + "/finish", {
        ...journal.outcome,
        localArtifactPath: path.join(root, run.id + ".json"),
      });
      log(`Finalizada ${run.id}: ${String(journal.outcome?.status)}`);
      if (
        config.publishRepository &&
        run.kind === "task" &&
        journal.outcome?.status === "completed"
      ) {
        try {
          await publishTaskProgress(
            config.publishRepository,
            root,
            { ...run, ...journal.outcome } as AgentRun,
            api,
          );
        } catch (error) {
          log(String(error));
          await api(`/api/runs/${run.id}/event`, { message: String(error) });
        }
      }
    } catch {
      log(`Resultado conservado localmente para reconciliar: ${run.id}`);
    }
    active.delete(run.id);
  }
}
async function reconcile() {
  for (const name of (await readdir(root)).filter(isRunJournalFile)) {
    const j = JSON.parse(await readFile(path.join(root, name), "utf8")) as Journal;
    if (active.has(j.run.id)) continue;
    if (j.stage === "started") {
      j.stage = "finished";
      j.outcome = {
        status: "uncertain",
        error:
          "El conector se reinició durante la ejecución. Inspecciona la sesión y el worktree antes de continuar.",
        externalSessionId: j.run.externalSessionId,
        worktree: j.run.worktree,
        branch: j.run.branch,
        baseCommit: j.run.baseCommit,
      };
      await save(j);
    }
    if (j.outcome) await api("/api/runs/" + j.run.id + "/finish", j.outcome);
  }
}
await probe();
await register();
await reconcile();
log("Conector listo. Controla el trabajo desde " + base);
process.on("SIGINT", () => {
  stopping = true;
  active.forEach((c) => c.abort());
});
process.on("SIGTERM", () => {
  stopping = true;
  active.forEach((c) => c.abort());
});
let lastRegister = Date.now(),
  lastProbe = Date.now();
while (!stopping) {
  try {
    try {
      await readFile(path.join(root, "drain"));
      draining = true;
      if (!active.size) {
        stopping = true;
        break;
      }
    } catch {}
    if (Date.now() - lastProbe > 60000) {
      await probe();
      lastProbe = Date.now();
    }
    if (Date.now() - lastRegister > 60000) {
      await register();
      await reconcile();
      lastRegister = Date.now();
    }
    const control = await api<{
      run: AgentRun | null;
      relatedRuns: AgentRun[];
      cancelledSessions: string[];
      permissions: PermissionRequest[];
      completedReviews: AgentRun[];
      releases: ReleaseCandidate[];
    }>("/api/connector/poll", {
      capacity:
        stopping || draining ? 0 : Math.max(0, config.maxParallel - active.size),
    });
    permissions = control.permissions;
    for (const [runId, c] of active) {
      const j = JSON.parse(
        await readFile(path.join(root, runId + ".json"), "utf8"),
      ) as Journal;
      if (control.cancelledSessions.includes(j.run.sessionId)) c.abort();
    }
    if (control.run)
      void execute(control.run, control.relatedRuns).catch((e) =>
        log("Fallo del conector: " + String(e)),
      );
    if (!active.size && !draining) await pollRepositoryReleases();
    if (!active.size && !draining && config.publishRepository)
      await publishReviews(
        config.publishRepository,
        root,
        control.completedReviews ?? [],
        control.releases ?? [],
        api,
        config.projects,
      );
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
  }
  await delay(active.size ? 5000 : 15000);
}
while (active.size) await delay(300);
