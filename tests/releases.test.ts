import { expect, it } from "vitest";
import { Engine } from "../src/shared/engine";
import {
  emptyWorkspace,
  type Principal,
  type ReleaseCandidate,
} from "../src/shared/model";
import {
  approveRelease,
  releaseFingerprint,
  reportRelease,
} from "../src/server/releases";
import { Service } from "../src/server/service";
const owner: Principal = { role: "owner", id: "human" };
function setup() {
  const state = emptyWorkspace();
  const time = new Date().toISOString();
  const release: ReleaseCandidate = {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    repository: "JhinPablo/DaedalusMCP",
    branch: "daedalus/review",
    commit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    tree: "c".repeat(40),
    artifactDigest: "d".repeat(64),
    artifactId: "1",
    ciRunId: "2",
    checks: "passed",
    previewUrl: "https://staging.workers.dev",
    status: "ready",
    createdAt: time,
    updatedAt: time,
  };
  state.releases.push(release);
  return { state, release, e: new Engine(state) };
}
it.each(["connector", "ci", "mcp"] as const)(
  "%s no puede aprobar una publicación",
  (role) => {
    const { release, e } = setup();
    expect(() =>
      approveRelease(
        e,
        { role, id: "machine" },
        release.id,
        releaseFingerprint(release),
      ),
    ).toThrow("Solo el propietario");
  },
);
it("la aprobación es idempotente y se vincula al artefacto exacto", () => {
  const { release, e } = setup();
  const fingerprint = releaseFingerprint(release);
  approveRelease(e, owner, release.id, fingerprint);
  approveRelease(e, owner, release.id, fingerprint);
  expect(release.status).toBe("approved");
  release.artifactDigest = "e".repeat(64);
  expect(() => approveRelease(e, owner, release.id, fingerprint)).toThrow("cambió");
});
it("cambiar el artefacto invalida la aprobación y otro código no puede reportar pruebas", () => {
  const { release, e } = setup();
  approveRelease(e, owner, release.id, releaseFingerprint(release));
  const data = {
    commit: release.commit,
    baseCommit: release.baseCommit,
    tree: release.tree,
    artifactDigest: "e".repeat(64),
    artifactId: "3",
    ciRunId: "4",
    checks: "passed" as const,
    previewUrl: "https://staging.workers.dev",
  };
  reportRelease(
    e,
    { role: "ci", id: "ci" },
    release.id,
    data,
    "https://staging.workers.dev",
  );
  expect(release.approval).toBeUndefined();
  expect(release.status).toBe("ready");
  expect(() =>
    reportRelease(e, { role: "ci", id: "ci" }, release.id, {
      ...data,
      commit: "f".repeat(40),
    }),
  ).toThrow("cambiaron");
});
it("las consultas y transiciones sin cambios no escriben ni notifican", async () => {
  let state = emptyWorkspace(),
    writes = 0,
    notifications = 0;
  const service = new Service(
    {
      read: () => state,
      write: (s) => {
        state = s;
        writes++;
      },
    },
    { put: async () => {}, get: async () => null },
    () => notifications++,
  );
  for (let i = 0; i < 50; i++) {
    await service.handle(new Request("http://local/api/state"), owner);
    service.mutate(() => {});
  }
  expect(writes).toBe(0);
  expect(notifications).toBe(0);
});
it("una credencial CI no obtiene conversaciones ni puede conceder aprobaciones", async () => {
  const { state, release } = setup();
  const service = new Service(
    { read: () => state, write: () => {} },
    { put: async () => {}, get: async () => null },
  );
  expect(
    (
      await service.handle(new Request("http://local/api/state"), {
        role: "ci",
        id: "ci",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await service.handle(
        new Request(`http://local/api/releases/${release.id}/approve`, {
          method: "POST",
          body: JSON.stringify({ fingerprint: releaseFingerprint(release) }),
        }),
        { role: "ci", id: "ci" },
      )
    ).status,
  ).toBe(403);
});
