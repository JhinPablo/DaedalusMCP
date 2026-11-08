import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRun } from "../shared/model";

export interface PlanningJournal {
  run: AgentRun;
  stage: "started" | "finished";
  outcome?: { status?: unknown };
}

export function previousPlanningSession(
  journals: PlanningJournal[],
  run: AgentRun,
  model: string,
): string | undefined {
  const previous = journals
    .filter(
      (j) =>
        j.run.id !== run.id &&
        j.run.sessionId === run.sessionId &&
        j.run.projectId === run.projectId &&
        j.run.kind === "planning" &&
        j.run.model === model &&
        j.run.externalSessionId,
    )
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))[0];
  if (
    previous &&
    (previous.stage !== "finished" || previous.outcome?.status === "uncertain")
  )
    throw new Error(
      "La conversación de planificación requiere reconciliación antes de continuar.",
    );
  return previous?.run.externalSessionId;
}

export async function loadPlanningSession(root: string, run: AgentRun, model: string) {
  const journals: PlanningJournal[] = [];
  for (const file of await readdir(root)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    // Corrupt execution evidence must not silently create a replacement conversation.
    journals.push(JSON.parse(await readFile(path.join(root, file), "utf8")));
  }
  return previousPlanningSession(journals, run, model);
}
