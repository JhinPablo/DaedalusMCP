import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { artifactDigest } from "./artifact";
import type { ReleaseCandidate } from "../src/shared/model";
const exec = promisify(execFile),
  repository = "JhinPablo/DaedalusMCP";
const mode = process.argv[2];
if (!["staging", "production", "rollback", "bootstrap"].includes(mode))
  throw new Error("Invalid deployment mode");
const base = process.env.DAEDALUS_URL;
if (!base?.startsWith("https://")) throw new Error("Falta DAEDALUS_URL");
const headers = {
  Authorization: "Bearer " + process.env.DAEDALUS_CI_TOKEN,
  "Content-Type": "application/json",
  "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID ?? "",
  "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET ?? "",
};
async function api<T>(route: string, body?: unknown): Promise<T> {
  const r = await fetch(base + "/api" + route, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Daedalus ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}
async function stagingApi<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(process.env.STAGING_URL + "/api" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + process.env.STAGING_DAEDALUS_CI_TOKEN,
      "Content-Type": "application/json",
      "CF-Access-Client-Id": process.env.STAGING_ACCESS_CLIENT_ID ?? "",
      "CF-Access-Client-Secret": process.env.STAGING_ACCESS_CLIENT_SECRET ?? "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Staging control " + response.status);
  return response.json() as Promise<T>;
}
const control = <T>(route: string, body?: unknown) =>
  mode === "staging" && candidate?.kind === "repository"
    ? stagingApi<T>(route, body)
    : api<T>(route, body);
