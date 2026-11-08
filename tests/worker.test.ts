import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
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
      r2Buckets: ["ARTIFACTS"],
      serviceBindings: { ASSETS: () => new Response("<html>Daedalus</html>") },
      bindings: {
        ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
        ACCESS_AUD: "test-audience",
        OWNER_EMAIL: "owner@example.com",
      },
    }),
    resourcePersistencePath: await mkdtemp(path.join(tmpdir(), "daedalus-resources-")),
  };
  mf = new Miniflare(options);
}, 30000);
afterAll(async () => {
  await mf?.dispose();
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
  for(let i=0;i<4;i++){const created=await stub.fetch('https://internal/api/sessions',{method:'POST',headers:{'X-Daedalus-Principal':JSON.stringify({role:'owner',id:'owner'}),'Content-Type':'application/json'},body:JSON.stringify({projectId:'project',title:'Sesión '+i,idea:'Arquitectura 🛠️ '.repeat(1400)})});expect(created.status).toBe(201);}
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
  const recovered=await restored.json() as {projects:unknown[];sessions:Array<{nodes:Array<{content:string}>}>};expect(recovered.projects).toHaveLength(1);expect(recovered.sessions).toHaveLength(4);expect(recovered.sessions[0].nodes[0].content).toBe('Arquitectura 🛠️ '.repeat(1400));
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
