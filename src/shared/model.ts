import { z } from "zod";

export const taskInput = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  title: z.string().min(1).max(200),
  prompt: z
    .string()
    .min(1)
    .max(30000)
    .describe(
      "Instrucción imperativa de implementación y verificación para Codex, ejecutada solo después de la aprobación humana; no es un encargo de volver a planear.",
    ),
  dependsOn: z.array(z.string()).max(30).default([]),
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20),
  skills: z.array(z.string()).max(20).default([]),
  areas: z.array(z.string()).max(30).default([]),
});
export const proposalInput = z.object({
  objective: z.string().min(1).max(3000),
  scope: z.string().min(1).max(5000),
  alternatives: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        explanation: z.string().min(1).max(3000),
        tradeoffs: z.string().min(1).max(3000),
      }),
    )
    .min(2)
    .max(5),
  recommendation: z.string().min(1).max(5000),
  critique: z.string().min(1).max(6000),
  prompt: z
    .string()
    .min(1)
    .max(30000)
    .describe(
      "Prompt final que Codex debe ejecutar una vez aprobado. Ordena implementar y verificar; no incluyas instrucciones para esperar otra aprobación o solo entregar planes.",
    ),
  tasks: z.array(taskInput).min(1).max(30),
});
export type Proposal = z.infer<typeof proposalInput>;
export type Task = z.infer<typeof taskInput> & {
  status: "pending" | "running" | "completed" | "failed";
  runId?: string;
};
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";
export type Phase =
  | "idea"
  | "planning"
  | "approach"
  | "plan"
  | "executing"
  | "review"
  | "completed"
  | "paused"
  | "cancelled";
export interface Project {
  id: string;
  name: string;
  rootLabel: string;
  connectorId: string;
  createdAt: string;
}
export interface IdeaNode {
  id: string;
  taskId?: string;
  parentId?: string;
  kind: "idea" | "alternative" | "critique" | "prompt" | "task" | "review";
  title: string;
  content: string;
  collapsed?: boolean;
}
export interface PromptVersion {
  version: number;
  digest: string;
  proposal: Proposal;
  createdAt: string;
}
export interface Approval {
  id: string;
  milestone: "approach" | "execution";
  version: number;
  digest: string;
  decision: "approved" | "rejected" | "changes";
  explanation: string;
  createdAt: string;
}
export interface Artifact {
  id: string;
  runId: string;
  name: string;
  key: string;
  mediaType: string;
  size: number;
  createdAt: string;
  storage?: "cloud" | "local";
  localPath?: string;
}
export interface ReleaseCandidate {
  kind?: "agents" | "bootstrap";
  fingerprint?: string;
  id: string;
  sessionId: string;
  repository: string;
  branch: string;
  commit: string;
  baseCommit: string;
  tree: string;
  prNumber?: number;
  prUrl?: string;
  artifactDigest?: string;
  artifactId?: string;
  ciRunId?: string;
  checks: "pending" | "passed" | "failed";
  previewUrl?: string;
  status:
    | "preparing"
    | "testing"
    | "ready"
    | "approved"
    | "publishing"
    | "published"
    | "superseded"
    | "failed"
    | "uncertain"
    | "rolled_back";
  createdAt: string;
  updatedAt: string;
  approval?: { ownerId: string; at: string; fingerprint: string };
  mergedCommit?: string;
  workerVersion?: string;
  previousVersion?: string;
  error?: string;
}
export interface AgentRun {
  preflightFailure?: boolean;
  model?: string;
  id: string;
  sessionId: string;
  projectId: string;
  kind: "planning" | "task" | "review";
  taskId?: string;
  status: RunStatus;
  connectorId?: string;
  prompt: string;
  skills: string[];
  approvedDigest?: string;
  approvedVersion?: number;
  returnPhase?: Phase;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  output: string;
  error?: string;
  externalSessionId?: string;
  worktree?: string;
  branch?: string;
  baseCommit?: string;
  changes?: string;
}
export interface PermissionRequest {
  id: string;
  runId: string;
  method: string;
  description: string;
  details: unknown;
  decision?: "accept" | "decline";
  answers?: Record<string, string[]>;
  createdAt: string;
}
export interface Event {
  id: string;
  at: string;
  sessionId?: string;
  runId?: string;
  type: string;
  message: string;
}
export interface ConversationMessage {
  model?: string;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
export interface Session {
  id: string;
  projectId: string;
  title: string;
  phase: Phase;
  nodes: IdeaNode[];
  messages: ConversationMessage[];
  versions: PromptVersion[];
  approvals: Approval[];
  tasks: Task[];
  createdAt: string;
}
export interface ConnectorInfo {
  id: string;
  name: string;
  lastSeen: string;
  codex: boolean;
  opencode: boolean;
  planning?: boolean;
  planningModel?: string;
  model?: string;
  error?: string;
}
export interface Credential {
  id: string;
  label: string;
  role: "connector" | "mcp" | "ci" | "publisher";
  hash: string;
  createdAt: string;
  revokedAt?: string;
}
export interface Workspace {
  migrationId?: string;
  schemaVersion: 1;
  revision: number;
  projects: Project[];
  sessions: Session[];
  runs: AgentRun[];
  permissions: PermissionRequest[];
  artifacts: Artifact[];
  events: Event[];
  connectors: ConnectorInfo[];
  credentials: Credential[];
  releases: ReleaseCandidate[];
}
export type Role = "owner" | "connector" | "mcp" | "ci" | "migration" | "publisher";
export interface Principal {
  role: Role;
  id: string;
}
export const emptyWorkspace = (): Workspace => ({
  schemaVersion: 1,
  revision: 0,
  projects: [],
  sessions: [],
  runs: [],
  permissions: [],
  artifacts: [],
  events: [],
  connectors: [],
  credentials: [],
  releases: [],
});
export const normalizeWorkspace = (state: Workspace): Workspace => ({
  ...state,
  releases: state.releases ?? [],
});
export const activeStatuses: RunStatus[] = [
  "queued",
  "running",
  "waiting_permission",
  "uncertain",
];
export const terminalStatuses: RunStatus[] = ["completed", "failed", "cancelled"];
export const currentVersion = (s: Session) => s.versions.at(-1);
