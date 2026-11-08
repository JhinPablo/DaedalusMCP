import { z } from "zod";
import { Engine, DomainError, digest } from "../shared/engine";
import type { Principal, ReleaseCandidate, Workspace } from "../shared/model";
const sha = z.string().regex(/^[a-f0-9]{40}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const releaseInput = z.object({
  sessionId: z.string().uuid(),
  repository: z.literal("JhinPablo/DaedalusMCP"),
  branch: z.string().regex(/^daedalus\/[a-zA-Z0-9_-]+$/),
  commit: sha,
  baseCommit: sha,
  tree: sha,
  prNumber: z.number().int().positive(),
  prUrl: z.string().regex(/^https:\/\/github\.com\/JhinPablo\/DaedalusMCP\/pull\/\d+$/),
});
export const releaseResult = z.object({
  commit: sha,
  baseCommit: sha,
  tree: sha,
  artifactDigest: hash,
  artifactId: z.string().regex(/^\d+$/),
  ciRunId: z.string().regex(/^\d+$/),
  checks: z.enum(["passed", "failed"]),
  previewUrl: z.string().url(),
  error: z.string().max(2000).optional(),
});
export function releaseFingerprint(r: ReleaseCandidate) {
  return digest(
    JSON.stringify({
      commit: r.commit,
      baseCommit: r.baseCommit,
      tree: r.tree,
      artifactDigest: r.artifactDigest,
      artifactId: r.artifactId,
      ciRunId: r.ciRunId,
    }),
  );
}
export function assertReleaseConnector(
  state: Workspace,
  p: Principal,
  r: ReleaseCandidate,
) {
  if (
    p.role !== "connector" ||
    !state.projects.some(
      (project) =>
        project.id === state.sessions.find((s) => s.id === r.sessionId)?.projectId &&
        project.connectorId === p.id,
    )
  )
    throw new DomainError(403, "Publicación de otro conector.");
}
export function prepareRelease(
  e: Engine,
  p: Principal,
  input: z.infer<typeof releaseInput>,
) {
  const s = e.session(input.sessionId);
  if (p.role !== "owner" && p.role !== "connector")
    throw new DomainError(403, "No puedes preparar publicaciones.");
  if (
    p.role === "connector" &&
    !e.state.projects.some(
      (project) => project.id === s.projectId && project.connectorId === p.id,
    )
  )
    throw new DomainError(403, "Proyecto de otro conector.");
  if (s.phase !== "completed" || !e.approved(s, "execution"))
    throw new DomainError(
      409,
      "La publicación requiere un plan aprobado y su revisión final completada.",
    );
  const existing = e.state.releases.find(
    (r) => r.commit === input.commit && r.sessionId === s.id,
  );
  if (existing) return existing;
  if (
    e.state.releases.some((r) => r.status === "publishing" || r.status === "uncertain")
  )
    throw new DomainError(
      409,
      "Reconcilia la publicación anterior antes de preparar otra.",
    );
  for (const old of e.state.releases.filter(
    (r) => !["published", "rolled_back", "superseded", "failed"].includes(r.status),
  )) {
    old.status = "superseded";
    old.approval = undefined;
    old.updatedAt = new Date().toISOString();
  }
  const time = new Date().toISOString();
  const release: ReleaseCandidate = {
    ...input,
    id: crypto.randomUUID(),
    checks: "pending",
    status: "testing",
    createdAt: time,
    updatedAt: time,
  };
  e.state.releases.push(release);
  e.event("release.prepared", "Candidato preparado para pruebas.", s.id);
  return release;
}
export function reportRelease(
  e: Engine,
  p: Principal,
  id: string,
  data: z.infer<typeof releaseResult>,
  stagingUrl?: string,
) {
  if (p.role !== "ci") throw new DomainError(403, "Se requiere una credencial de CI.");
  const r = e.state.releases.find((r) => r.id === id);
  if (!r) throw new DomainError(404, "Publicación no encontrada.");
  if (
    r.status === "superseded" ||
    r.status === "published" ||
    r.status === "rolled_back" ||
    r.status === "publishing"
  )
    throw new DomainError(409, "El candidato ya no admite resultados de pruebas.");
  if (
    data.commit !== r.commit ||
    data.baseCommit !== r.baseCommit ||
    data.tree !== r.tree
  )
    throw new DomainError(409, "El código o la base del candidato cambiaron.");
  if (stagingUrl && new URL(data.previewUrl).origin !== new URL(stagingUrl).origin)
    throw new DomainError(400, "Vista previa de otro entorno.");
  const previous = releaseFingerprint(r);
  Object.assign(r, data);
  const changed = previous !== releaseFingerprint(r);
  if (changed || data.checks !== "passed") r.approval = undefined;
  r.status = data.checks === "passed" ? (r.approval ? "approved" : "ready") : "failed";
  r.updatedAt = new Date().toISOString();
  e.event(
    "release.checked",
    "Resultados de pruebas de publicación registrados.",
    r.sessionId,
  );
  return r;
}
export function approveRelease(
  e: Engine,
  p: Principal,
  id: string,
  fingerprint: string,
) {
  e.owner(p);
  const r = e.state.releases.find((r) => r.id === id);
  if (!r) throw new DomainError(404, "Publicación no encontrada.");
  if (releaseFingerprint(r) !== fingerprint)
    throw new DomainError(409, "El candidato cambió. Revisa de nuevo las pruebas.");
  if (r.status === "approved" && r.approval?.fingerprint === fingerprint) return r;
  if (
    r.status !== "ready" ||
    r.checks !== "passed" ||
    !r.artifactDigest ||
    !r.previewUrl
  )
    throw new DomainError(409, "La vista previa y las pruebas deben estar listas.");
  r.approval = { ownerId: p.id, at: new Date().toISOString(), fingerprint };
  r.status = "approved";
  r.updatedAt = new Date().toISOString();
  e.event(
    "release.approved",
    "El propietario aprobó publicar el candidato exacto.",
    r.sessionId,
  );
  return r;
}
