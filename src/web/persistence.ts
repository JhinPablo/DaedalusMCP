import { useCallback, useState, type SetStateAction } from "react";
const prefix = "daedalus:v1:";
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(prefix + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(prefix + key);
    else localStorage.setItem(prefix + key, JSON.stringify(value));
  } catch {
    /* Storage may be disabled; keep the in-memory draft. */
  }
}
export function useLocalText(key: string) {
  const [saved, setSaved] = useState(() => ({ key, value: readLocal(key, "") }));
  const value = saved.key === key ? saved.value : readLocal(key, "");
  const set = useCallback(
    (next: SetStateAction<string>) => {
      setSaved((previous) => {
        const value =
          typeof next === "function"
            ? next(previous.key === key ? previous.value : readLocal(key, ""))
            : next;
        writeLocal(key, value);
        return { key, value };
      });
    },
    [key],
  );
  return [value, set] as const;
}
