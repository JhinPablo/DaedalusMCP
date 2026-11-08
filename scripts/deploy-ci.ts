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
let candidate: ReleaseCandidate | undefined;
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
      console.log("No registered candidate for this CI run; no deployment.");
      process.exit(0);
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
  }>(`repos/${repository}/actions/runs/${r.ciRunId}`);
  if (
    run.head_sha !== r.commit ||
    run.head_repository.full_name !== repository ||
    run.conclusion !== "success" ||
    run.name !== "CI" ||
    !run.path.startsWith(".github/workflows/ci.yml")
  )
    throw new Error("Untrusted or unsuccessful CI run");
  const main = await gh<{ sha: string }>(`repos/${repository}/commits/main`);
  if (main.sha !== r.baseCommit)
    throw new Error("main changed; rebuild and approve a new candidate");
  if (mode !== "bootstrap") {
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
    const merged = await gh<{ sha: string; merged: boolean }>(
      `repos/${repository}/pulls/${r.prNumber}/merge`,
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
  await exec("npx", ["tsx", "scripts/package-worker.ts"], {
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
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
    for (let attempt = 0; attempt < 10; attempt++) {
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
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!ready)
      throw new Error(
        "Staging health check failed; candidate is not ready for approval",
      );
  }
  if (mode === "staging")
    await api(`/releases/${r.id}/result`, {
      commit: r.commit,
      baseCommit: r.baseCommit,
      tree: r.tree,
      artifactDigest: digest,
      artifactId: String(artifact.id),
      ciRunId: r.ciRunId,
      checks: "passed",
      previewUrl: process.env.STAGING_URL,
    });
  else
    await api(`/releases/${r.id}/complete`, {
      status: "published",
      fingerprint: r.fingerprint,
      workerVersion: await currentVersion(),
      previousVersion,
      mergedCommit,
    });
  console.log("Deployment completed and reported: " + mode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (candidate && mode === "staging")
    await api(`/releases/${candidate.id}/fail`, {
      commit: candidate.commit,
      error:
        "Fallaron las comprobaciones o el despliegue de staging. Consulta el workflow de GitHub.",
    }).catch(() => {});
  if (candidate && mode !== "staging")
    await api(`/releases/${candidate.id}/complete`, {
      status: "uncertain",
      fingerprint: candidate.fingerprint,
      error:
        "El workflow se interrumpió; comprobar GitHub y la versión de Cloudflare antes de continuar.",
    }).catch(() => {});
  process.exitCode = 1;
}
