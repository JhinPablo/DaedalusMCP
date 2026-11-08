import { emptyWorkspace, normalizeWorkspace, type Workspace } from "../shared/model";
import type { Repository, BlobStore } from "../server/service";
import { DomainError } from "../shared/engine";

const collections = [
  "projects",
  "sessions",
  "runs",
  "permissions",
  "artifacts",
  "events",
  "connectors",
  "credentials",
  "releases",
] as const;
function records(state: Workspace) {
  const result = new Map<string, string>();
  result.set(
    "meta",
    JSON.stringify({
      schemaVersion: 1,
      revision: state.revision,
      migrationId: state.migrationId,
    }),
  );
  for (const field of collections)
    state[field].forEach((entity, order) => {
      const text = JSON.stringify(entity);
      let offset = 0,
        part = 0;
      while (offset < text.length) {
        let end = Math.min(offset + 24000, text.length);
        const code = text.charCodeAt(end - 1);
        if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
        result.set(
          `${field}/${entity.id}/${part++}`,
          JSON.stringify({ order, text: text.slice(offset, end) }),
        );
        offset = end;
      }
    });
  return result;
}
export class SqliteRepository implements Repository {
  private snapshot?: Workspace;
  private previous = new Map<string, string>();
  constructor(private storage: Pick<DurableObjectStorage, "sql" | "transactionSync">) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS workspace_records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  read(): Workspace {
    if (this.snapshot) return this.snapshot;
    const rows = this.storage.sql
      .exec<{ key: string; value: string }>("SELECT key,value FROM workspace_records")
      .toArray();
    if (rows.length) {
      this.previous = new Map(rows.map((row) => [row.key, row.value]));
      const state = emptyWorkspace();
      Object.assign(state, JSON.parse(this.previous.get("meta") ?? "{}"));
      for (const field of collections) {
        const entities = new Map<
          string,
          { order: number; parts: Array<{ part: number; text: string }> }
        >();
        for (const row of rows) {
          const [kind, id, part] = row.key.split("/");
          if (kind !== field) continue;
          const value = JSON.parse(row.value) as { order: number; text: string };
          const entity = entities.get(id) ?? { order: value.order, parts: [] };
          entity.parts.push({ part: Number(part), text: value.text });
          entities.set(id, entity);
        }
        Object.assign(state, {
          [field]: [...entities.values()]
            .sort((a, b) => a.order - b.order)
            .map((entity) =>
              JSON.parse(
                entity.parts
                  .sort((a, b) => a.part - b.part)
                  .map((p) => p.text)
                  .join(""),
              ),
            ),
        });
      }
      this.snapshot = normalizeWorkspace(state);
      return this.snapshot;
    }
    const tables = this.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .toArray()
      .map((t) => t.name);
    let legacy: Workspace | undefined;
    if (tables.includes("workspace_parts")) {
      const parts = this.storage.sql
        .exec<{ value: string }>("SELECT value FROM workspace_parts ORDER BY id")
        .toArray();
      if (parts.length) legacy = JSON.parse(parts.map((p) => p.value).join(""));
    }
    if (!legacy && tables.includes("workspace")) {
      const row = this.storage.sql
        .exec<{ value: string }>("SELECT value FROM workspace WHERE id=1")
        .toArray()[0];
      if (row) legacy = JSON.parse(row.value);
    }
    this.snapshot = normalizeWorkspace(legacy ?? emptyWorkspace());
    if (legacy) this.write(this.snapshot);
    return this.snapshot;
  }
  write(state: Workspace) {
    const next = records(normalizeWorkspace(state));
    this.storage.transactionSync(() => {
      for (const key of this.previous.keys())
        if (!next.has(key))
          this.storage.sql.exec("DELETE FROM workspace_records WHERE key=?", key);
      for (const [key, value] of next)
        if (this.previous.get(key) !== value)
          this.storage.sql.exec(
            "INSERT INTO workspace_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            key,
            value,
          );
    });
    this.previous = next;
    this.snapshot = state;
  }
}
export const MAX_ARTIFACT_BYTES = 512 * 1024,
  MAX_ARTIFACT_STORAGE = 50 * 1024 * 1024;
export class SqliteBlobs implements BlobStore {
  constructor(private storage: Pick<DurableObjectStorage, "sql" | "transactionSync">) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS artifact_blobs(key TEXT PRIMARY KEY,value TEXT NOT NULL,size INTEGER NOT NULL)",
    );
  }
  async put(key: string, value: string) {
    const size = new TextEncoder().encode(value).byteLength;
    if (size > MAX_ARTIFACT_BYTES)
      throw new DomainError(413, "Artefacto mayor de 512 KiB; se conserva localmente.");
    this.storage.transactionSync(() => {
      const total = this.storage.sql
        .exec<{ size: number }>(
          "SELECT COALESCE(SUM(size),0) AS size FROM artifact_blobs WHERE key<>?",
          key,
        )
        .toArray()[0].size;
      if (total + size > MAX_ARTIFACT_STORAGE)
        throw new DomainError(
          507,
          "Almacenamiento de artefactos completo; se conserva localmente.",
        );
      this.storage.sql.exec(
        "INSERT INTO artifact_blobs(key,value,size) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,size=excluded.size",
        key,
        value,
        size,
      );
    });
  }
  async get(key: string) {
    return (
      this.storage.sql
        .exec<{ value: string }>("SELECT value FROM artifact_blobs WHERE key=?", key)
        .toArray()[0]?.value ?? null
    );
  }
}
