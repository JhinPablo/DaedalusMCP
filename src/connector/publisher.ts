import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { git } from "./worktrees";
import type { AgentRun, ReleaseCandidate } from "../shared/model";
const exec = promisify(execFile);
type Api = <T = unknown>(route: string, body?: unknown) => Promise<T>;
export async function publishTaskProgress(
  repository: string,
  root: string,
  run: AgentRun,
  api: Api,
) {
  if (
    !run.worktree ||
    !run.branch ||
    run.kind !== "task" ||
    run.status !== "completed" ||
    run.changes?.startsWith("No se generaron cambios")
  )
    return;
  if (
    repository !== "JhinPablo/DaedalusMCP" ||
    !/^daedalus\/[a-zA-Z0-9_-]+$/.test(run.branch)
  )
    throw new Error("Rama o repositorio no autorizado.");
  const journal = path.join(root, "..", "publisher");
  await mkdir(journal, { recursive: true });
  const file = path.join(journal, "task-" + run.id + ".json");
  try {
    await readFile(file);
    return;
  } catch {}
  const remote = await git(run.worktree, "remote", "get-url", "origin");
  if (
    ![
      "https://github.com/" + repository,
      "https://github.com/" + repository + ".git",
      "git@github.com:" + repository + ".git",
    ].includes(remote)
  )
    throw new Error("Remoto de otro repositorio.");
  const tracked = (await git(run.worktree, "ls-files")).split("\n");
  if (
    tracked.some(
      (file) =>
        /(^|\/)(\.daedalus|node_modules)(\/|$)|(^|\/)\.env($|\.)|connector\.local\.json$/.test(
          file,
        ) && !file.endsWith(".env.example"),
    )
  )
    throw new Error("La tarea contiene archivos privados.");
  const commit = await git(run.worktree, "rev-parse", "HEAD");
  await writeFile(file, JSON.stringify({ stage: "started", commit }));
  try {
    // Keep executor branches local; the reviewed integration advances shared staging.
    await api(`/api/runs/${run.id}/progress`, { commit });
    await writeFile(file, JSON.stringify({ stage: "finished", commit }));
  } catch (error) {
    await writeFile(
      file,
      JSON.stringify({ stage: "uncertain", commit, error: String(error) }),
    );
    throw new Error(
      "No se confirmó la publicación del avance. Revisa GitHub antes de repetirla.",
    );
  }
}
async function gh<T>(repository: string, args: string[], cwd: string): Promise<T> {
  if (repository !== "JhinPablo/DaedalusMCP")
    throw new Error("Repositorio no autorizado.");
  const result = await exec("gh", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout || "null") as T;
}
export async function publishReviews(
  repository: string,
  root: string,
  reviews: AgentRun[],
  releases: ReleaseCandidate[],
  api: Api,
  projects: Array<{ id: string; root: string }> = [],
  controlEnvironment: "production" | "staging" = "production",
) {
  const journal = path.join(root, "..", "publisher");
  await mkdir(journal, { recursive: true });
  for (const review of reviews) {
    if (
      !review.worktree ||
      !review.branch ||
      releases.some((r) => r.sessionId === review.sessionId)
    )
      continue;
    const file = path.join(journal, review.id + ".json");
    try {
      await readFile(file);
      continue;
    } catch {}
    await writeFile(file, JSON.stringify({ stage: "started", review: review.id }));
    try {
      const cwd = review.worktree,
        commit = await git(cwd, "rev-parse", "HEAD"),
        tree = await git(cwd, "rev-parse", "HEAD^{tree}");
      const remote = await git(cwd, "remote", "get-url", "origin");
      if (
        ![
          "https://github.com/" + repository,
          "https://github.com/" + repository + ".git",
          "git@github.com:" + repository + ".git",
        ].includes(remote)
      )
        throw new Error(
          "El remoto del proyecto no coincide con el repositorio autorizado.",
        );
      const tracked = (await git(cwd, "ls-files")).split("\n");
      if (
        tracked.some(
          (file) =>
            /(^|\/)(\.daedalus|node_modules)(\/|$)|(^|\/)\.env($|\.)|connector\.local\.json$/.test(
              file,
            ) && !file.endsWith(".env.example"),
        )
      )
        throw new Error("La rama contiene archivos privados y no se publicará.");
      const base = await gh<{ sha: string }>(
        repository,
        ["api", `repos/${repository}/commits/main`],
        cwd,
      );
      if ((await git(cwd, "merge-base", base.sha, commit)) !== base.sha)
        throw new Error("La rama debe actualizarse con main y volver a verificarse.");
      // The branch must contain the reviewed commit before GitHub can open its PR.
      // A normal push refuses divergent staging; never replace another chat's changes.
      await git(cwd, "push", "origin", "HEAD:refs/heads/staging");
      const prs = await gh<Array<{ number: number; url: string }>>(
        repository,
        [
          "pr",
          "list",
          "--repo",
          repository,
          "--head",
          "staging",
          "--json",
          "number,url",
        ],
        cwd,
      );
      let pr = prs[0];
      if (!pr) {
        const created = await exec(
          "gh",
          [
            "pr",
            "create",
            "--repo",
            repository,
            "--base",
            "main",
            "--head",
            "staging",
            "--title",
            "✨feat: deliver approved Daedalus changes " + commit.slice(0, 8),
            "--body",
            "Reviewed changes for the approved plan. CI, staging preview and owner approval are required before production publication.",
          ],
          { cwd, windowsHide: true },
        );
        const url = created.stdout.trim();
        pr = { url, number: Number(url.split("/").at(-1)) };
      }
      const release = await api<ReleaseCandidate>("/api/releases", {
        sessionId: review.sessionId,
        repository,
        branch: "staging",
        commit,
        baseCommit: base.sha,
        tree,
        prNumber: pr.number,
        prUrl: pr.url,
      });
      // CI's trusted workflow_run handler stages this candidate after the PR checks succeed.
      await writeFile(
        file,
        JSON.stringify({ stage: "finished", releaseId: release.id, commit }),
      );
    } catch (error) {
      await writeFile(
        file,
        JSON.stringify({ stage: "uncertain", error: String(error) }),
      );
      await api("/api/runs/" + review.id + "/event", {
        message:
          "Publicación detenida; revisa el journal del publicador antes de reintentar: " +
          String(error),
      });
    }
  }
  for (const release of releases.filter((r) => r.status === "approved")) {
    const file = path.join(
      journal,
      "release-" +
        release.id +
        (release.error === "rollback-requested" ? "-rollback" : "-publish") +
        ".json",
    );
    try {
      await readFile(file);
      continue;
    } catch {}
    const claimed = await api<ReleaseCandidate>(
      `/api/releases/${release.id}/claim`,
      {},
    );
    await writeFile(file, JSON.stringify({ stage: "started", releaseId: release.id }));
    try {
      // Workflow code always comes from protected main, never from the candidate branch.
      await exec(
        "gh",
        [
          "workflow",
          "run",
          claimed.error === "rollback-requested" ? "rollback.yml" : "publish.yml",
          "--repo",
          repository,
          "--ref",
          "main",
          "-f",
          "release_id=" + release.id,
          ...(controlEnvironment === "staging"
            ? ["-f", "control_environment=staging"]
            : []),
        ],
        { windowsHide: true },
      );
      await writeFile(
        file,
        JSON.stringify({ stage: "dispatched", releaseId: release.id }),
      );
    } catch (error) {
      await writeFile(
        file,
        JSON.stringify({ stage: "uncertain", error: String(error) }),
      );
      await api(`/api/releases/${release.id}/complete`, {
        status: "uncertain",
        fingerprint: claimed.approval?.fingerprint,
        error:
          "No se confirmó el inicio del workflow. Reconciliar antes de reintentar.",
      });
    }
  }
  const latest = releases
    .filter((r) => r.status === "published" && r.mergedCommit)
    .at(-1);
  if (latest) {
    const projectId = reviews.find(
      (review) => review.sessionId === latest.sessionId,
    )?.projectId;
    const project = projects.find((p) => p.id === projectId);
    if (
      project &&
      (await git(project.root, "rev-parse", "HEAD")) !== latest.mergedCommit &&
      (await git(project.root, "branch", "--show-current")) === "main" &&
      !(await git(project.root, "status", "--porcelain"))
    ) {
      const remote = await git(project.root, "remote", "get-url", "origin");
      if (
        [
          `https://github.com/${repository}`,
          `https://github.com/${repository}.git`,
          `git@github.com:${repository}.git`,
        ].includes(remote)
      ) {
        await git(project.root, "fetch", "origin", "main");
        await git(project.root, "merge", "--ff-only", "origin/main");
      }
    }
  }
}
