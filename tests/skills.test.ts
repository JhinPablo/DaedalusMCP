import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalSkillFiles,
  prepareSkillContext,
  type SkillEntry,
} from "../src/connector/skills";
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    if (
      !path
        .resolve(folder)
        .startsWith(path.join(path.resolve(tmpdir()), "daedalus-skills-"))
    )
      throw new Error("Unsafe fixture cleanup");
    await rm(folder, { recursive: true, force: true });
  }
});
async function fixture(main: string, resource?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "daedalus-skills-"));
  folders.push(root);
  const directory = path.join(root, "source");
  const skillDir = path.join(directory, "skills", "sample");
  await mkdir(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  await writeFile(file, main);
  if (resource) await writeFile(path.join(skillDir, "reference.md"), resource);
  const entry: SkillEntry = {
    id: "source:sample",
    file,
    directory,
    description: "Prueba de carga",
    revision: "fixed-revision",
  };
  return entry;
}
it("incluye instrucciones completas una sola vez y difiere referencias voluminosas", async () => {
  const entry = await fixture(
    "INSTRUCCIONES_COMPLETAS\n[Referencia](reference.md)",
    "RECURSO_ENORME".repeat(30000),
  );
  const result = await prepareSkillContext([entry], [entry.id, entry.id]);
  expect(result).toContain("INSTRUCCIONES_COMPLETAS");
  expect(result).toContain(path.join(path.dirname(entry.file), "reference.md"));
  expect(result).not.toContain("RECURSO_ENORME");
  expect(result.match(/INSTRUCCIONES_COMPLETAS/g)).toHaveLength(1);
  expect(result.length).toBeLessThan(60000);
});
it("conserva instrucciones demasiado grandes en disco y exige leerlas, sin truncarlas", async () => {
  const entry = await fixture("INSTRUCCIONES".repeat(10000));
  const result = await prepareSkillContext([entry], [entry.id], 2000);
  expect(result).toContain("Carga diferida");
  expect(result).toContain(entry.file);
  expect(result).not.toContain("INSTRUCCIONESINSTRUCCIONES");
  expect(result.length).toBeLessThan(2000);
});
it("rechaza skills desconocidas y referencias que salen de su fuente", async () => {
  const entry = await fixture("[Fuera](../../../outside.md)");
  const external = path.join(path.dirname(entry.directory), "outside.md");
  await writeFile(external, "No cargar");
  try {
    await expect(prepareSkillContext([entry], ["unknown"])).rejects.toThrow(
      "no registrada",
    );
    await expect(prepareSkillContext([entry], [entry.id])).rejects.toThrow(
      "fuera de la fuente",
    );
  } finally {
    await rm(external, { force: true });
  }
});
it("excluye fixtures y prefiere la distribución canónica de las skills", () => {
  expect(
    canonicalSkillFiles([
      "tests/oracle/.agents/skills/x/SKILL.md",
      ".claude/skills/x/SKILL.md",
      "skills/x/SKILL.md",
      ".agents/skills/x/SKILL.md",
      "README.md",
    ]),
  ).toEqual([
    ".agents/skills/x/SKILL.md",
    "skills/x/SKILL.md",
    ".claude/skills/x/SKILL.md",
  ]);
});
