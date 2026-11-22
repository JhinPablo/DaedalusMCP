import { useEffect, useRef, useState } from "react";
import type { Workspace } from "../shared/model";
import { readLocal, writeLocal } from "./persistence";
import { workspaceNotices } from "./notifications";
import {
  notificationTone,
  registerPwa,
  subscribePush,
  unsubscribePush,
  testPush,
} from "./pwa";
import { PwaInstall } from "./PwaInstall";
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
  const [sound, setSound] = useState(() => readLocal("notifications-sound", true));
  const [push, setPush] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const seen = useRef(new Set<string>(readLocal<string[]>("notification-seen", []))),
    initialized = useRef(false),
    navigate = useRef(openSession);
  navigate.current = openSession;
  useEffect(() => {
    if (!enabled || permission !== "granted" || !("PushManager" in window)) return;
    let disposed = false;
    void subscribePush(sound)
      .then(() => {
        if (!disposed) setPush(true);
      })
      .catch(() => {
        if (!disposed)
          setError("Push sin conexión. Reintenta al recuperar la conexión.");
      });
    return () => {
      disposed = true;
    };
  }, [enabled, permission, sound]);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (
        event.data?.type === "daedalus-open-session" &&
        typeof event.data.sessionId === "string"
      )
        navigate.current(event.data.sessionId);
      if (
        event.data?.type === "daedalus-notice" &&
        enabled &&
        sound &&
        document.visibilityState === "visible" &&
        !seen.current.has(event.data.id)
      ) {
        seen.current.add(event.data.id);
        void notificationTone().catch(() => {});
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [enabled, sound]);
  useEffect(() => {
    if (!state) return;
    const notices = workspaceNotices(state);
    if (!initialized.current) {
      for (const n of notices)
        if (!n.id.startsWith("permission:")) seen.current.add(n.id);
      initialized.current = true;
    }
    if (!enabled || !supported || permission !== "granted") {
      for (const n of notices)
        if (!n.id.startsWith("permission:")) seen.current.add(n.id);
      return;
    }
    if (push || "PushManager" in window) return;
    let disposed = false;
    void (async () => {
      let registration: ServiceWorkerRegistration | undefined;
      try {
        registration = await registerPwa();
      } catch {
        /* Desktop notification fallback. */
      }
      for (const n of notices) {
        if (disposed || seen.current.has(n.id)) continue;
        seen.current.add(n.id);
        const options = {
          body: n.body,
          tag: n.id,
          silent: !sound || document.visibilityState === "visible",
          data: { sessionId: n.sessionId },
        };
        try {
          if (registration) await registration.showNotification(n.title, options);
          else {
            const notice = new Notification(n.title, options);
            notice.onclick = () => {
              window.focus();
              if (n.sessionId) navigate.current(n.sessionId);
              notice.close();
            };
          }
          if (sound && document.visibilityState === "visible")
            void notificationTone().catch(() => {});
        } catch {
          setError("El navegador no pudo mostrar el aviso. Revisa sus permisos.");
        }
      }
      writeLocal("notification-seen", [...seen.current].slice(-500));
    })();
    return () => {
      disposed = true;
    };
  }, [state, enabled, permission, supported, push, sound]);
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      if (enabled && permission === "granted") {
        if ("PushManager" in window) await unsubscribePush();
        setEnabled(false);
        setPush(false);
        writeLocal("notifications-enabled", false);
        return;
      }
      if (sound) void notificationTone().catch(() => {});
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === "granted") {
        if ("PushManager" in window) await subscribePush(sound);
        setPush("PushManager" in window);
        setEnabled(true);
        writeLocal("notifications-enabled", true);
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "No se pudo cambiar la configuración de avisos.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="browser-notifications">
      <button
        type="button"
        disabled={busy || !supported || permission === "denied"}
        onClick={() => void toggle()}
        aria-pressed={enabled && permission === "granted"}
      >
        {enabled && permission === "granted"
          ? "Pausar avisos"
          : "Activar notificaciones"}
      </button>
      <small>
        {!supported
          ? "En iPhone, añade Daedalus a la pantalla de inicio para activar push."
          : permission === "denied"
            ? "Notificaciones bloqueadas: habilítalas en los ajustes del sitio."
            : push
              ? "Push conectado: avisos de permisos, resultados y previews incluso con el panel cerrado."
              : "Activa los avisos en este dispositivo. En iPhone instala la app en la pantalla de inicio."}
      </small>
      <label>
        <input
          type="checkbox"
          checked={sound}
          onChange={(e) => {
            setSound(e.target.checked);
            writeLocal("notifications-sound", e.target.checked);
            if (e.target.checked) void notificationTone().catch(() => {});
          }}
        />{" "}
        Sonido de notificaciones
      </label>
      <small>
        Con la app abierta se usa un tono. En segundo plano el sonido depende del
        sistema, sus permisos y el modo silencio.
      </small>
      {push && (
        <button
          type="button"
          onClick={() =>
            void testPush().catch(() =>
              setError("No se pudo enviar el aviso de prueba."),
            )
          }
        >
          Probar notificación push
        </button>
      )}
      <PwaInstall />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
