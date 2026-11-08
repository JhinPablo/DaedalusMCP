import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { inside } from "../src/connector/config";
const exec = promisify(execFile),
  root = path.resolve(".daedalus/skills");
const lock = JSON.parse(await readFile("skills-lock.json", "utf8")) as {
  sources: Array<{
    id: string;
    repository: string;
    revision: string;
    licenseFiles: string[];
  }>;
};
await mkdir(root, { recursive: true });
for (const source of lock.sources) {
  if (
    !/^[a-z]+$/.test(source.id) ||
    !/^https:\/\/github.com\/[\w.-]+\/[\w.-]+$/.test(source.repository) ||
    !source.revision.match(/^[a-f0-9]{40}$/)
  )
    throw new Error("Entrada de lock inválida.");
  const target = path.join(root, source.id);
  await mkdir(target, { recursive: true });
  if (!inside(root, await realpath(target)))
    throw new Error("Ruta de fuente no permitida.");
  const git = async (...args: string[]) =>
    (
      await exec(
        "git",
        ["-c", "core.hooksPath=" + path.resolve(".daedalus/empty-hooks"), ...args],
        { cwd: target, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.trim();
  try {
    await git("rev-parse", "--git-dir");
  } catch {
    await git("init");
    await git("remote", "add", "origin", source.repository + ".git");
  }
  let current = "";
  try {
    current = await git("rev-parse", "HEAD");
  } catch {
    /* initial checkout */
  }
  if (current !== source.revision) {
    const changes = await git("status", "--porcelain");
    if (changes.split("\n").some((l) => l && l !== "?? .daedalus-revision"))
      throw new Error(
        `Hay cambios locales en ${source.id}; consérvalos antes de actualizar.`,
      );
    await git("fetch", "--depth=1", "origin", source.revision);
    await git("checkout", "--detach", source.revision);
  }
  await writeFile(path.join(target, ".daedalus-revision"), source.revision + "\n");
  console.log(
    `${source.id} @ ${source.revision.slice(0, 12)} · recursos originales conservados`,
  );
  if (process.argv.includes("--upload")) {
    const server = process.env.DAEDALUS_SERVER_URL,
      token = process.env.DAEDALUS_CONNECTOR_TOKEN;
    if (!server?.startsWith("https://") || !token)
      throw new Error(
        "Define DAEDALUS_SERVER_URL (HTTPS) y DAEDALUS_CONNECTOR_TOKEN para subir recursos a R2.",
      );
    const walk = async (dir: string): Promise<string[]> => {
      const files: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (
          entry.name === ".git" ||
          entry.name === ".daedalus-revision" ||
          entry.isSymbolicLink()
        )
          continue;
        const f = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(f)));
        else if (
          /\.(md|txt|json|css|js|mjs|ts|tsx)$/.test(entry.name) ||
          /LICENSE|NOTICE/i.test(entry.name)
        )
          files.push(f);
      }
      return files;
    };
    for (const file of await walk(target)) {
      const content = await readFile(file, "utf8");
      if (Buffer.byteLength(content) > 400000) continue;
      const relative = path.relative(target, file).split(path.sep).join("/");
      const response = await fetch(server.replace(/\/$/, "") + "/api/skill-resources", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          ...(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
            ? {
                "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
                "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
              }
            : {}),
        },
        body: JSON.stringify({
          source: source.id,
          revision: source.revision,
          path: relative,
          content,
        }),
      });
      if (!response.ok)
        throw new Error(
          `No se pudo subir ${source.id}/${relative}: ${response.status}`,
        );
    }
  }
}
