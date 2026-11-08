import { expect, it } from "vitest";
import { Engine } from "../src/shared/engine";
import { emptyWorkspace } from "../src/shared/model";
import { Service } from "../src/server/service";
import {
  prepareRepositoryRelease,
  reportRelease,
  approveRelease,
  releaseFingerprint,
  assertReleaseConnector,
} from "../src/server/releases";

const ci = { role: "ci", id: "ci" } as const;
const input = {
  repository: "JhinPablo/DaedalusMCP" as const,
  branch: "staging" as const,
  commit: "a".repeat(40),
  baseCommit: "b".repeat(40),
  tree: "c".repeat(40),
  ciRunId: "12",
};
const evidence = {
  ...input,
  artifactDigest: "d".repeat(64),
  artifactId: "34",
  checks: "passed" as const,
  previewUrl: "https://staging.workers.dev",
};
it("lets the scoped publisher discover candidates but never approve them", async () => {
  const state = emptyWorkspace(),
    e = new Engine(state);
  const candidate = prepareRepositoryRelease(e, ci, input, "staging");
  const service = new Service(
    { read: () => state, write: () => {} },
    { put: async () => {}, get: async () => null },
  );
  const publisher = { role: "publisher", id: "bootstrap-publisher" } as const;
  const list = await service.handle(
    new Request("https://test/api/releases"),
    publisher,
  );
  expect(list.status).toBe(200);
  expect((await list.json())[0].id).toBe(candidate.id);
  expect(
    (
      await service.handle(new Request("https://test/api/releases"), {
        role: "publisher",
        id: "other",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await service.handle(
        new Request(`https://test/api/releases/${candidate.id}/approve`, {
          method: "POST",
          body: JSON.stringify({ fingerprint: releaseFingerprint(candidate) }),
        }),
        publisher,
      )
    ).status,
  ).toBe(403);
});
it("previews committed repository changes without inventing chats or human approvals", () => {
  const state = emptyWorkspace(),
    e = new Engine(state);
  expect(() => prepareRepositoryRelease(e, ci, input, "production")).toThrow("Solo CI");
  expect(() =>
    prepareRepositoryRelease(
      e,
      { role: "connector", id: "connector" },
      input,
      "staging",
    ),
  ).toThrow("Solo CI");
  const r = prepareRepositoryRelease(e, ci, input, "staging");
  expect(r.status).toBe("testing");
  expect(state.sessions).toHaveLength(0);
  expect(() =>
    approveRelease(e, { role: "owner", id: "human" }, r.id, releaseFingerprint(r)),
  ).toThrow("pruebas");
  reportRelease(e, ci, r.id, evidence, evidence.previewUrl);
  expect(r.status).toBe("ready");
  expect(() => approveRelease(e, ci, r.id, releaseFingerprint(r))).toThrow();
  approveRelease(e, { role: "owner", id: "human" }, r.id, releaseFingerprint(r));
  expect(r.status).toBe("approved");
  assertReleaseConnector(state, { role: "publisher", id: "bootstrap-publisher" }, r);
  expect(() => assertReleaseConnector(state, { role: "mcp", id: "mcp" }, r)).toThrow();
});
it("invalidates approvals when staging changes and refuses replacement of uncertain publication", () => {
  const state = emptyWorkspace(),
    e = new Engine(state);
  const old = prepareRepositoryRelease(e, ci, input, "staging");
  reportRelease(e, ci, old.id, evidence, evidence.previewUrl);
  const fingerprint = releaseFingerprint(old);
  approveRelease(e, { role: "owner", id: "human" }, old.id, fingerprint);
  const next = prepareRepositoryRelease(
    e,
    ci,
    { ...input, commit: "e".repeat(40) },
    "staging",
  );
  expect(old.status).toBe("superseded");
  expect(old.approval).toBeUndefined();
  expect(() =>
    approveRelease(e, { role: "owner", id: "human" }, old.id, fingerprint),
  ).toThrow();
  next.status = "uncertain";
  expect(() => prepareRepositoryRelease(e, ci, input, "staging")).toThrow("Reconcilia");
});
