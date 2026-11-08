import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  SqliteRepository,
  SqliteBlobs,
  MAX_ARTIFACT_BYTES,
} from "../src/worker/storage";
import { emptyWorkspace } from "../src/shared/model";
function fixture() {
  const db = new DatabaseSync(":memory:");
  let writes = 0;
  const storage = {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        if (/^(INSERT|UPDATE|DELETE)/.test(query)) writes++;
        const rows = db.prepare(query).all(...(bindings as Array<string | number>));
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as Pick<DurableObjectStorage, "sql" | "transactionSync">;
  return {
    db,
    storage,
    get writes() {
      return writes;
    },
  };
}
it("persiste únicamente las entidades modificadas y reconstruye Unicode grande", () => {
  const f = fixture();
  try {
    const repo = new SqliteRepository(f.storage),
      state = emptyWorkspace();
    state.projects.push({
      id: "p",
      name: "Proyecto",
      rootLabel: "p",
      connectorId: "device",
      createdAt: new Date().toISOString(),
    });
    repo.write(state);
    const writes = f.writes;
    repo.write(structuredClone(state));
    expect(f.writes).toBe(writes);
    state.connectors.push({
      id: "device",
      name: "Equipo",
      lastSeen: new Date().toISOString(),
      codex: true,
      opencode: false,
    });
    repo.write(state);
    expect(f.writes - writes).toBe(1);
    state.events.push({
      id: "large",
      at: new Date().toISOString(),
      type: "test",
      message: "🛠️ Unicode ".repeat(15000),
    });
    repo.write(state);
    const restored = new SqliteRepository(f.storage).read();
    expect(restored.events[0].message).toBe(state.events[0].message);
    expect(restored.projects).toEqual(state.projects);
  } finally {
    f.db.close();
  }
});
it("limita artefactos por bytes y conserva los anteriores al rechazar un exceso", async () => {
  const f = fixture();
  try {
    const blobs = new SqliteBlobs(f.storage);
    await blobs.put("small", "Informe");
    await expect(blobs.put("big", "🛠".repeat(MAX_ARTIFACT_BYTES / 2))).rejects.toThrow(
      "512 KiB",
    );
    expect(await blobs.get("small")).toBe("Informe");
    expect(await blobs.get("big")).toBeNull();
  } finally {
    f.db.close();
  }
});