async function gh<T>(route: string, method = "GET", body?: unknown): Promise<T> {
  const args = ["api", route, "--method", method];
  if (body) args.push("--input", "-");
  return await new Promise<T>((resolve, reject) => {
    import("node:child_process")
      .then(({ spawn }) => {
        const child = spawn("gh", args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let output = "",
          error = "";
        child.stdout.on("data", (v) => (output += v));
        child.stderr.on("data", (v) => (error += v));
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code) reject(new Error(error.slice(0, 1000)));
          else
            try {
              resolve(JSON.parse(output));
            } catch (e) {
              reject(e);
            }
        });
        child.stdin.end(body ? JSON.stringify(body) : undefined);
      })
      .catch(reject);
  });
}
async function cf<T>(args: string[]): Promise<T> {
  const r = await exec("npx", ["cf", ...args], {
    env: process.env,
    maxBuffer: 5 * 1024 * 1024,
  });
  return JSON.parse(r.stdout) as T;
}
async function currentVersion() {
  const r = await cf<{
    deployments: Array<{ versions: Array<{ version_id: string }> }>;
  }>(["workers", "deployments", "list", "--script-name", "daedalus"]);
  return r.deployments?.[0]?.versions?.[0]?.version_id;
}
async function download(runId: string, destination: string) {
  await mkdir(destination, { recursive: true });
  await exec("gh", [
    "run",
    "download",
    runId,
    "--repo",
    repository,
    "--name",
    "build",
    "--dir",
    destination,
  ]);
}
async function verifyProduction(commit: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(process.env.PRODUCTION_URL + "/api/version", {
        headers: {
          Authorization: "Bearer " + process.env.PRODUCTION_DAEDALUS_CI_TOKEN,
          "CF-Access-Client-Id": process.env.PRODUCTION_ACCESS_CLIENT_ID ?? "",
          "CF-Access-Client-Secret": process.env.PRODUCTION_ACCESS_CLIENT_SECRET ?? "",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (
        response.ok &&
        ((await response.json()) as { buildId: string }).buildId === commit
      )
        return;
    } catch {
      // Retry only this read; never replay the deployment after a network failure.
    }
    await new Promise((resolve) => setTimeout(resolve, 6000));
  }
  throw new Error(
    "Production does not serve the approved build; reconcile before retrying",
  );
}
async function cleanPublishedBranches(productionCommit: string) {
  // Delete only refs whose complete history is reachable from verified production.
  const branches: Array<{ name: string; commit: { sha: string } }> = [];
  for (let page = 1; ; page++) {
    const batch = await gh<typeof branches>(
      `repos/${repository}/branches?per_page=100&page=${page}`,
    );
    branches.push(...batch);
    if (batch.length < 100) break;
  }
  for (const branch of branches) {
    if (["main", "staging"].includes(branch.name)) continue;
    const compare = await gh<{ status: string }>(
      `repos/${repository}/compare/${productionCommit}...${branch.commit.sha}`,
    );
    if (!["behind", "identical"].includes(compare.status)) continue;
    // The lease makes deletion conditional on the exact audited tip, atomically.
    await exec("git", [
      "push",
      "origin",
      `--force-with-lease=refs/heads/${branch.name}:${branch.commit.sha}`,
      `:refs/heads/${branch.name}`,
    ]);
    console.log("Removed branch included in production: " + branch.name);
  }
}
let candidate: ReleaseCandidate | undefined;
let publicationStarted = false;
try {
  if (mode === "staging") {
    const sha = process.env.DAEDALUS_SOURCE_SHA,
      run = process.env.DAEDALUS_CI_RUN_ID;
    if (!sha?.match(/^[a-f0-9]{40}$/) || !run?.match(/^\d+$/))
      throw new Error("Invalid source identity");
    candidate = (await api<ReleaseCandidate[]>("/releases")).find(
      (r) => r.commit === sha && r.status === "testing",
    );
    if (!candidate) {
      const source = await gh<{ sha: string }>(`repos/${repository}/commits/staging`);
      if (source.sha !== sha) throw new Error("Obsolete staging CI run");
      const main = await gh<{ sha: string }>(`repos/${repository}/commits/main`);
      const commit = await gh<{ tree: { sha: string } }>(
        `repos/${repository}/git/commits/${sha}`,
      );
      candidate = {
        id: crypto.randomUUID(),
        kind: "repository",
        sessionId: "repository",
        repository,
        branch: "staging",
        commit: sha,
        baseCommit: main.sha,
        tree: commit.tree.sha,
        ciRunId: run,
        checks: "pending",
        status: "testing",
        createdAt: "",
        updatedAt: "",
      };
    }
    candidate.ciRunId = run;
  } else {
    const id = process.env.DAEDALUS_RELEASE_ID;
    if (!id?.match(/^[a-f0-9-]{36}$/)) throw new Error("Invalid release identity");
    candidate = await api<ReleaseCandidate>("/releases/" + id);
    if (
      candidate.status !== "publishing" ||
      !candidate.approval ||
      candidate.approval.fingerprint !== candidate.fingerprint
    )
      throw new Error("The exact candidate is not approved for publication");
  }
  const r = candidate;
  if ((mode === "bootstrap") !== (r.kind === "bootstrap"))
    throw new Error("Deployment mode does not match candidate scope");
  if (mode === "rollback") {
    if (r.error !== "rollback-requested" || !r.previousVersion)
      throw new Error("Rollback not authorized");
    publicationStarted = true;
    await cf([
      "workers",
      "deployments",
      "create",
      "--script-name",
      "daedalus",
      "--strategy",
      "percentage",
      "--versions",
      JSON.stringify([{ version_id: r.previousVersion, percentage: 100 }]),
    ]);
    await api(`/releases/${r.id}/complete`, {
      status: "rolled_back",
      fingerprint: r.fingerprint,
      workerVersion: r.previousVersion,
      mergedCommit: r.mergedCommit,
    });
    console.log("Rollback verified.");
    process.exit(0);
  }
  const run = await gh<{
    head_sha: string;
    conclusion: string;
    name: string;
    path: string;
    head_repository: { full_name: string };
    event: string;
    head_branch: string;
  }>(`repos/${repository}/actions/runs/${r.ciRunId}`);
  if (
    run.head_sha !== r.commit ||
    run.head_repository.full_name !== repository ||
    run.conclusion !== "success" ||
    run.name !== "CI" ||
    !run.path.startsWith(".github/workflows/ci.yml")
  )
    throw new Error("Untrusted or unsuccessful CI run");
  if (
    r.kind === "repository" &&
    (run.event !== "push" || run.head_branch !== "staging")
  )
    throw new Error("Repository preview requires a staging push from this repository");
  const main = await gh<{ sha: string }>(`repos/${repository}/commits/main`);
  if (main.sha !== r.baseCommit)
    throw new Error("main changed; rebuild and approve a new candidate");
  if (r.kind === "repository") {
    const source = await gh<{ sha: string }>(`repos/${repository}/commits/staging`);
    if (source.sha !== r.commit)
      throw new Error("Staging changed; rebuild and approve again");
    const comparison = await gh<{ status: string }>(
      `repos/${repository}/compare/${r.baseCommit}...${r.commit}`,
    );
    if (!["ahead", "identical"].includes(comparison.status))
      throw new Error("Staging must include the current main");
  } else if (mode !== "bootstrap") {
    const pr = await gh<{
      head: { sha: string; repo: { full_name: string } };
      base: { ref: string };
      state: string;
    }>(`repos/${repository}/pulls/${r.prNumber}`);
    if (
      pr.head.sha !== r.commit ||
      pr.head.repo.full_name !== repository ||
      pr.base.ref !== "main" ||
      pr.state !== "open"
    )
      throw new Error("PR identity changed");
  }
  const commit = await gh<{ tree: { sha: string } }>(
    `repos/${repository}/git/commits/${r.commit}`,
  );
  if (commit.tree.sha !== r.tree) throw new Error("Git tree changed");
  const dir = path.resolve(".daedalus/ci", r.id, mode);
  await download(r.ciRunId!, dir);
  const info = JSON.parse(await readFile(path.join(dir, "build-info.json"), "utf8"));
  if (info.commit !== r.commit) throw new Error("Artifact belongs to another commit");
  const digest = await artifactDigest(dir);
  const artifacts = await gh<{
    artifacts: Array<{ id: number; name: string; expired: boolean }>;
  }>(`repos/${repository}/actions/runs/${r.ciRunId}/artifacts`);
  const artifact = artifacts.artifacts.find((a) => a.name === "build" && !a.expired);
  if (!artifact) throw new Error("Missing build artifact");
  if (
    (mode === "production" || mode === "bootstrap") &&
    (digest !== r.artifactDigest || String(artifact.id) !== r.artifactId)
  )
    throw new Error("Approved artifact changed");
  if (mode === "staging" && r.kind === "repository") {
    if (r.commit !== r.baseCommit) {
      const prs = await gh<Array<{ number: number; html_url: string }>>(
        `repos/${repository}/pulls?state=open&head=JhinPablo:staging&base=main`,
      );
      // A preview must not depend on Actions being allowed to create or approve PRs.
      r.prNumber = prs[0]?.number;
      r.prUrl = prs[0]?.html_url;
    }
    const prepared = await stagingApi<ReleaseCandidate>("/releases/repository", {
      repository,
      branch: "staging",
      commit: r.commit,
      baseCommit: r.baseCommit,
      tree: r.tree,
      ciRunId: r.ciRunId,
      prNumber: r.prNumber,
      prUrl: r.prUrl,
    });
    Object.assign(r, prepared);
  }
  await mkdir("dist", { recursive: true });
  await cp(path.join(dir, "client"), "dist/client", { recursive: true });
  await mkdir("dist/worker", { recursive: true });
  await cp(path.join(dir, "worker/index.js"), "dist/worker/index.js");
  // Retain only the previous production generation. Never execute files downloaded from a PR.
  const previous = (await api<ReleaseCandidate[]>("/releases"))
    .filter((p) => p.status === "published" && p.ciRunId)
    .at(-1);
  if (previous) {
    const old = path.resolve(".daedalus/ci", r.id, "previous");
    await download(previous.ciRunId!, old);
    await mkdir("dist/client/assets", { recursive: true });
    for (const file of await readdir(path.join(old, "client/assets")))
      if (/^[A-Za-z0-9_.-]+$/.test(file)) {
        try {
          await readFile(path.join("dist/client/assets", file));
        } catch {
          await cp(
            path.join(old, "client/assets", file),
            path.join("dist/client/assets", file),
          );
        }
      }
  }
  const environment = mode === "staging" ? "staging" : "production";
  const env = {
    ...process.env,
    DAEDALUS_ENVIRONMENT: environment,
    DAEDALUS_BUILD_ID: r.commit,
    ACCESS_AUD:
      environment === "staging"
        ? process.env.STAGING_ACCESS_AUD
        : process.env.PRODUCTION_ACCESS_AUD,
    DAEDALUS_BOOTSTRAP_HASH:
      mode === "bootstrap" ? (process.env.PRODUCTION_BOOTSTRAP_HASH ?? "") : "",
    DAEDALUS_BOOTSTRAP_EXPIRES:
      mode === "bootstrap" ? (process.env.PRODUCTION_BOOTSTRAP_EXPIRES ?? "") : "",
  };
  let mergedCommit: string | undefined, previousVersion: string | undefined;
  if (mode === "bootstrap") {
    if (
      r.commit !== r.baseCommit ||
      !env.DAEDALUS_BOOTSTRAP_HASH ||
      Date.parse(env.DAEDALUS_BOOTSTRAP_EXPIRES) <= Date.now() + 300000
    )
      throw new Error("Initial deployment configuration expired or changed");
    mergedCommit = r.commit;
  }
  if (mode === "production") {
    previousVersion = await currentVersion();
    if (r.kind === "repository" && r.commit === r.baseCommit) {
      mergedCommit = r.commit;
    } else {
      let prNumber = r.prNumber;
      if (r.kind === "repository") {
        const prs = await gh<
          Array<{ number: number; head: { sha: string }; base: { sha: string } }>
        >(`repos/${repository}/pulls?state=open&head=JhinPablo:staging&base=main`);
        const pr = prs.find(
          (p) => p.head.sha === r.commit && p.base.sha === r.baseCommit,
        );
        if (!pr) throw new Error("Missing reviewed staging PR for the approved source");
        prNumber = pr.number;
      }
      await exec(
        "gh",
        [
          "pr",
          "checks",
          String(prNumber),
          "--repo",
          repository,
          "--required",
          "--watch",
          "--fail-fast",
          "--interval",
          "10",
        ],
        { timeout: 180000 },
      );
      publicationStarted = true;
      const merged = await gh<{ sha: string; merged: boolean }>(
        `repos/${repository}/pulls/${prNumber}/merge`,
        "PUT",
        { sha: r.commit, merge_method: "merge" },
      );
      if (!merged.merged) throw new Error("PR was not merged");
      mergedCommit = merged.sha;
      const result = await gh<{ tree: { sha: string } }>(
        `repos/${repository}/git/commits/${merged.sha}`,
      );
      if (result.tree.sha !== r.tree)
        throw new Error("Merged tree does not match approved tree");
    }
  }
  await exec("npx", ["tsx", "scripts/package-worker.ts"], {
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
  publicationStarted = mode !== "staging";
  await exec("npx", ["cf", "deploy", "--prebuilt", "--tag", r.commit], {
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180000,
  });
  if (mode === "staging") {
    const probeHeaders = {
      Authorization: "Bearer " + process.env.STAGING_DAEDALUS_CI_TOKEN,
      "CF-Access-Client-Id": process.env.STAGING_ACCESS_CLIENT_ID ?? "",
      "CF-Access-Client-Secret": process.env.STAGING_ACCESS_CLIENT_SECRET ?? "",
    };
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(process.env.STAGING_URL + "/api/version", {
          headers: probeHeaders,
          signal: AbortSignal.timeout(10000),
        });
        if (
          response.ok &&
          ((await response.json()) as { buildId: string }).buildId === r.commit
        ) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
    if (!ready)
      throw new Error(
        "Staging health check failed; candidate is not ready for approval",
      );
  }
  if (mode === "staging")
    await control(`/releases/${r.id}/result`, {
      commit: r.commit,
      baseCommit: r.baseCommit,
      tree: r.tree,
      artifactDigest: digest,
      artifactId: String(artifact.id),
      ciRunId: r.ciRunId,
      checks: "passed",
      previewUrl: process.env.STAGING_URL,
    });
  else {
    if (mode === "production") await verifyProduction(r.commit);
    await api(`/releases/${r.id}/complete`, {
      status: "published",
      fingerprint: r.fingerprint,
      workerVersion: await currentVersion(),
      previousVersion,
      mergedCommit,
    });
    if (mode === "production") {
      await cleanPublishedBranches(mergedCommit!).catch((error) =>
        console.warn(
          "Production verified; branch cleanup needs attention: " + String(error),
        ),
      );
    }
  }
  console.log("Deployment completed and reported: " + mode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (candidate && mode === "staging")
    await control(`/releases/${candidate.id}/fail`, {
      commit: candidate.commit,
      error:
        "Fallaron las comprobaciones o el despliegue de staging. Consulta el workflow de GitHub.",
    }).catch(() => {});
  if (candidate && mode !== "staging")
    await api(`/releases/${candidate.id}/complete`, {
      status: publicationStarted ? "uncertain" : "failed",
      fingerprint: candidate.fingerprint,
      error:
        "El workflow se interrumpió; comprobar GitHub y la versión de Cloudflare antes de continuar.",
    }).catch(() => {});
  process.exitCode = 1;
}
