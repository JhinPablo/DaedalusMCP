import { proposalInput, type Proposal } from "../shared/model";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
export const plannerReply = z.object({
  kind: z.enum(["message", "proposal"]),
  message: z.string().min(1).max(30000),
  proposal: proposalInput.optional(),
});

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
  constructor(
    private url: string,
    private modelId: string,
    private statusFile?: string,
  ) {}
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
    if (!/^deepseek[\w.-]*-free$/.test(this.modelId))
      throw new Error("Selecciona un identificador DeepSeek gratuito explícito.");
    if (this.statusFile) {
      try {
        const saved = JSON.parse(await readFile(this.statusFile, "utf8"));
        if (
          saved.url === this.url &&
          saved.model === this.modelId &&
          Number.isFinite(saved.until) &&
          saved.until > this.blockedUntil
        ) {
          this.blockedUntil = saved.until;
          this.blockReason = String(saved.reason);
        }
      } catch {
        /* No previous provider restriction. */
      }
    }
    if (Date.now() < this.blockedUntil) throw new Error(this.blockReason);
    const providers = await this.call<{
      providers: Array<{
        id: string;
        models: Record<string, { cost?: { input: number; output: number } }>;
      }>;
    }>("/config/providers");
    const model = providers.providers.find((p) => p.id === "opencode")?.models[
      this.modelId
    ];
    if (!model || !model.cost || model.cost.input !== 0 || model.cost.output !== 0)
      throw new Error(
        "DeepSeek gratuito no está disponible con coste cero en OpenCode. No se usará otro modelo.",
      );
    return true;
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
          if (
            event.type === "session.status" &&
            status?.action?.reason === "free_tier_limit"
          ) {
            this.blockedUntil =
              Number.isFinite(status.next) && status.next > Date.now()
                ? status.next
                : Date.now() + 60000;
            this.blockReason =
              "DeepSeek V4.1 Flash Free: límite gratuito alcanzado en OpenCode. Planeación pausada hasta " +
              new Date(this.blockedUntil).toISOString() +
              ". No se usará un modelo de pago.";
            if (this.statusFile)
              await writeFile(
                this.statusFile,
                JSON.stringify({
                  url: this.url,
                  model: this.modelId,
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
  async plan(
    prompt: string,
    directory: string,
    signal: AbortSignal,
    onSession: (id: string) => Promise<void>,
  ): Promise<{ proposal?: Proposal; reply?: string; output: string }> {
    await this.available();
    const monitor = new AbortController();
    signal = AbortSignal.any([signal, monitor.signal, AbortSignal.timeout(180000)]);
    const query = "?directory=" + encodeURIComponent(directory);
    const session = await this.call<{ id: string }>(
      "/session" + query,
      {
        title: "Daedalus · planeación",
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
          model: { providerID: "opencode", modelID: this.modelId },
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
          system:
            "Eres el agente conversacional y planificador de Daedalus. Responde en español. Para una pregunta, un saludo o si falta una decisión importante, devuelve kind=message, message con tu respuesta o una sola pregunta útil y omite por completo el campo proposal. No inventes un plan para un saludo. Si el usuario pide una propuesta y el objetivo ya es concreto y verificable, devuelve kind=proposal con al menos dos alternativas, crítica, recomendación y un plan ejecutable; no hagas preguntas innecesarias. TU sesión no implementa código, ejecuta herramientas ni aprueba ejecución. El campo proposal.prompt es una instrucción imperativa que Codex ejecutará DESPUÉS de la aprobación humana: debe ordenar implementar y verificar, no esperar otra aprobación ni volver a planear. El conector realiza los commits locales de integración; no los prohíbas como criterio global. Cada tarea tiene áreas relativas al proyecto, criterios verificables y dependencias sin ciclos. No inventes pruebas realizadas. Devuelve exclusivamente JSON válido con este esquema: " +
            JSON.stringify(z.toJSONSchema(plannerReply)),
          // Validate locally: OpenCode 1.19.5 can fail to hydrate stored JSON-schema class instances.
          parts: [{ type: "text", text: prompt }],
        },
        signal,
      );
      if (result.info.error)
        throw new Error(
          "OpenCode no pudo completar la planeación: " +
            JSON.stringify(result.info.error).slice(0, 1000),
        );
      const output = result.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
      return parsePlannerReply(output, result.info.structured);
    } catch (error) {
      if (monitor.signal.aborted) throw monitor.signal.reason;
      if (signal.aborted && signal.reason?.name === "TimeoutError")
        throw new Error(
          "OpenCode no respondió dentro del plazo. Comprueba la disponibilidad y el límite de DeepSeek gratuito. No se ha cambiado a un proveedor de pago.",
        );
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      monitor.abort();
      await events?.finished;
    }
  }
}
