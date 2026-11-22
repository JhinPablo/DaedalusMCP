import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import {
  usageSnapshotSchema,
  type UsageSnapshot,
  type UsageWindow,
} from "../shared/model";

const exec = promisify(execFile);
export const openCodeUsageUrl = "https://opencode.ai/inference/go/v1/usage";
const refreshClientId = "opencode-cli";

const rawWindow = z.object({
  status: z.string().min(1).max(40),
  percent: z.number().finite().min(0).max(100),
  resetsAt: z.string().min(1).max(80),
});
const rawUsage = z.object({
  usage: z.object({
    rolling: rawWindow,
    weekly: rawWindow,
    monthly: rawWindow,
  }),
});
type RawUsage = z.infer<typeof rawUsage>;

const authEntry = z
  .object({
    type: z.string().optional(),
    methodID: z.string().optional(),
    access: z.string().optional(),
    key: z.string().optional(),
    refresh: z.string().optional(),
    expires: z.number().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
type AuthEntry = z.infer<typeof authEntry>;
type AuthFile = Record<string, AuthEntry>;
type LiveAuthEntry = AuthEntry & { access: string };
function providerAuth(auth: AuthFile, preferred: string) {
  const entry = auth[preferred];
  const provider = entry?.access || entry?.key ? preferred : "opencode-go";
  return { provider, entry: auth[provider] };
}

class UsageHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

async function readAuth(file: string): Promise<AuthFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      "No se encontró la credencial local de OpenCode. Inicia sesión con `npm run opencode:login`.",
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("La credencial local de OpenCode no contiene JSON válido.");
  }
  const parsed = z.record(z.string(), authEntry).safeParse(data);
  if (!parsed.success)
    throw new Error("La credencial local de OpenCode no tiene un formato válido.");
  return parsed.data;
}

async function writeAuth(file: string, auth: AuthFile) {
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

async function refreshCredential(
  file: string,
  provider: string,
  entry: AuthEntry,
  fetchImpl: typeof fetch,
): Promise<LiveAuthEntry> {
  if (!entry.refresh)
    throw new Error(
      "La credencial de OpenCode no incluye un token de renovación. Vuelve a iniciar sesión con `npm run opencode:login`.",
    );
  const server =
    typeof entry.metadata?.server === "string"
      ? entry.metadata.server.replace(/\/$/, "")
      : "https://opencode.ai/console";
  if (new URL(server).origin !== "https://opencode.ai")
    throw new Error("El servidor de renovación debe pertenecer a OpenCode Go.");
  if (server !== "https://opencode.ai/console")
    throw new Error(
      "La renovación de OpenCode Go requiere el servidor oficial de Console.",
    );
  const response = await fetchImpl(server + "/auth/device/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: entry.refresh,
      client_id: refreshClientId,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(
      `No se pudo renovar la credencial de OpenCode (${response.status}). Vuelve a iniciar sesión.`,
    );
  }
  const data = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1).optional(),
      expires_in: z.number().positive(),
    })
    .parse(await response.json());
  const updated: LiveAuthEntry = {
    ...entry,
    access: data.access_token,
    refresh: data.refresh_token ?? entry.refresh,
    expires: Date.now() + data.expires_in * 1000,
  };
  const auth = await readAuth(file);
  auth[provider] = updated;
  await writeAuth(file, auth);
  return updated;
}

