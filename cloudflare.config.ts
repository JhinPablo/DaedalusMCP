import { defineConfig, bindings, exports } from "cf/config";

export default defineConfig(({ mode }) => {
  const environment = mode === "staging" ? "staging" : "production";
  const name = environment === "staging" ? "daedalus-staging" : "daedalus";
  return {
    worker: {
      name,
      entrypoint: "./src/worker/index.ts",
      compatibilityDate: "2026-11-07",
      compatibilityFlags: ["nodejs_compat"],
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: true,
      },
      env: {
        ASSETS: bindings.assets(),
        WORKSPACE: bindings.durableObject({
          worker: name,
          exportName: "WorkspaceObject",
        }),
        ENVIRONMENT: bindings.text(environment),
        BUILD_ID: bindings.text(process.env.DAEDALUS_BUILD_ID ?? "local"),
        REPOSITORY: bindings.text("JhinPablo/DaedalusMCP"),
        STAGING_URL: bindings.text(process.env.STAGING_URL ?? ""),
        BOOTSTRAP_HASH: bindings.text(process.env.DAEDALUS_BOOTSTRAP_HASH ?? ""),
        BOOTSTRAP_EXPIRES: bindings.text(process.env.DAEDALUS_BOOTSTRAP_EXPIRES ?? ""),
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
  };
});
