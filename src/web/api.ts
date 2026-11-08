import { useCallback, useEffect, useState } from "react";
import type { Workspace } from "../shared/model";
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Daedalus-Panel": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "No se pudo completar la operación.");
  return data;
}
export function useWorkspace() {
  const [state, setState] = useState<Workspace | null>(null),
    [error, setError] = useState(""),
    [updateAvailable, setUpdateAvailable] = useState(false),
    [deployedBuildId, setDeployedBuildId] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const next = await request<Workspace>("/state");
      setState((old) => (old && old.revision >= next.revision ? old : next));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sin conexión.");
    }
  }, []);
  useEffect(() => {
    void refresh();
    let disposed = false,
      retries = 0,
      reconnect: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | undefined;
    const connect = () => {
      if (disposed) return;
      try {
        ws = new WebSocket(
          `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/events`,
        );
        ws.onmessage = () => void refresh();
        ws.onopen = () => {
          retries = 0;
          void refresh();
          void version();
        };
        ws.onclose = () => {
          if (!disposed)
            reconnect = setTimeout(
              connect,
              Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)),
            );
        };
      } catch {
        if (!disposed) reconnect = setTimeout(connect, 30000);
      }
    };
    const version = async () => {
      try {
        const info = await request<{ buildId: string }>("/version");
        if (!disposed) setDeployedBuildId(info.buildId);
        const current = import.meta.env.VITE_DAEDALUS_BUILD_ID ?? "local";
        if (
          !disposed &&
          current !== "local" &&
          info.buildId !== "local" &&
          current !== info.buildId
        )
          setUpdateAvailable(true);
      } catch {}
    };
    connect();
    void version();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (ws?.readyState !== WebSocket.OPEN) void refresh();
      void version();
    }, 30000);
    const visible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        if (ws?.readyState === WebSocket.CLOSED) connect();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      disposed = true;
      if (reconnect) clearTimeout(reconnect);
      document.removeEventListener("visibilitychange", visible);
      ws?.close();
    };
  }, [refresh]);
  return { state, error, refresh, updateAvailable, deployedBuildId };
}
