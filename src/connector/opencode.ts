import { proposalInput, type ModelOption, type Proposal } from "../shared/model";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { ExecutionOutcomeError } from "./outcome";
const reviewReply = z.object({
  verdict: z.enum(["pass", "changes_requested", "blocked"]),
  report: z.string().min(1).max(60000),
});
export const plannerReply = z.object({
  kind: z.enum(["message", "proposal"]),
  message: z.string().min(1).max(30000),
  proposal: proposalInput.optional(),
});

export function modelRef(value: string) {
  const separator = value.indexOf("/");
  if (separator > 0)
    return {
      providerID: value.slice(0, separator),
      modelID: value.slice(separator + 1),
      label: value,
    };
  return { providerID: "opencode", modelID: value, label: "opencode/" + value };
}

interface ProvidersResponse {
  providers: Array<{
    id: string;
    models: Record<
      string,
      {
        name?: string;
        variants?: Record<string, unknown>;
        cost?: { input: number; output: number };
      }
    >;
  }>;
}

export function deepseekOptions(providers: ProvidersResponse): ModelOption[] {
  const provider = providers.providers.find((p) => p.id === "opencode");
  if (!provider) return [];
  return Object.entries(provider.models)
    .filter(([id]) => /^deepseek/i.test(id) && !/free$/i.test(id))
    .map(([id, model]) => ({
      id,
      providerID: "opencode",
      name: model.name ?? id,
      variants: Object.keys(model.variants ?? {}),
      cost: model.cost,
    }));
}

export function parsePlannerReply(output: string, structured?: unknown) {
  let data = structured;
  if (!data) {
    try {
      data = JSON.parse(output);
    } catch {
      const match = output.match(/^\s*```(?:json)?\s*([\s\S]*?)```\s*$/);
      if (!match) throw new Error("DeepSeek no devolvió una respuesta JSON válida.");
      data = JSON.parse(match[1]);
    }
  }
  const reply = plannerReply.parse(data);
  if (reply.kind === "proposal") {
    if (!reply.proposal)
      throw new Error("El planificador indicó una propuesta sin incluirla.");
    return { proposal: reply.proposal, output: output || reply.message };
  }
  return { reply: reply.message, output: output || reply.message };
}

