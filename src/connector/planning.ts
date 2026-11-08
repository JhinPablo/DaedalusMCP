import { z } from "zod";
import { CodexClient } from "./codex";
import { plannerReply, parsePlannerReply } from "./opencode";
import type { Proposal } from "../shared/model";

export type PlanningResult = { proposal?: Proposal; reply?: string; output: string };
export const lunaModel = "gpt-6-luna" as const;
export const lunaEffort = "high" as const;

export async function planWithFallback(
  deepseek: () => Promise<PlanningResult>,
  luna: (() => Promise<PlanningResult>) | undefined,
  signal: AbortSignal,
  onFallback: (reason: string) => Promise<void>,
): Promise<PlanningResult> {
  try {
    return await deepseek();
  } catch (error) {
    if (signal.aborted || !luna) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    await onFallback(reason);
    if (signal.aborted) throw signal.reason;
    try {
      return await luna();
    } catch (fallbackError) {
      throw new Error(
        "DeepSeek falló: " +
          reason +
          "\nLuna alto también falló: " +
          (fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)),
      );
    }
  }
}

export async function planWithLuna(
  client: CodexClient,
  prompt: string,
  directory: string,
  signal: AbortSignal,
  onSession: (id: string) => Promise<void>,
): Promise<PlanningResult> {
  const output = await client.execute(
    prompt,
    directory,
    true,
    signal,
    onSession,
    undefined,
    {
      model: lunaModel,
      effort: lunaEffort,
      instructions:
        "Eres el agente conversacional y planificador de Daedalus. Responde en español. Para preguntas, saludos o decisiones importantes pendientes, devuelve kind=message y message con una respuesta o pregunta útil; proposal debe ser null. Para solicitudes concretas devuelve kind=proposal, message y proposal con objetivo, alcance, al menos dos alternativas con ventajas y costes, recomendación, crítica, prompt exacto de implementación y tareas verificables. No inventes pruebas realizadas. Las tareas deben tener áreas relativas, dependencias sin ciclos y solo skills del catálogo suministrado. El prompt debe ordenar implementar y verificar DESPUÉS de la aprobación humana; no volver a planear ni pedir otra aprobación. El conector crea los commits locales. No implementes ni ejecutes herramientas. Ningún agente puede aprobar su propio trabajo. Devuelve únicamente el JSON indicado.",
      // Codex strict structured output requires every property; null means no proposal.
      schema: z.toJSONSchema(
        plannerReply.extend({
          proposal: plannerReply.shape.proposal.unwrap().nullable(),
        }),
      ),
    },
  );
  const parsed = JSON.parse(output);
  if (parsed.proposal === null) delete parsed.proposal;
  return parsePlannerReply(output, parsed);
}
