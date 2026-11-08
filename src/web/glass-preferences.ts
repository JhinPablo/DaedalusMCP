// Recovered from the completed Daedalus task, commit 57615cc.
type GlassTheme = "light" | "dark";
type GlassRoot = { style: Pick<CSSStyleDeclaration, "setProperty"> };
const glassPreferenceKey = (theme: GlassTheme) => `daedalus.glass-intensity.${theme}`;
const normalizeGlassIntensity = (value: number) =>
  Number.isFinite(value) ? Math.min(1.5, Math.max(0, value)) : 1;

export function readGlassIntensity(
  theme: GlassTheme,
  storage?: Pick<Storage, "getItem">,
): number {
  try {
    const raw = (storage ?? window.localStorage).getItem(glassPreferenceKey(theme));
    return raw === null || raw.trim() === "" ? 1 : normalizeGlassIntensity(Number(raw));
  } catch {
    return 1;
  }
}

export function writeGlassIntensity(
  theme: GlassTheme,
  value: number,
  storage?: Pick<Storage, "setItem">,
  root: GlassRoot = document.documentElement,
): number {
  const intensity = normalizeGlassIntensity(value);
  root.style.setProperty(`--glass-intensity-${theme}`, String(intensity));
  try {
    (storage ?? window.localStorage).setItem(
      glassPreferenceKey(theme),
      String(intensity),
    );
  } catch {
    // Storage may be blocked or full; the current session still gets the adjustment.
  }
  return intensity;
}

// No new settings markup: existing/future settings can dispatch this local event.
// Both inputs stay on the root, so changing data-theme never overwrites a preference.
export function connectGlassPreferences(
  root: GlassRoot = document.documentElement,
  events: EventTarget = window,
  storage?: Pick<Storage, "getItem" | "setItem">,
) {
  const restore = () => {
    for (const theme of ["light", "dark"] as const)
      root.style.setProperty(
        `--glass-intensity-${theme}`,
        String(readGlassIntensity(theme, storage)),
      );
  };
  const adjust = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail as
      { theme?: unknown; value?: unknown } | undefined;
    if (
      detail &&
      (detail.theme === "light" || detail.theme === "dark") &&
      typeof detail.value === "number"
    )
      writeGlassIntensity(detail.theme, detail.value, storage, root);
  };
  const sync = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (
      key === null ||
      key === glassPreferenceKey("light") ||
      key === glassPreferenceKey("dark")
    )
      restore();
  };
  restore();
  events.addEventListener("storage", sync);
  events.addEventListener("daedalus:glass-intensity", adjust);
  return () => {
    events.removeEventListener("storage", sync);
    events.removeEventListener("daedalus:glass-intensity", adjust);
  };
}
