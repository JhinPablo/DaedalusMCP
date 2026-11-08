import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
export async function artifactDigest(root: string) {
  const files: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("No se admiten enlaces en artefactos.");
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile())
        files.push(path.relative(root, file).split(path.sep).join("/"));
    }
  }
  await walk(root);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
