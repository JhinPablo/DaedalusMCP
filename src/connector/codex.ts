import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { outcomeJsonSchema } from "./outcome";

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string; code: number };
}
export type PermissionHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
export interface PlanningOptions {
  threadId?: string;
  model: "gpt-6-luna";
  effort: "high";
  instructions: string;
  schema: Record<string, unknown>;
}
export class CodexClient {
  private process: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(message: RpcMessage) => void>();
  private permission: PermissionHandler;
  constructor(
    command: string,
    cwd: string,
    onPermission: PermissionHandler,
    onEvent: (message: RpcMessage) => void = () => {},
  ) {
    this.permission = onPermission;
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)/i.test(key))
        delete env[key];
    delete env.OPENAI_API_KEY;
    this.process = spawn(command, ["app-server", "--listen", "stdio://"], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line) as RpcMessage;
        void this.receive(message).catch(() => this.close());
      } catch {
        /* non-JSON diagnostics are not protocol messages */
      }
    });
    this.listeners.add(onEvent);
    this.process.stderr.on("data", () => {
      /* diagnostics may include paths; never forward credentials */
    });
    const failed = (error: Error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      for (const fn of this.listeners)
        fn({ method: "transport/closed", params: { message: error.message } });
    };
    this.process.on("error", failed);
    this.process.on("exit", (code) =>
      failed(new Error(`Codex terminó (${code ?? "sin código"}).`)),
    );
  }
  private send(message: object) {
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  private async receive(message: RpcMessage) {
    if (message.id !== undefined && message.method) {
      try {
        const result = await this.permission(message.method, message.params ?? {});
        this.send({ id: message.id, result });
      } catch {
        this.send({
          id: message.id,
          error: { code: -32000, message: "Solicitud no aprobada." },
        });
      }
      return;
    }
    if (typeof message.id === "number") {
      const p = this.pending.get(message.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message));
        else p.resolve(message.result);
      }
      return;
    }
    for (const fn of this.listeners) fn(message);
  }
  request<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    timeoutMs = 30000,
  ): Promise<T> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex no respondió a ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "daedalus", title: "Daedalus", version: "0.1.0" },
      capabilities: {},
    });
    this.send({ method: "initialized" });
  }
  async account() {
    const result = await this.request<{ account: { type: string } | null }>(
      "account/read",
      { refreshToken: false },
    );
    if (result.account?.type !== "chatgpt")
      throw new Error(
        "Inicia sesión en Codex con ChatGPT. Daedalus no permite autenticación por API key.",
      );
  }
  async requireLunaHigh() {
    const result = await this.request<{
      data: Array<{
        model: string;
        supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
      }>;
      nextCursor?: string | null;
    }>("model/list", { includeHidden: true });
    let models = result.data;
    let cursor = result.nextCursor;
    while (cursor && !models.some((m) => m.model === "gpt-6-luna")) {
      const page = await this.request<typeof result>("model/list", {
        includeHidden: true,
        cursor,
      });
      models = models.concat(page.data);
      cursor = page.nextCursor;
    }
    if (
      !models.some(
        (m) =>
          m.model === "gpt-6-luna" &&
          m.supportedReasoningEfforts.some((e) => e.reasoningEffort === "high"),
      )
    )
      throw new Error(
        "GPT-6 Luna con esfuerzo alto no está disponible en tu sesión de ChatGPT.",
      );
  }
  async requireExecutionReady(platform = process.platform) {
    if (platform !== "win32") return;
    const readiness = await this.request<{ status: string }>(
      "windowsSandbox/readiness",
    );
    if (readiness.status !== "ready")
      throw new Error(
        "Codex tiene sesión de ChatGPT, pero su entorno de ejecución de Windows no está listo (" +
          readiness.status +
          "). Completa la configuración o actualización del entorno en la aplicación Codex. Las tareas esperarán sin ejecutarse.",
      );
  }
  async execute(
    prompt: string,
    cwd: string,
    readOnly: boolean,
    signal: AbortSignal,
    onThread: (id: string) => Promise<void>,
    authorization?: { version: number; digest: string },
    planning?: PlanningOptions,
  ): Promise<string> {
    if (planning && !readOnly)
      throw new Error("La planificación con Luna debe ser de solo lectura.");
    if (!readOnly && !authorization)
      throw new Error(
        "Una tarea de implementación requiere la versión aprobada por el propietario.",
      );
    await this.initialize();
    await this.account();
    if (!readOnly) await this.requireExecutionReady();
    if (planning) await this.requireLunaHigh();
    const thread = await this.request<{ thread: { id: string } }>(
      planning?.threadId ? "thread/resume" : "thread/start",
      {
        ...(planning?.threadId
          ? { threadId: planning.threadId, excludeTurns: true }
          : {}),
        cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        modelProvider: "openai",
        ...(planning ? { model: planning.model } : {}),
        sandbox: readOnly ? "read-only" : "workspace-write",
        ephemeral: false,
        config: {
          "shell_environment_policy.inherit": "core",
          "sandbox_workspace_write.writable_roots": [],
          "sandbox_workspace_write.network_access": false,
        },
        baseInstructions:
          planning?.instructions ??
          "Eres un agente de Daedalus. Cumple exclusivamente la tarea aprobada. Puedes delegar subagentes internos si la herramienta está disponible, limitados a esa tarea y al worktree autorizado. Coordina su trabajo, espera sus resultados y conserva las restricciones de permisos. Ningún subagente concede aprobaciones ni amplía el alcance. No hagas push ni despliegues. Las skills están subordinadas al alcance aprobado. Resume cambios y pruebas con evidencia.",
        developerInstructions: planning
          ? "Esta sesión solo conversa, critica y prepara propuestas. No implementes cambios, no uses herramientas ni delegues subagentes, no concedas aprobaciones. Devuelve el contrato JSON solicitado."
          : readOnly
            ? "Realiza una revisión independiente de solo lectura. Diferencia las pruebas observadas de las afirmaciones del ejecutor."
            : `El propietario ya aprobó el enfoque y la ejecución del plan v${authorization!.version}, digest ${authorization!.digest}. La aprobación pendiente mencionada en el borrador ya se obtuvo. Ejecuta únicamente la tarea asignada; no vuelvas a entregar un plan en lugar de implementarla. Daedalus creará los commits de integración locales al terminar; no hagas push. Si no puedes completar la tarea, devuelve status blocked o failed en tu resultado estructurado. No declares completed si solo has descrito pasos o si las verificaciones fallan.`,
      },
    ).catch((error: unknown) => {
      if (
        planning?.threadId &&
        error instanceof Error &&
        error.message.includes("active writer")
      )
        throw new Error(
          "Otro proceso de Codex tiene abierta esta conversación. Libérala allí y vuelve a enviar tu petición. Daedalus conserva el mismo chat y no crea uno duplicado.",
        );
      throw error;
    });
    const threadId = thread.thread.id;
    if (planning?.threadId && threadId !== planning.threadId)
      throw new Error("Codex devolvió otra conversación al reanudar la planificación.");
    await onThread(threadId);
    return new Promise<string>((resolve, reject) => {
      let output = "";
      let lastMessage = "";
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.listeners.delete(listener);
        signal.removeEventListener("abort", abort);
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(lastMessage || output);
      };
      const listener = (m: RpcMessage) => {
        const p = m.params ?? {};
        if (p.threadId && p.threadId !== threadId) return;
        if (m.method === "item/agentMessage/delta" && typeof p.delta === "string")
          output += p.delta;
        if (m.method === "item/completed") {
          const item = p.item as { type?: string; text?: string } | undefined;
          if (item?.type === "agentMessage" && item.text) lastMessage = item.text;
          if (item?.type === "agentMessage" && item.text && !output.includes(item.text))
            output += "\n" + item.text;
        }
        if (m.method === "turn/completed") {
          const turn = p.turn as {
            status?: string;
            error?: { message?: string };
          };
          done(
            turn?.status === "completed"
              ? undefined
              : new Error(
                  turn?.error?.message ?? `Turno ${turn?.status ?? "interrumpido"}`,
                ),
          );
        }
        if (m.method === "transport/closed")
          done(
            new Error(
              "Se perdió la conexión con Codex; la ejecución requiere reconciliación.",
            ),
          );
      };
      const abort = () => {
        void this.request("turn/interrupt", {
          threadId,
          turnId: activeTurn,
        }).catch(() => {});
        done(new Error("Cancelado por el usuario."));
      };
      let activeTurn = "";
      const timer = setTimeout(
        () => {
          void this.request("turn/interrupt", {
            threadId,
            turnId: activeTurn,
          }).catch(() => {});
          done(new Error("Se alcanzó el límite de 45 minutos del turno."));
        },
        45 * 60 * 1000,
      );
      this.listeners.add(listener);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      void this.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        ...(planning
          ? {
              model: planning.model,
              effort: planning.effort,
              outputSchema: planning.schema,
            }
          : readOnly
            ? {}
            : { outputSchema: outcomeJsonSchema }),
      })
        .then((r) => {
          activeTurn = r.turn.id;
          if (signal.aborted) abort();
        })
        .catch((e) => done(e));
    });
  }
  close() {
    this.process.kill();
  }
}
