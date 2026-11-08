import { expect, it, vi } from "vitest";
import {
  isRunJournalFile,
  previousPlanningSession,
  type PlanningJournal,
} from "../src/connector/planning-session";
it("excludes imported planning references from execution reconciliation", () => {
  expect(isRunJournalFile("planning-history.json")).toBe(false);
  expect(isRunJournalFile("settings.json")).toBe(false);
  expect(isRunJournalFile("29850e6d-a49b-46df-a78c-1011aa7093d2.json")).toBe(true);
});
import { CodexClient } from "../src/connector/codex";
import { planWithLuna } from "../src/connector/planning";
import type { AgentRun } from "../src/shared/model";

const run = {
  id: "new",
  sessionId: "chat",
  projectId: "project",
  kind: "planning",
  createdAt: "2026-11-08T12:00:00Z",
} as AgentRun;
const journal = (overrides: Partial<AgentRun> = {}): PlanningJournal => ({
  run: {
    ...run,
    id: "old",
    model: "GPT-6 Luna · alto",
    externalSessionId: "thread-1",
    createdAt: "2026-11-08T11:00:00Z",
    ...overrides,
  },
  stage: "finished",
  outcome: { status: "completed" },
});
it("continues only the same chat, project and provider after a connector restart", () => {
  const data = [
    journal(),
    journal({ sessionId: "other", externalSessionId: "other-chat" }),
    journal({ projectId: "other", externalSessionId: "other-project" }),
  ];
  expect(previousPlanningSession(data, run, "GPT-6 Luna · alto")).toBe("thread-1");
  expect(
    previousPlanningSession(
      data,
      { ...run, sessionId: "new-chat" },
      "GPT-6 Luna · alto",
    ),
  ).toBeUndefined();
  expect(
    previousPlanningSession(data, run, "OpenCode · DeepSeek V4.1 Flash Free"),
  ).toBeUndefined();
});
it("does not continue or replace a conversation with an uncertain turn", () => {
  expect(() =>
    previousPlanningSession(
      [{ ...journal(), stage: "started" }],
      run,
      "GPT-6 Luna · alto",
    ),
  ).toThrow("reconciliación");
  expect(() =>
    previousPlanningSession(
      [{ ...journal(), outcome: { status: "uncertain" } }],
      run,
      "GPT-6 Luna · alto",
    ),
  ).toThrow("reconciliación");
});
it("passes the persistent thread to Luna and never falls back to creating a replacement thread on resume failure", async () => {
  const client = Object.create(CodexClient.prototype) as CodexClient;
  client.initialize = vi.fn().mockResolvedValue(undefined);
  client.account = vi.fn().mockResolvedValue({ type: "chatgpt" });
  client.requireLunaHigh = vi.fn().mockResolvedValue(undefined);
  const request = vi.fn().mockRejectedValue(new Error("Resume unavailable"));
  client.request = request;
  await expect(
    planWithLuna(
      client,
      "Continue",
      process.cwd(),
      new AbortController().signal,
      async () => {},
      "thread-1",
    ),
  ).rejects.toThrow("Resume unavailable");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    "thread/resume",
    expect.objectContaining({
      threadId: "thread-1",
      sandbox: "read-only",
      model: "gpt-6-luna",
      modelProvider: "openai",
    }),
  );
});