async function requestUsage(access: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(openCodeUsageUrl, {
    headers: { Authorization: "Bearer " + access, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new UsageHttpError(
      response.status,
      `OpenCode Go (${response.status}): no se pudo consultar el uso.`,
    );
  }
  return rawUsage.parse(await response.json());
}

function normalizeWindow(raw: z.infer<typeof rawWindow>): UsageWindow {
  const usedPercent = Math.max(0, Math.min(100, raw.percent));
  return {
    status: raw.status,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: raw.resetsAt,
  };
}

export function normalizeUsage(raw: RawUsage): NonNullable<UsageSnapshot["windows"]> {
  return {
    rolling: normalizeWindow(raw.usage.rolling),
    weekly: normalizeWindow(raw.usage.weekly),
    monthly: normalizeWindow(raw.usage.monthly),
  };
}

export function usageLimit(snapshot?: UsageSnapshot) {
  if (!snapshot?.windows) return undefined;
  const labels = { rolling: "5 horas", weekly: "semanal", monthly: "mensual" } as const;
  for (const key of ["rolling", "weekly", "monthly"] as const) {
    const window = snapshot.windows[key];
    if (window.status === "ok" && window.usedPercent < 100) continue;
    if (Date.parse(window.resetsAt) > Date.now())
      return { window: key, label: labels[key], resetsAt: window.resetsAt };
  }
  return undefined;
}

export class UsageReporter {
  private synchronizedAccess?: string;
  constructor(
    private authFile: string,
    private snapshotFile: string,
    private provider = "opencode",
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async synchronize(
    install: (provider: string, credential: Record<string, unknown>) => Promise<void>,
  ) {
    const auth = await readAuth(this.authFile);
    const { entry } = providerAuth(auth, this.provider);
    const token = entry?.access ?? entry?.key;
    if (!token) throw new Error("Falta la credencial local de OpenCode Go.");
    if (this.synchronizedAccess === token) return;
    await install(this.provider, entry);
    this.synchronizedAccess = token;
  }
  async load(): Promise<UsageSnapshot | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.snapshotFile, "utf8"));
      const parsed = usageSnapshotSchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  private async save(snapshot: UsageSnapshot) {
    const tmp = this.snapshotFile + ".tmp";
    await writeFile(tmp, JSON.stringify(snapshot, null, 2));
    await rename(tmp, this.snapshotFile);
  }
  async report(): Promise<UsageSnapshot> {
    const lastAttemptAt = new Date().toISOString();
    try {
      const auth = await readAuth(this.authFile);
      const { provider, entry: stored } = providerAuth(auth, this.provider);
      const access = stored?.access ?? stored?.key;
      if (!access)
        throw new Error(
          `No hay una credencial de OpenCode para el proveedor ${this.provider}. Inicia sesión con \`npm run opencode:login\`.`,
        );
      let entry: LiveAuthEntry = { ...stored, access };
      if (entry.expires && entry.expires <= Date.now() + 60_000)
        entry = await refreshCredential(this.authFile, provider, entry, this.fetchImpl);
      let usage: RawUsage;
      try {
        usage = await requestUsage(entry.access, this.fetchImpl);
      } catch (error) {
        if (
          error instanceof UsageHttpError &&
          [401, 403].includes(error.status) &&
          entry.refresh
        ) {
          entry = await refreshCredential(
            this.authFile,
            provider,
            entry,
            this.fetchImpl,
          );
          usage = await requestUsage(entry.access, this.fetchImpl);
        } else throw error;
      }
      const snapshot: UsageSnapshot = {
        connected: true,
        updatedAt: lastAttemptAt,
        lastAttemptAt,
        windows: normalizeUsage(usage),
      };
      await this.save(snapshot);
      return snapshot;
    } catch (error) {
      const last = await this.load();
      return {
        connected: false,
        updatedAt: last?.updatedAt ?? lastAttemptAt,
        lastAttemptAt,
        error: errorMessage(error),
        windows: last?.windows ?? null,
        local: last?.local,
      };
    }
  }
}

const localStats = z.object({
  sessions: z.number().optional(),
  prompts: z.number().optional(),
  cost: z.number().optional(),
  tokens: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      reasoning: z.number().optional(),
      cache: z.object({ read: z.number().optional() }).optional(),
    })
    .optional(),
  models: z
    .array(
      z.object({
        model: z.object({
          id: z.string(),
          providerID: z.string(),
          variant: z.string().optional(),
        }),
        steps: z.number().optional(),
        cost: z.number().optional(),
      }),
    )
    .optional(),
});

export async function localConsumption(
  command?: string,
): Promise<UsageSnapshot["local"] | undefined> {
  if (!command) return undefined;
  try {
    const { stdout } = await exec(
      command,
      ["stats", "--json", "--cost", "--limit", "5"],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const text = stdout.trim();
    const start = text.indexOf("{"),
      end = text.lastIndexOf("}");
    if (start < 0 || end < start) return undefined;
    const data = localStats.parse(JSON.parse(text.slice(start, end + 1)));
    return {
      sessions: data.sessions ?? 0,
      prompts: data.prompts ?? 0,
      cost: data.cost ?? 0,
      tokens: {
        input: data.tokens?.input ?? 0,
        output: data.tokens?.output ?? 0,
        reasoning: data.tokens?.reasoning ?? 0,
        cacheRead: data.tokens?.cache?.read ?? 0,
      },
      models: (data.models ?? []).map((entry) => ({
        id: entry.model.id,
        providerID: entry.model.providerID,
        variant: entry.model.variant,
        steps: entry.steps ?? 0,
        cost: entry.cost ?? 0,
      })),
    };
  } catch {
    return undefined;
  }
}
