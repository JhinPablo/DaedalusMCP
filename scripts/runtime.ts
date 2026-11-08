import { build } from "esbuild";
import { mkdir, readFile, writeFile, rename, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  runtime = path.join(workspace, ".daedalus/runtime");
await mkdir(runtime, { recursive: true });
const command = process.argv[2] ?? "start",
  configFile = path.resolve(
    process.argv[3] ?? path.join(workspace, "connector.local.json"),
  );
const configuration = JSON.parse(await readFile(configFile, "utf8"));
const journal = path.resolve(
  path.dirname(configFile),
  configuration.journalRoot ?? ".daedalus/connector",
);
await mkdir(journal, { recursive: true });
async function install() {
  const bundle = await build({
    entryPoints: [path.join(workspace, "src/connector/index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    banner: {
      js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);',
    },
  });
  const source = bundle.outputFiles[0].contents,
    lock = await readFile(path.join(workspace, "skills-lock.json"));
  const version = createHash("sha256")
      .update(source)
      .update(lock)
      .digest("hex")
      .slice(0, 16),
    directory = path.join(runtime, "releases", version);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "connector.mjs"), source);
  await copyFile(
    path.join(workspace, "skills-lock.json"),
    path.join(directory, "skills-lock.json"),
  );
  await writeFile(
    path.join(runtime, "current.json.tmp"),
    JSON.stringify({ version, directory }),
  );
  await rename(
    path.join(runtime, "current.json.tmp"),
    path.join(runtime, "current.json"),
  );
  console.log("Conector empaquetado: " + version);
  return version;
}
if (command === "install" || command === "update") {
  await install();
  if (command === "update") await writeFile(path.join(journal, "drain"), "update");
} else if (command === "start") {
  const lock = path.join(runtime, "launcher.lock");
  try {
    const old = Number(await readFile(lock, "utf8"));
    try {
      process.kill(old, 0);
      throw new Error("Ya hay un conector estable iniciado.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await rm(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(lock, String(process.pid), { flag: "wx" });
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  const stop = () => {
    stopping = true;
    void writeFile(path.join(journal, "drain"), "stop");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    try {
      await readFile(path.join(runtime, "current.json"));
    } catch {
      await install();
    }
    while (!stopping) {
      await rm(path.join(journal, "drain"), { force: true });
      const current = JSON.parse(
        await readFile(path.join(runtime, "current.json"), "utf8"),
      );
      let secrets: Record<string, string> = {};
      try {
        secrets = JSON.parse(
          await readFile(path.join(workspace, ".daedalus/connection.json"), "utf8"),
        );
      } catch {}
      const env = { ...process.env, ...secrets };
      child = spawn(
        process.execPath,
        [path.join(current.directory, "connector.mjs"), "--config", configFile],
        { cwd: current.directory, env, windowsHide: true, stdio: "inherit" },
      );
      const code = await new Promise<number | null>((resolve, reject) => {
        child!.on("exit", resolve);
        child!.on("error", reject);
      });
      if (stopping) break;
      const next = JSON.parse(
        await readFile(path.join(runtime, "current.json"), "utf8"),
      );
      if (next.version === current.version) {
        if (code !== 0)
          throw new Error(
            "El conector terminó; revisa sus journals antes de reiniciarlo.",
          );
        break;
      }
    }
  } finally {
    await rm(lock, { force: true });
  }
} else throw new Error("Usa install, start o update.");
