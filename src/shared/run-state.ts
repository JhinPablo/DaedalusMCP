import type { AgentRun } from "./model";
export function canRetryPreflight(run: AgentRun) {
  return (
    run.kind === "task" &&
    run.status === "failed" &&
    !run.externalSessionId &&
    !run.worktree &&
    !run.branch &&
    !run.baseCommit &&
    (run.preflightFailure === true ||
      run.error ===
        "Las skills seleccionadas exceden el contexto permitido. Reduce la selección.")
  );
}
