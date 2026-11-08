import type { ReleaseCandidate } from "../shared/model";
import { ExternalLink, ShieldCheck, RotateCcw } from "lucide-react";
const labels: Record<ReleaseCandidate["status"], string> = {
  preparing: "Preparando",
  testing: "En pruebas",
  ready: "Lista para revisar",
  approved: "Publicación aprobada",
  publishing: "Publicando",
  published: "Publicada",
  superseded: "Reemplazada",
  failed: "Fallida",
  uncertain: "Requiere reconciliación",
  rolled_back: "Revertida",
};
export function Releases({
  releases,
  busy,
  act,
}: {
  releases: ReleaseCandidate[];
  busy: boolean;
  act: (path: string, body?: unknown) => Promise<unknown>;
}) {
  return (
    <section className="content-page releases-page">
      <div className="section-intro">
        <h2>Del cambio probado a tu versión estable</h2>
        <p>
          Revisa el PR, sus pruebas y la vista previa. Tu aprobación publica ese
          candidato exacto.
        </p>
      </div>
      {!releases.length && (
        <div className="empty-block">
          <strong>Todavía no hay candidatos</strong>
          <p>
            Tras completar las tareas y su revisión, Daedalus prepara el PR y las
            pruebas del cambio.
          </p>
        </div>
      )}
      {releases
        .slice()
        .reverse()
        .map((r) => (
          <article className="run-card" key={r.id}>
            <div className="run-heading">
              <div>
                <h2>{r.repository}</h2>
                <span>
                  Commit <code>{r.commit.slice(0, 8)}</code> · base{" "}
                  <code>{r.baseCommit.slice(0, 8)}</code>
                </span>
              </div>
              <span className={"phase phase-" + r.status}>{labels[r.status]}</span>
            </div>
            <p>
              Pruebas:{" "}
              {r.checks === "passed"
                ? "correctas"
                : r.checks === "failed"
                  ? "fallidas"
                  : "pendientes"}
            </p>
            <div className="button-row">
              {r.prUrl && (
                <a href={r.prUrl} target="_blank" rel="noreferrer">
                  Revisar PR #{r.prNumber} <ExternalLink size={13} />
                </a>
              )}
              {r.previewUrl && (
                <a href={r.previewUrl} target="_blank" rel="noreferrer">
                  Abrir vista previa <ExternalLink size={13} />
                </a>
              )}
            </div>
            {r.artifactDigest && (
              <p className="break">
                Artefacto <code>{r.artifactDigest.slice(0, 16)}</code>
              </p>
            )}
            {r.error && <p className="run-error">{r.error}</p>}
            {r.status === "ready" && (
              <button
                className="primary"
                disabled={busy || !r.fingerprint}
                onClick={() =>
                  void act(`/releases/${r.id}/approve`, {
                    fingerprint: r.fingerprint,
                  }).catch(() => {})
                }
              >
                <ShieldCheck size={15} /> Aprobar publicación
              </button>
            )}
            {r.status === "approved" && (
              <p>
                El publicador ejecutará la publicación cuando tu conector esté
                disponible y haya terminado sus tareas.
              </p>
            )}
            {r.status === "uncertain" && (
              <p>
                Comprueba el workflow y la versión desplegada antes de reintentar.
                Daedalus conserva este intento y no lo repite automáticamente.
              </p>
            )}
            {r.status === "published" && r.previousVersion && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(`/releases/${r.id}/rollback`, {}).catch(() => {})
                }
              >
                <RotateCcw size={15} /> Revertir a la versión anterior
              </button>
            )}
          </article>
        ))}
    </section>
  );
}
