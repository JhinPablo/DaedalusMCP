import { mkdir, copyFile, realpath } from "node:fs/promises";
import path from "node:path";
import { loadAndParseConfig } from "@cloudflare/config";
import {
  getWorkerBundleDir,
  cleanBuildOutputDir,
  writeAssets,
  writeRootConfig,
  writeWorkerConfig,
} from "@cloudflare/build-output-utils";

// These build-output helpers are version-pinned alongside cf in package-lock.json.
const root = process.cwd(),
  ctx = { isPreview: false, mode: process.env.DAEDALUS_ENVIRONMENT ?? "production" };
const { result } = await loadAndParseConfig(
  path.join(root, "cloudflare.config.ts"),
  ctx,
);
if (!result.success) throw new Error(result.error.message);
const config = result.data.worker;
if (!config) throw new Error("Falta la configuración del Worker.");
const output = path.resolve(root, ".cloudflare/output");
try {
  const resolved = await realpath(output);
  if (!resolved.startsWith(root + path.sep))
    throw new Error("El directorio de salida apunta fuera del proyecto.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await cleanBuildOutputDir(root);
const bundle = getWorkerBundleDir(root);
await mkdir(bundle, { recursive: true });
await copyFile("dist/worker/index.js", path.join(bundle, "index.js"));
await mkdir("dist/client/licenses", { recursive: true });
await copyFile(
  "node_modules/@fontsource/ibm-plex-sans/LICENSE",
  "dist/client/licenses/ibm-plex-sans.txt",
);
await copyFile(
  "node_modules/@fontsource/ibm-plex-mono/LICENSE",
  "dist/client/licenses/ibm-plex-mono.txt",
);
await writeWorkerConfig({
  root,
  config,
  manifest: {
    type: "complete",
    mainModule: "index.js",
    modules: { "index.js": { type: "esm" } },
  },
});
await writeAssets({ root, sourceDirectory: path.join(root, "dist/client") });
const { worker: _worker, containers: _containers, ...settings } = result.data;
await writeRootConfig(root, settings, ctx);
console.log(
  "Worker y assets empaquetados en .cloudflare/output/ para cf deploy --prebuilt.",
);
