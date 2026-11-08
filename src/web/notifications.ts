import type { Workspace } from "../shared/model";

export interface Notice {
  id: string;
  title: string;
  body: string;
  sessionId?: string;
}
export function workspaceNotices(state: Workspace): Notice[] {
  const notices: Notice[] = state.permissions
    .filter((p) => !p.decision)
    .map((p) => ({
      id: "permission:" + p.id,
      title: "Daedalus necesita tu permiso",
      body: "Abre el chat para revisar la operación y decidir.",
      sessionId: state.runs.find((r) => r.id === p.runId)?.sessionId,
    }));
  for (const run of state.runs) {
    if (!["completed", "failed", "uncertain"].includes(run.status)) continue;
    notices.push({
      id: `run:${run.id}:${run.status}`,
      sessionId: run.sessionId,
      title:
        run.status === "completed"
          ? run.kind === "planning"
            ? "Tu propuesta está lista"
            : run.kind === "review"
              ? "Revisión final terminada"
              : "Una tarea ha terminado"
          : "Una ejecución necesita atención",
      body:
        run.status === "completed"
          ? "Consulta el resultado en el chat de Daedalus."
          : "Abre Daedalus para ver el motivo; no se ha reintentado automáticamente.",
    });
  }
  for (const release of state.releases ?? []) {
    if (!["ready", "published", "failed", "superseded"].includes(release.status))
      continue;
    notices.push({
      id: `release:${release.id}:${release.status}`,
      sessionId: release.sessionId,
      title:
        release.status === "ready"
          ? "Tu vista previa está lista"
          : release.status === "published"
            ? "Cambio publicado"
            : "La vista previa necesita atención",
      body:
        release.status === "ready"
          ? "Abre el chat para probarla y revisar los cambios."
          : "Consulta el estado de la publicación en Daedalus.",
    });
  }
  return notices;
}