export class OpenCodeClient {
  private blockedUntil = 0;
  private blockReason = "";
  private providerID: string;
  private modelID: string;
  constructor(
    private url: string,
    model: string,
    private statusFile?: string,
    private variant?: string,
  ) {
    const ref = modelRef(model);
    this.providerID = ref.providerID;
    this.modelID = ref.modelID;
  }
  setModel(model: string, variant?: string) {
    const ref = modelRef(model);
    this.providerID = ref.providerID;
    this.modelID = ref.modelID;
    this.variant = variant;
    this.blockedUntil = 0;
    this.blockReason = "";
  }
  async synchronizeCredential(provider: string, credential: Record<string, unknown>) {
    const response = await fetch(this.url + "/auth/" + encodeURIComponent(provider), {
      method: "PUT",
      headers: await this.headers(),
      body: JSON.stringify(credential),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(
        `OpenCode no pudo actualizar su credencial local (${response.status}).`,
      );
  }
  private async headers() {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.OPENCODE_SERVER_PASSWORD)
      headers.Authorization =
        "Basic " +
        Buffer.from(
          `${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`,
        ).toString("base64");
    return headers;
  }
  async call<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers = await this.headers();
    const res = await fetch(this.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(10000),
    });
    if (!res.ok)
      throw new Error(`OpenCode (${res.status}): ${(await res.text()).slice(0, 500)}`);
    return res.json() as Promise<T>;
  }
  async available() {
    if (!/^deepseek[\w.-]*$/i.test(this.modelID))
      throw new Error(
        "El planificador debe usar un modelo DeepSeek explícito de OpenCode Go.",
      );
    if (/free$/i.test(this.modelID))
      throw new Error(
        "El modelo seleccionado es gratuito. Configura un modelo DeepSeek de la suscripción OpenCode Go.",
      );
    let blockedUntil = this.blockedUntil;
    let blockReason = this.blockReason;
    if (this.statusFile) {
      try {
        const saved = JSON.parse(await readFile(this.statusFile, "utf8"));
        if (
          saved.url === this.url &&
          saved.model === this.providerID + "/" + this.modelID &&
          Number.isFinite(saved.until) &&
          saved.until > blockedUntil
        ) {
          blockedUntil = saved.until;
          blockReason = String(saved.reason);
        }
      } catch {
        /* No previous provider restriction. */
      }
    }
    if (Date.now() < blockedUntil) throw new Error(blockReason);
    const providers = await this.call<ProvidersResponse>("/config/providers");
    const provider = providers.providers.find((p) => p.id === this.providerID);
    const model = provider?.models[this.modelID];
    if (!model)
      throw new Error(
        `El modelo ${this.providerID}/${this.modelID} no está disponible en OpenCode. Inicia sesión en OpenCode Go o revisa opencodeModel.`,
      );
    if (this.providerID !== "opencode")
      throw new Error(
        "Selecciona un modelo del catálogo OpenCode Go configurado para este conector.",
      );
    if (this.variant && !Object.hasOwn(model.variants ?? {}, this.variant))
      throw new Error("La modalidad no está disponible para este modelo.");
    return deepseekOptions(providers);
  }
  private async watchFailures(sessionId: string, controller: AbortController) {
    const response = await fetch(this.url + "/event", {
      headers: await this.headers(),
      signal: controller.signal,
    });
    if (!response.ok || !response.body)
      throw new Error("No se pudo observar el estado de OpenCode.");
    const consume = async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body!) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.properties?.sessionID !== sessionId) continue;
          const status = event.properties.status;
          const reason = String(status?.action?.reason ?? "");
          if (
            event.type === "session.status" &&
            /free_tier_limit|limit|quota|exhaust/i.test(reason)
          ) {
            this.blockedUntil =
              Number.isFinite(status.next) && status.next > Date.now()
                ? status.next
                : Date.now() + 60000;
            this.blockReason =
              (reason === "free_tier_limit"
                ? "OpenCode: límite del modelo gratuito alcanzado."
                : "OpenCode Go: límite de la suscripción alcanzado.") +
              " Planeación pausada hasta " +
              new Date(this.blockedUntil).toISOString() +
              ".";
            if (this.statusFile)
              await writeFile(
                this.statusFile,
                JSON.stringify({
                  url: this.url,
                  model: this.providerID + "/" + this.modelID,
                  until: this.blockedUntil,
                  reason: this.blockReason,
                }),
              );
            controller.abort(new Error(this.blockReason));
            return;
          }
          if (event.type === "session.error") {
            controller.abort(
              new Error(
                "OpenCode: " + JSON.stringify(event.properties.error).slice(0, 1500),
              ),
            );
            return;
          }
        }
      }
      if (!controller.signal.aborted)
        throw new Error("Se interrumpió el canal de eventos de OpenCode.");
    };
    return {
      finished: consume().catch((error) => {
        if (!controller.signal.aborted) controller.abort(error);
      }),
    };
  }
  private async converse(
    title: string,
    system: string,
    prompt: string,
    directory: string,
    signal: AbortSignal,
    onSession: (id: string) => Promise<void>,
    sessionId?: string,
  ): Promise<{
    info: { structured?: unknown };
    parts: Array<{ type: string; text?: string }>;
  }> {
    await this.available();
    const monitor = new AbortController();
    signal = AbortSignal.any([signal, monitor.signal, AbortSignal.timeout(180000)]);
    const query = "?directory=" + encodeURIComponent(directory);
    const session = sessionId
      ? { id: sessionId }
      : await this.call<{ id: string }>(
          "/session" + query,
          {
            title,
            permission: [{ permission: "*", pattern: "*", action: "deny" }],
          },
          signal,
        );
    await onSession(session.id);
    const abort = () => {
      monitor.abort(signal.reason);
      void this.call("/session/" + session.id + "/abort" + query, {}).catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    let events: { finished: Promise<void> } | undefined;
    try {
      events = await this.watchFailures(session.id, monitor);
      const result = await this.call<{
        info: { structured?: unknown; error?: unknown };
        parts: Array<{ type: string; text?: string }>;
      }>(
        "/session/" + session.id + "/message" + query,
        {
          model: {
            providerID: this.providerID,
            modelID: this.modelID,
          },
          ...(this.variant ? { variant: this.variant } : {}),
          agent: "plan",
          tools: {
            bash: false,
            edit: false,
            write: false,
            patch: false,
            task: false,
            shell: false,
            subagent: false,
          },
          system,
          parts: [{ type: "text", text: prompt }],
        },
        signal,
      );
      if (result.info.error)
        throw new Error(
          "OpenCode no pudo completar el turno: " +
            JSON.stringify(result.info.error).slice(0, 1000),
        );
      return result;
    } catch (error) {
      if (monitor.signal.aborted) throw monitor.signal.reason;
      if (signal.aborted && signal.reason?.name === "TimeoutError")
        throw new Error(
          "OpenCode no respondió dentro del plazo. Comprueba la disponibilidad y el límite de la suscripción OpenCode Go.",
        );
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      monitor.abort();
      await events?.finished;
    }
  }
  async plan(
    prompt: string,
    directory: string,
    signal: AbortSignal,
    onSession: (id: string) => Promise<void>,
    sessionId?: string,
  ): Promise<{ proposal?: Proposal; reply?: string; output: string }> {
    const result = await this.converse(
      "Daedalus · planeación",
      "Eres el agente conversacional y planificador de Daedalus. Responde en español. Para una pregunta, un saludo o si falta una decisión importante, devuelve kind=message, message con tu respuesta o una sola pregunta útil y omite por completo el campo proposal. No inventes un plan para un saludo. Si el usuario pide una propuesta y el objetivo ya es concreto y verificable, devuelve kind=proposal con al menos dos alternativas, crítica, recomendación y un plan ejecutable; no hagas preguntas innecesarias. TU sesión no implementa código, ejecuta herramientas ni aprueba ejecución. El campo proposal.prompt es una instrucción imperativa que Codex ejecutará DESPUÉS de la aprobación humana: debe ordenar implementar y verificar, no esperar otra aprobación ni volver a planear. El conector realiza los commits locales de integración; no los prohíbas como criterio global. Cada tarea tiene áreas relativas al proyecto, criterios verificables y dependencias sin ciclos. No inventes pruebas realizadas. Devuelve exclusivamente JSON válido con este esquema: " +
        JSON.stringify(z.toJSONSchema(plannerReply)),
      prompt,
      directory,
      signal,
      onSession,
      sessionId,
    );
    const output = result.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    // Validate locally: OpenCode 1.19.5 can fail to hydrate stored JSON-schema class instances.
    return parsePlannerReply(output, result.info.structured);
  }
  async review(
    prompt: string,
    directory: string,
    signal: AbortSignal,
    onSession: (id: string) => Promise<void>,
    sessionId?: string,
  ): Promise<string> {
    const result = await this.converse(
      "Daedalus · revisión final",
      "Eres el revisor final independiente de Daedalus. Responde en español. Evalúa el plan aprobado, los resultados y el diff integrado. Distingue las pruebas del ejecutor de la evidencia que puedes verificar en el contexto. Un diff truncado impide confirmar áreas omitidas. No ejecutes herramientas, no modifiques archivos ni concedas aprobaciones. Devuelve únicamente JSON con verdict=pass si se cumplen todos los criterios y no hay hallazgos bloqueantes, changes_requested si requiere correcciones o blocked si faltan pruebas o contexto para emitir un veredicto. El campo report contiene un informe Markdown con hallazgos, pruebas verificadas, limitaciones y veredicto. Esquema: " +
        JSON.stringify(z.toJSONSchema(reviewReply)),
      prompt,
      directory,
      signal,
      onSession,
      sessionId,
    );
    const output = result.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
    const text = output.replace(/^\s*```(?:json)?\s*([\s\S]*?)```\s*$/, "$1");
    const review = reviewReply.parse(JSON.parse(text));
    if (review.verdict !== "pass") throw new ExecutionOutcomeError(review.report);
    return review.report;
  }
}
