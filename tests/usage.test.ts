import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { UsageReporter, normalizeUsage, usageLimit } from "../src/connector/usage";
import type { UsageSnapshot } from "../src/shared/model";

const future = () => new Date(Date.now() + 3600000).toISOString();
const past = () => new Date(Date.now() - 3600000).toISOString();
const response = () => ({
  usage: {
    rolling: { status: "ok", percent: 12.5, resetsAt: future() },
    weekly: { status: "ok", percent: 4, resetsAt: future() },
    monthly: { status: "ok", percent: 1, resetsAt: future() },
  },
});

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "daedalus-usage-"));
}

it("normaliza porcentajes usados y restantes de las tres ventanas", () => {
  const windows = normalizeUsage(response());
  expect(windows.rolling).toMatchObject({
    usedPercent: 12.5,
    remainingPercent: 87.5,
  });
  expect(windows.weekly).toMatchObject({
    usedPercent: 4,
    remainingPercent: 96,
  });
  expect(windows.monthly).toMatchObject({
    usedPercent: 1,
    remainingPercent: 99,
  });
});

it("detecta una ventana agotada solo si su reinicio sigue en el futuro", () => {
  const snapshot = (percent: number, status: string, resetsAt: string) => ({
    connected: true,
    updatedAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    windows: {
      rolling: {
        status,
        usedPercent: percent,
        remainingPercent: 100 - percent,
        resetsAt,
      },
      weekly: {
        status: "ok",
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: future(),
      },
      monthly: {
        status: "ok",
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: future(),
      },
    },
  });
  expect(usageLimit(snapshot(100, "ok", future()))?.label).toBe("5 horas");
  expect(usageLimit(snapshot(20, "exhausted", future()))?.label).toBe("5 horas");
  expect(usageLimit(snapshot(100, "ok", past()))).toBeUndefined();
});

it("publica el uso y conserva el último dato cuando la consulta falla", async () => {
  const dir = await tempDir();
  try {
    const authFile = path.join(dir, "auth.json"),
      snapshotFile = path.join(dir, "usage.json");
    await writeFile(
      authFile,
      JSON.stringify({
        opencode: {
          type: "oauth",
          access: "token",
          expires: Date.now() + 3600000,
        },
      }),
    );
    const ok = vi.fn(async () => Response.json(response()));
    const first = await new UsageReporter(
      authFile,
      snapshotFile,
      "opencode",
      ok as unknown as typeof fetch,
    ).report();
    expect(first.connected, first.error).toBe(true);
    expect(first.windows?.rolling.usedPercent).toBe(12.5);
    expect(JSON.parse(await readFile(snapshotFile, "utf8"))).toMatchObject({
      connected: true,
      windows: first.windows,
    });

    const failed = vi.fn(async () => new Response("sin servicio", { status: 503 }));
    const second = await new UsageReporter(
      authFile,
      snapshotFile,
      "opencode",
      failed as unknown as typeof fetch,
    ).report();
    expect(second.connected).toBe(false);
    expect(second.windows).toEqual(first.windows);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.error).toContain("503");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("muestra el último dato con su fecha si falta la credencial local", async () => {
  const dir = await tempDir();
  try {
    const snapshotFile = path.join(dir, "usage.json");
    const saved: UsageSnapshot = {
      connected: true,
      updatedAt: new Date(Date.now() - 60000).toISOString(),
      lastAttemptAt: new Date(Date.now() - 60000).toISOString(),
      windows: normalizeUsage(response()),
    };
    await writeFile(snapshotFile, JSON.stringify(saved));
    const report = await new UsageReporter(
      path.join(dir, "missing.json"),
      snapshotFile,
      "opencode",
      vi.fn() as unknown as typeof fetch,
    ).report();
    expect(report.connected).toBe(false);
    expect(report.windows).toEqual(saved.windows);
    expect(report.updatedAt).toBe(saved.updatedAt);
    expect(report.error).toContain("No se encontró la credencial");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("renueva la credencial caducada antes de consultar el uso", async () => {
  const dir = await tempDir();
  try {
    const authFile = path.join(dir, "auth.json"),
      snapshotFile = path.join(dir, "usage.json");
    await writeFile(
      authFile,
      JSON.stringify({
        opencode: {
          type: "oauth",
          methodID: "device",
          access: "old",
          refresh: "refresh-old",
          expires: Date.now() - 1000,
          metadata: { server: "https://opencode.ai/console" },
        },
        otherProvider: { type: "api", key: "keep-this-key", extra: "keep-this-field" },
      }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/device/token"))
        return Response.json({
          access_token: "new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        });
      return Response.json(response());
    });
    const report = await new UsageReporter(
      authFile,
      snapshotFile,
      "opencode",
      fetchMock as unknown as typeof fetch,
    ).report();
    expect(report.connected, report.error).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const auth = JSON.parse(await readFile(authFile, "utf8"));
    expect(auth.opencode.access).toBe("new");
    expect(auth.opencode.refresh).toBe("refresh-new");
    expect(auth.opencode.expires).toBeGreaterThan(Date.now());
    expect(auth.otherProvider).toEqual({
      type: "api",
      key: "keep-this-key",
      extra: "keep-this-field",
    });
    const reporter = new UsageReporter(authFile, snapshotFile);
    const install = vi.fn(async () => {});
    await reporter.synchronize(install);
    await reporter.synchronize(install);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith(
      "opencode",
      expect.objectContaining({ access: "new" }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("lee una clave Go local y la sincroniza sin incluirla en el informe", async () => {
  const dir = await tempDir();
  try {
    const authFile = path.join(dir, "auth.json");
    await writeFile(
      authFile,
      JSON.stringify({ "opencode-go": { type: "api", key: "go-local-key" } }),
    );
    const reporter = new UsageReporter(
      authFile,
      path.join(dir, "usage.json"),
      "opencode",
      vi.fn(async () => Response.json(response())) as unknown as typeof fetch,
    );
    const result = await reporter.report();
    expect(result.connected, result.error).toBe(true);
    expect(JSON.stringify(result)).not.toContain("go-local-key");
    const install = vi.fn(async () => {});
    await reporter.synchronize(install);
    await reporter.synchronize(install);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith("opencode", {
      type: "api",
      key: "go-local-key",
    });
  } finally {
    if (!path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep))
      throw new Error("Unsafe temporary path");
    await rm(dir, { recursive: true, force: true });
  }
});
