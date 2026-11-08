import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { inside } from "./config";
const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  return (
    await exec(
      "git",
      ["-c", "core.hooksPath=" + path.resolve(".daedalus/empty-hooks"), ...args],
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    )
  ).stdout.trim();
}
export class Worktrees {
  constructor(
    private root: string,
    private storage: string,
  ) {}
  async baseline() {
    const actual = await realpath(this.root);
    if (actual !== this.root) throw new Error("Cambió la ruta del proyecto.");
    if (await git(this.root, "status", "--porcelain"))
      throw new Error(
        "El proyecto tiene cambios sin guardar en Git. Crea un commit o conserva esos cambios antes de ejecutar; Daedalus no los modificará.",
      );
    return git(this.root, "rev-parse", "HEAD");
  }
  async prepare(runId: string, base: string, branches: string[]) {
    const target = path.resolve(this.storage, runId);
    if (!inside(path.resolve(this.storage), target))
      throw new Error("Ruta de worktree fuera del directorio permitido.");
    await mkdir(path.dirname(target), { recursive: true });
    const branch = "daedalus/" + runId;
    await git(this.root, "worktree", "add", "-b", branch, target, base);
    for (const dependency of branches) {
      try {
        await git(
          target,
          "-c",
          "user.name=Daedalus",
          "-c",
          "user.email=daedalus@localhost",
          "merge",
          "--no-edit",
          "--no-ff",
          dependency,
        );
      } catch {
        throw new Error(
          `Conflicto al integrar ${dependency}. El worktree se conserva para revisión; no se resolverá automáticamente.`,
        );
      }
    }
    return { worktree: target, branch };
  }
  async finish(worktree: string) {
    const status = await git(worktree, "status", "--porcelain");
    if (status) {
      await git(worktree, "add", "--all");
      await git(
        worktree,
        "-c",
        "user.name=Daedalus",
        "-c",
        "user.email=daedalus@localhost",
        "commit",
        "-m",
        "Daedalus: tarea aprobada",
      );
    }
    return {
      changes: status
        ? await git(worktree, "show", "--stat", "--oneline", "HEAD")
        : "No se generaron cambios nuevos en esta tarea.",
    };
  }
}
