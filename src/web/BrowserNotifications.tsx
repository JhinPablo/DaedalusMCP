import { useEffect, useRef, useState } from "react";
import type { Workspace } from "../shared/model";
import { readLocal, writeLocal } from "./persistence";
import { workspaceNotices } from "./notifications";

export function BrowserNotifications({
  state,
  openSession,
}: {
  state: Workspace | null;
  openSession: (id: string) => void;
}) {
  const supported = typeof Notification !== "undefined" && window.isSecureContext;
  const [enabled, setEnabled] = useState(() =>
    readLocal("notifications-enabled", false),
  );
  const [permission, setPermission] = useState(
    supported ? Notification.permission : "denied",
  );
  const [error, setError] = useState("");
  const seen = useRef(new Set<string>(readLocal<string[]>("notification-seen", [])));
  const initialized = useRef(false);
  const navigate = useRef(openSession);
  navigate.current = openSession;
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (
        event.data?.type === "daedalus-open-session" &&
        typeof event.data.sessionId === "string"
      )
        navigate.current(event.data.sessionId);
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);
  useEffect(() => {
    if (!state) return;
    const notices = workspaceNotices(state);
    // Seed historical completions once. Pending permissions remain actionable on opt-in.
    if (!initialized.current) {
      for (const notice of notices)
        if (!notice.id.startsWith("permission:")) seen.current.add(notice.id);
      initialized.current = true;
    }
    if (!enabled || !supported || permission !== "granted") {
      for (const notice of notices)
        if (!notice.id.startsWith("permission:")) seen.current.add(notice.id);
      return;
    }
    let disposed = false;
    void (async () => {
      let registration: ServiceWorkerRegistration | undefined;
      if ("serviceWorker" in navigator) {
        try {
          await navigator.serviceWorker.register("/notifications-sw.js", {
            scope: "/",
          });
          registration = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise<undefined>((resolve) => setTimeout(resolve, 5000)),
          ]);
        } catch {
          /* Desktop fallback below. */
        }
      }
      for (const notice of notices) {
        if (disposed || seen.current.has(notice.id)) continue;
        seen.current.add(notice.id);
        const options = {
          body: notice.body,
          tag: notice.id,
          data: { sessionId: notice.sessionId },
        };
        try {
          if (registration) await registration.showNotification(notice.title, options);
          else {
            const notification = new Notification(notice.title, options);
            notification.onclick = () => {
              window.focus();
              if (notice.sessionId) navigate.current(notice.sessionId);
              notification.close();
            };
          }
        } catch {
          setError(
            "El navegador no pudo mostrar el aviso. Revisa sus permisos y ajustes de notificaciones.",
          );
        }
      }
      writeLocal("notification-seen", [...seen.current].slice(-500));
    })();
    return () => {
      disposed = true;
    };
  }, [state, enabled, supported, permission]);
  async function toggle() {
    setError("");
    if (enabled && permission === "granted") {
      setEnabled(false);
      writeLocal("notifications-enabled", false);
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      const allow = result === "granted";
      setEnabled(allow);
      writeLocal("notifications-enabled", allow);
    } catch {
      setError("No se pudo solicitar el permiso de notificaciones.");
    }
  }
  return (
    <div className="browser-notifications">
      <button
        type="button"
        disabled={!supported || permission === "denied"}
        onClick={() => void toggle()}
        aria-pressed={enabled && permission === "granted"}
      >
        {enabled && permission === "granted"
          ? "Pausar avisos"
          : "Activar notificaciones"}
      </button>
      <small>
        {!supported
          ? "Este navegador no admite avisos. En iPhone, añade Daedalus a la pantalla de inicio."
          : permission === "denied"
            ? "Notificaciones bloqueadas: habilítalas en los ajustes del sitio."
            : "Avisos de permisos, tareas y previews mientras Daedalus esté abierto. En iPhone, úsalo desde la pantalla de inicio."}
      </small>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
