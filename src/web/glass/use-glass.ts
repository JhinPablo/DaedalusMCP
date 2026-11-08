import { useEffect } from "react";
import { attachLens } from "./lens";
import { materialForBackground } from "./material";

export function useGlassSurfaces(theme: "light" | "dark") {
  useEffect(() => {
    // These three existing surfaces now sit directly over the animated scene.
    // Content panes, controls, permissions, errors and the animated mobile drawer stay solid.
    const surfaces = [
      ...document.querySelectorAll<HTMLElement>(".sheet, .sidebar, .topbar"),
    ];
    const material = materialForBackground(null, theme);
    for (const surface of surfaces) {
      surface.dataset.glass = theme === "dark" ? "dark" : "clear";
      surface.dataset.glassSampling = "live-background-theme-fallback";
      surface.style.setProperty("--glass-density", String(material.density));
    }
    const cleanup = surfaces
      .filter((s) => s.classList.contains("sheet"))
      .map(attachLens);
    return () => {
      cleanup.forEach((fn) => fn());
      for (const surface of surfaces) {
        delete surface.dataset.glass;
        delete surface.dataset.glassSampling;
        surface.style.removeProperty("--glass-density");
      }
    };
  }, [theme]);
}
