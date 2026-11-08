import { afterEach, expect, it, vi } from "vitest";
import type { ReleaseCandidate } from "../src/shared/model";
const command = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => {}, { [promisify.custom]: command });
  return { execFile };
});
import { ensureRepositoryPr } from "../src/connector/publisher";
afterEach(() => command.mockReset());
const candidate = {
  kind: "repository",
  commit: "a".repeat(40),
  baseCommit: "b".repeat(40),
} as ReleaseCandidate;
it("opens a staging PR through the local publisher without granting approvals", async () => {
  command.mockImplementation(async (_cmd, args: string[]) => ({
    stdout:
      args[0] === "api"
        ? JSON.stringify({
            sha: args[1].endsWith("/main") ? candidate.baseCommit : candidate.commit,
          })
        : args[1] === "list"
          ? "[]"
          : "https://github.com/JhinPablo/DaedalusMCP/pull/5",
    stderr: "",
  }));
  await expect(
    ensureRepositoryPr("JhinPablo/DaedalusMCP", candidate, process.cwd()),
  ).resolves.toBe(true);
  expect(command).toHaveBeenCalledWith(
    "gh",
    expect.arrayContaining(["pr", "create", "--head", "staging", "--base", "main"]),
    expect.any(Object),
  );
  expect(command.mock.calls.every((call) => !call[1].includes("approve"))).toBe(true);
});
it("does not open a PR for an obsolete candidate", async () => {
  command.mockResolvedValue({
    stdout: JSON.stringify({ sha: "c".repeat(40) }),
    stderr: "",
  });
  await expect(
    ensureRepositoryPr("JhinPablo/DaedalusMCP", candidate, process.cwd()),
  ).resolves.toBe(false);
  expect(command).toHaveBeenCalledTimes(2);
  expect(command.mock.calls.every((call) => call[1][0] === "api")).toBe(true);
});
it("publishes an already merged exact main candidate without creating an empty PR", async () => {
  await expect(
    ensureRepositoryPr(
      "JhinPablo/DaedalusMCP",
      { ...candidate, commit: candidate.baseCommit },
      process.cwd(),
    ),
  ).resolves.toBe(true);
  expect(command).not.toHaveBeenCalled();
});
it("does not require the old staging base to authorize an approved rollback", async () => {
  await expect(
    ensureRepositoryPr(
      "JhinPablo/DaedalusMCP",
      {
        ...candidate,
        error: "rollback-requested",
      },
      process.cwd(),
    ),
  ).resolves.toBe(true);
  expect(command).not.toHaveBeenCalled();
});
