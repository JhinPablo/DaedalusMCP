import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { digest } from "../src/shared/engine";
import { emptyWorkspace } from "../src/shared/model";
import { tmpdir } from "node:os";
let mf: Miniflare;
let options: ConstructorParameters<typeof Miniflare>[0];
beforeAll(async () => {
  await build({
    entryPoints: ["src/worker/index.ts"],
    outfile: ".daedalus/test-worker.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
  });
  options = {
    ...convertV4MiniflareOptions({
      name: "daedalus-test",
      modules: true,
      scriptPath: ".daedalus/test-worker.js",
      compatibilityDate: "2026-11-06",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        WORKSPACE: { className: "WorkspaceObject", useSQLite: true },
      },
      durableObjectsPersist: await mkdtemp(path.join(tmpdir(), "daedalus-do-")),
      serviceBindings: { ASSETS: () => new Response("<html>Daedalus</html>") },
      bindings: {
        ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
        ACCESS_AUD: "test-audience",
        OWNER_EMAIL: "owner@example.com",
        ENVIRONMENT: "production",
        BUILD_ID: "test-build",
        BOOTSTRAP_HASH: digest("migration-test-secret"),
        BOOTSTRAP_EXPIRES: "2099-01-01T00:00:00Z",
      },
    }),
    resourcePersistencePath: await mkdtemp(path.join(tmpdir(), "daedalus-resources-")),
  };
  mf = new Miniflare(options);
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
it("la migración inicial es acotada, idempotente y no concede autoridad humana", async () => {
  const state = emptyWorkspace(),
    migrationId = crypto.randomUUID();
  state.credentials.push({
    id: "cloud-device",
    label: "Device",
    role: "connector",
    hash: digest("device-secret"),
    createdAt: new Date().toISOString(),
  });
  const headers = {
    Authorization: "Bearer migration-test-secret",
    "Content-Type": "application/json",
  };
  const imported = await mf.dispatchFetch("https://daedalus.test/api/migration", {
    method: "POST",
    headers,
    body: JSON.stringify({ migrationId, state }),
  });
  expect(imported.status).toBe(200);
  expect(
    (await mf.dispatchFetch("https://daedalus.test/api/state", { headers })).status,
  ).toBe(401);
  const replacement = structuredClone(state);
  replacement.projects.push({
    id: "not-imported",
    name: "Replacement",
    rootLabel: "x",
    connectorId: "cloud-device",
    createdAt: new Date().toISOString(),
  });
  expect(
    (
      await mf.dispatchFetch("https://daedalus.test/api/migration", {
        method: "POST",
        headers,
        body: JSON.stringify({ migrationId, state: replacement }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await mf.dispatchFetch("https://daedalus.test/api/migration", {
        method: "POST",
        headers,
        body: JSON.stringify({ migrationId: crypto.randomUUID(), state }),
      })
    ).status,
  ).toBe(409);
  const namespace = await mf.getDurableObjectNamespace("WORKSPACE");
  const snapshot = (await namespace
    .get(namespace.idFromName("owner-workspace"))
    .fetch("https://internal/api/state", {
      headers: {
        "X-Daedalus-Principal": JSON.stringify({ role: "owner", id: "owner" }),
      },
    })
    .then((r) => r.json())) as { projects: unknown[] };
  expect(snapshot.projects).toHaveLength(0);
  expect(
    (
      await mf.dispatchFetch("https://daedalus.test/api/credentials", {
        method: "POST",
        headers: {
          Authorization: "Bearer device-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label: "Illegal", role: "ci" }),
      })
    ).status,
  ).toBe(403);
});
it("el Worker no acepta un principal inyectado por un cliente anónimo", async () => {
  const response = await mf.dispatchFetch("https://daedalus.test/api/state", {
    headers: {
      "X-Daedalus-Principal": JSON.stringify({ role: "owner", id: "attacker" }),
    },
  });
  expect(response.status).toBe(401);
});
it("el Worker rechaza assertions de Access sin firma válida", async () => {
  const response = await mf.dispatchFetch("https://daedalus.test/api/state", {
    headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
  });
  expect(response.status).toBe(401);
});
it("SQLite del Durable Object conserva estado y aísla identidades", async () => {
  const namespace = await mf.getDurableObjectNamespace("WORKSPACE"),
    stub = namespace.get(namespace.idFromName("test-workspace"));
  const response = await stub.fetch("https://internal/api/connector/register", {
    method: "POST",
    headers: {
      "X-Daedalus-Principal": JSON.stringify({
        role: "connector",
        id: "device",
      }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Equipo de pruebas",
      codex: true,
      opencode: true,
      projects: [{ id: "project", name: "Proyecto", rootLabel: "project" }],
    }),
  });
  expect(response.status).toBe(200);
  for (let i = 0; i < 4; i++) {
    const created = await stub.fetch("https://internal/api/sessions", {
      method: "POST",
      headers: {
        "X-Daedalus-Principal": JSON.stringify({ role: "owner", id: "owner" }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: "project",
        title: "Sesión " + i,
        idea: "Arquitectura 🛠️ ".repeat(1400),
      }),
    });
    expect(created.status).toBe(201);
  }
  const state = await stub.fetch("https://internal/api/state", {
    headers: {
      "X-Daedalus-Principal": JSON.stringify({ role: "owner", id: "owner" }),
    },
  });
  expect(((await state.json()) as { projects: unknown[] }).projects).toHaveLength(1);
  await mf.dispose();
  mf = new Miniflare(options);
  const restoredNamespace = await mf.getDurableObjectNamespace("WORKSPACE");
  const restored = await restoredNamespace
    .get(restoredNamespace.idFromName("test-workspace"))
    .fetch("https://internal/api/state", {
      headers: {
        "X-Daedalus-Principal": JSON.stringify({ role: "owner", id: "owner" }),
      },
    });
  const recovered = (await restored.json()) as {
    projects: unknown[];
    sessions: Array<{ nodes: Array<{ content: string }> }>;
  };
  expect(recovered.projects).toHaveLength(1);
  expect(recovered.sessions).toHaveLength(4);
  expect(recovered.sessions[0].nodes[0].content).toBe("Arquitectura 🛠️ ".repeat(1400));
  const other = restoredNamespace.get(
    restoredNamespace.idFromName("another-workspace"),
  );
  const isolated = await other.fetch("https://internal/api/state", {
    headers: {
      "X-Daedalus-Principal": JSON.stringify({ role: "owner", id: "owner" }),
    },
  });
  expect(((await isolated.json()) as { projects: unknown[] }).projects).toHaveLength(0);
});
it("reports the active Worker build even when the Durable Object retains old metadata", async () => {
  const versionServer = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: "active-worker",
          modules: true,
          scriptPath: ".daedalus/test-worker.js",
          compatibilityDate: "2026-11-06",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            WORKSPACE: {
              className: "CachedWorkspace",
              scriptName: "cached-workspace",
              useSQLite: true,
            },
          },
          bindings: {
            BUILD_ID: "current-build",
            ENVIRONMENT: "staging",
            ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
            ACCESS_AUD: "test-audience",
            OWNER_EMAIL: "owner@example.com",
          },
        },
        {
          name: "cached-workspace",
          modules: true,
          compatibilityDate: "2026-11-06",
          durableObjects: { OWN: { className: "CachedWorkspace", useSQLite: true } },
          script: `import {DurableObject} from 'cloudflare:workers';
        export class CachedWorkspace extends DurableObject {
          async authenticate(token) { return token === 'ci-test' ? {role:'ci',id:'ci'} : null; }
          async fetch() { return Response.json({buildId:'previous-build',environment:'staging',apiVersion:1}); }
        }
        export default {fetch() {return new Response('internal');}};`,
        },
      ],
    }),
    resourcePersistencePath: await mkdtemp(path.join(tmpdir(), "daedalus-version-")),
  });
  try {
    const response = await versionServer.dispatchFetch(
      "https://daedalus.test/api/version",
      {
        headers: { Authorization: "Bearer ci-test" },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      buildId: "current-build",
      environment: "staging",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const denied = await versionServer.dispatchFetch(
      "https://daedalus.test/api/version",
      {
        headers: { Authorization: "Bearer invalid" },
      },
    );
    expect(denied.status).toBe(401);
  } finally {
    await versionServer.dispose();
  }
});
