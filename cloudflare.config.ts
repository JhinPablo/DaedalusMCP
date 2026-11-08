import { defineConfig, bindings, exports } from "cf/config";

export default defineConfig({
  worker: {
    name: "daedalus",
    entrypoint: "./src/worker/index.ts",
    compatibilityDate: "2026-11-06",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: true,
    },
    env: {
      ASSETS: bindings.assets(),
      WORKSPACE: bindings.durableObject({
        worker: "daedalus",
        exportName: "WorkspaceObject",
      }),
      ARTIFACTS: bindings.r2({ name: "daedalus-artifacts" }),
      ACCESS_TEAM_DOMAIN: bindings.text(process.env.ACCESS_TEAM_DOMAIN ?? ""),
      ACCESS_AUD: bindings.text(process.env.ACCESS_AUD ?? ""),
      OWNER_EMAIL: bindings.text(process.env.OWNER_EMAIL ?? ""),
    },
    exports: { WorkspaceObject: exports.durableObject({ storage: "sqlite" }) },
    observability: {
      enabled: true,
      redactQueryString: true,
      traces: { enabled: true, headSamplingRate: 0.1 },
    },
  },
});
