import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { readLocal, writeLocal } from "./persistence";
import {
  connectGlassPreferences,
  readGlassIntensity,
  writeGlassIntensity,
} from "./glass-preferences";

export type ThemePreference = "system" | "light" | "dark";
function preference(): ThemePreference {
  const saved = readLocal<ThemePreference>("theme", "system");
  return ["system", "light", "dark"].includes(saved) ? saved : "system";
}
function resolveTheme(theme: ThemePreference): "light" | "dark" {
  return theme === "system"
    ? matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : theme;
}
export function initializeAppearance() {
  document.documentElement.dataset.theme = resolveTheme(preference());
  for (const theme of ["light", "dark"] as const)
    document.documentElement.style.setProperty(
      `--glass-intensity-${theme}`,
      String(readGlassIntensity(theme)),
    );
}
export function Appearance() {
  const [theme, setTheme] = useState(preference);
  const [resolved, setResolved] = useState(() => resolveTheme(theme));
  const [light, setLight] = useState(() => readGlassIntensity("light"));
  const [dark, setDark] = useState(() => readGlassIntensity("dark"));
  const [motion, setMotion] = useState(() => readLocal("background-motion", true));
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [solid, setSolid] = useState(
    () => matchMedia("(prefers-reduced-transparency: reduce)").matches,
  );
  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)"),
      transparency = matchMedia("(prefers-reduced-transparency: reduce)");
    const update = () => {
      setReduced(motion.matches);
      setSolid(transparency.matches);
    };
    motion.addEventListener("change", update);
    transparency.addEventListener("change", update);
    return () => {
      motion.removeEventListener("change", update);
      transparency.removeEventListener("change", update);
    };
  }, []);
  useEffect(() => connectGlassPreferences(), []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const next = resolveTheme(theme);
      document.documentElement.dataset.theme = next;
      setResolved(next);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const sync = () => {
      setTheme(preference());
      setLight(readGlassIntensity("light"));
      setDark(readGlassIntensity("dark"));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  function choose(next: ThemePreference) {
    setTheme(next);
    writeLocal("theme", next);
  }
  return (
    <details className="appearance-menu">
      <summary aria-label="Apariencia" title="Apariencia">
        {resolved === "dark" ? <Moon size={17} /> : <Sun size={17} />}
      </summary>
      <div className="appearance-settings">
        <h2>Apariencia</h2>
        <label>
          Tema
          <select
            aria-label="Tema"
            value={theme}
            onChange={(e) => choose(e.target.value as ThemePreference)}
          >
            <option value="system">Seguir al sistema</option>
            <option value="light">Claro</option>
            <option value="dark">Oscuro</option>
          </select>
        </label>
        <label>
          Intensidad del vidrio · claro <output>{light.toFixed(1)}</output>
          <input
            aria-label="Intensidad del vidrio en modo claro"
            type="range"
            min="0"
            max="1.5"
            step="0.1"
            value={light}
            onChange={(e) =>
              setLight(writeGlassIntensity("light", Number(e.target.value)))
            }
          />
        </label>
        <label>
          Intensidad del vidrio · oscuro <output>{dark.toFixed(1)}</output>
          <input
            aria-label="Intensidad del vidrio en modo oscuro"
            type="range"
            min="0"
            max="1.5"
            step="0.1"
            value={dark}
            onChange={(e) =>
              setDark(writeGlassIntensity("dark", Number(e.target.value)))
            }
          />
        </label>
        <label className="motion-setting">
          <input
            type="checkbox"
            disabled={reduced}
            checked={motion}
            onChange={(event) => {
              const next = event.target.checked;
              setMotion(next);
              writeLocal("background-motion", next);
              window.dispatchEvent(new Event("daedalus:appearance"));
            }}
          />{" "}
          Animar fondo
        </label>
        {reduced && (
          <p>
            El sistema tiene activado «reducir movimiento». El fondo permanece quieto.
          </p>
        )}
        {solid && (
          <p>
            El sistema tiene activado «reducir transparencia». Las superficies
            permanecen sólidas.
          </p>
        )}
        <p>
          Los temas guardan ajustes independientes. El vidrio se aplica a superficies
          sobre fondos visuales; los paneles de lectura permanecen sólidos.
        </p>
      </div>
    </details>
  );
}
