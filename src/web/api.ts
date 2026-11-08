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
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const next = await request<Workspace>("/state");
      setState((old) => (old?.revision === next.revision ? old : next));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sin conexión.");
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/events`,
      );
      ws.onmessage = () => void refresh();
    } catch {
      /* polling remains available */
    }
    return () => {
      clearInterval(timer);
      ws?.close();
    };
  }, [refresh]);
  return { state, error, refresh };
}
