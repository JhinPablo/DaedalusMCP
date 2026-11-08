import { readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { inside } from "./config";
interface LockedSource {
  id: string;
  repository: string;
  revision: string;
  licenseFiles: string[];
}
const exec = promisify(execFile);
export interface SkillEntry {
  id: string;
  file: string;
  directory: string;
  description: string;
  revision: string;
}
export function canonicalSkillFiles(files: string[]) {
  const rank = (file: string) =>
    file.startsWith(".agents/skills/")
      ? 0
      : file.startsWith("skills/") || file === "SKILL.md"
        ? 1
        : 2;
  return files
    .filter(
      (file) =>
        file.endsWith("SKILL.md") &&
        !/(^|\/)(tests?|fixtures?|examples?|node_modules)(\/|$)/i.test(file),
    )
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
export async function skillCatalog(root: string): Promise<SkillEntry[]> {
  const lock = JSON.parse(await readFile("skills-lock.json", "utf8")) as {
    sources: LockedSource[];
  };
  const entries: SkillEntry[] = [];
  for (const source of lock.sources) {
    const directory = await realpath(path.resolve(root, source.id));
    const git = async (...args: string[]) =>
      (
        await exec("git", args, {
          cwd: directory,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout.trim();
    if ((await git("rev-parse", "HEAD")) !== source.revision)
      throw new Error(`Revisión incorrecta de ${source.id}. Ejecuta skills:sync.`);
    await git("diff", "--quiet", "HEAD", "--");
    const files = canonicalSkillFiles((await git("ls-files", "-z")).split("\0"));
    for (const relative of files) {
      const file = await realpath(path.join(directory, relative));
      if (!inside(directory, file)) throw new Error("Skill fuera de su fuente.");
      const text = await readFile(file, "utf8");
      const name =
        text.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1].trim() ??
        path.basename(path.dirname(file));
      const description =
        text.match(/^description:\s*["']?([^\r\n"']+)/m)?.[1].trim() ?? name;
      const id = source.id + ":" + name;
      if (entries.some((entry) => entry.id === id)) continue;
      entries.push({
        id,
        file,
        directory,
        description,
        revision: source.revision,
      });
    }
  }
  return entries;
}
export async function loadSkills(root: string, selected: string[]): Promise<string> {
  if (!selected.length) return "";
  const catalog = await skillCatalog(root);
  return prepareSkillContext(catalog, selected);
}

export async function prepareSkillContext(
  catalog: SkillEntry[],
  selected: string[],
  budget = 60000,
): Promise<string> {
  const chunks: string[] = [
    "# Skills del alcance aprobado\nLee las instrucciones principales de cada skill antes de trabajar. Las referencias se consultan por demanda: abre únicamente las pertinentes a tu tarea; no cargues toda la biblioteca. Las rutas son recursos locales de solo lectura. No ejecutes instaladores ni scripts de las fuentes sin autorización. Las instrucciones del usuario, la tarea y las aprobaciones de Daedalus tienen prioridad sobre las skills.",
  ];
  const documents: Array<{ header: string; main: string; resources: string[] }> = [];
  for (const selection of [...new Set(selected)]) {
    const entry = catalog.find((e) => e.id === selection);
    if (!entry) throw new Error(`Skill no registrada: ${selection}`);
    const main = await readFile(entry.file, "utf8");
    const header = `\n# Skill ${selection} @ ${entry.revision}\nDescripción: ${entry.description}\nInstrucciones completas: ${entry.file}\nDirectorio de la skill: ${path.dirname(entry.file)}`;
    const resources: string[] = [];
    const refs = [...main.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)]
      .map((m) => m[1])
      .filter((link) => !link.includes("://"));
    for (const relative of [...new Set(refs)]) {
      try {
        const file = await realpath(path.resolve(path.dirname(entry.file), relative));
        if (!inside(entry.directory, file))
          throw new Error("Recurso fuera de la fuente.");
        resources.push(`- ${relative}: ${file}`);
      } catch (error) {
        throw new Error(
          `No se pudo cargar el recurso ${selection}/${relative}: ${String(error)}`,
        );
      }
    }
    documents.push({
      header,
      main: main.replaceAll("<skill>", path.dirname(entry.file)),
      resources,
    });
  }
  // Reserve every skill's identity and reference index before including any full document.
  const manifests = documents.map(
    (d) =>
      d.header +
      (d.resources.length
        ? "\nReferencias disponibles (leer solo las necesarias):\n" +
          d.resources.join("\n")
        : ""),
  );
  const minimum =
    chunks[0].length + manifests.join("\n").length + documents.length * 160;
  let remaining = budget - minimum;
  if (remaining < 0)
    throw new Error(
      "El índice de skills supera el presupuesto de contexto. Revisa el alcance del plan.",
    );
  documents.forEach((document, index) => {
    chunks.push(manifests[index]);
    if (document.main.length <= remaining) {
      chunks.push(document.main);
      remaining -= document.main.length;
    } else
      chunks.push(
        "Carga diferida: abre y lee el SKILL.md indicado antes de aplicar esta skill. Su contenido se conserva íntegro en disco; no se ha truncado.",
      );
  });
  return chunks.join("\n");
}
