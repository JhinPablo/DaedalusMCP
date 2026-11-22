import { useEffect, useState } from "react";
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export function PwaInstall() {
  const [install, setInstall] = useState<InstallEvent>();
  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallEvent);
    };
    const done = () => setInstall(undefined);
    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", done);
    };
  }, []);
  return (
    <div>
      {install ? (
        <button
          type="button"
          onClick={() =>
            void (async () => {
              await install.prompt();
              if ((await install.userChoice).outcome === "accepted")
                setInstall(undefined);
            })()
          }
        >
          Instalar Daedalus
        </button>
      ) : (
        <small>
          Para instalar: menú del navegador → Instalar aplicación. En iPhone: Compartir
          → Añadir a pantalla de inicio.
        </small>
      )}
    </div>
  );
}
