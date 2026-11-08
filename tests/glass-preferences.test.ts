import { describe, expect, it } from "vitest";
import {
  readGlassIntensity,
  writeGlassIntensity,
  connectGlassPreferences,
} from "../src/web/glass-preferences";

function fixture() {
  const values = new Map<string, string>();
  const properties = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
    root: {
      style: {
        setProperty: (key: string, value: string) => {
          properties.set(key, value);
        },
      },
    },
    properties,
  };
}
describe("glass intensity preferences", () => {
  it("restores settings, accepts adjustment events and cleans up listeners", () => {
    const { root, storage, properties } = fixture();
    const events = new EventTarget();
    writeGlassIntensity("dark", 1.2, storage, root);
    properties.clear();
    const disconnect = connectGlassPreferences(root, events, storage);
    expect(properties.get("--glass-intensity-light")).toBe("1");
    expect(properties.get("--glass-intensity-dark")).toBe("1.2");
    events.dispatchEvent(
      Object.assign(new Event("daedalus:glass-intensity"), {
        detail: { theme: "light", value: 0.4 },
      }),
    );
    expect(properties.get("--glass-intensity-light")).toBe("0.4");
    expect(readGlassIntensity("light", storage)).toBe(0.4);
    events.dispatchEvent(
      Object.assign(new Event("daedalus:glass-intensity"), {
        detail: { theme: "unknown", value: 1.5 },
      }),
    );
    expect(properties.size).toBe(2);
    disconnect();
    events.dispatchEvent(
      Object.assign(new Event("daedalus:glass-intensity"), {
        detail: { theme: "light", value: 1 },
      }),
    );
    expect(properties.get("--glass-intensity-light")).toBe("0.4");
  });
  it("refreshes theme inputs when another tab updates storage", () => {
    const { root, storage, properties } = fixture();
    const events = new EventTarget();
    const disconnect = connectGlassPreferences(root, events, storage);
    storage.setItem("daedalus.glass-intensity.dark", "0.2");
    events.dispatchEvent(
      Object.assign(new Event("storage"), { key: "daedalus.glass-intensity.dark" }),
    );
    expect(properties.get("--glass-intensity-dark")).toBe("0.2");
    disconnect();
  });
  it("defaults both themes to one without stored preferences", () => {
    const { storage } = fixture();
    expect(readGlassIntensity("light", storage)).toBe(1);
    expect(readGlassIntensity("dark", storage)).toBe(1);
  });
  it("persists independent settings and applies both CSS inputs across theme changes", () => {
    const { storage, root, properties } = fixture();
    writeGlassIntensity("light", 0, storage, root);
    writeGlassIntensity("dark", 1.5, storage, root);
    expect(readGlassIntensity("light", storage)).toBe(0);
    expect(readGlassIntensity("dark", storage)).toBe(1.5);
    expect(properties.get("--glass-intensity-light")).toBe("0");
    expect(properties.get("--glass-intensity-dark")).toBe("1.5");
  });
  it.each([
    [-2, 0],
    [9, 1.5],
    [NaN, 1],
    [Infinity, 1],
  ])("normalizes %s to %s before persistence", (value, want) => {
    const { storage, root } = fixture();
    expect(writeGlassIntensity("light", value, storage, root)).toBe(want);
    expect(readGlassIntensity("light", storage)).toBe(want);
  });
  it.each(["", "garbage", "null", "Infinity", "{}"])(
    "defaults corrupt storage %j without treating it as zero",
    (raw) => {
      expect(readGlassIntensity("light", { getItem: () => raw })).toBe(1);
    },
  );
  it("keeps the current adjustment usable when persistence is denied", () => {
    const { root, properties } = fixture();
    expect(
      readGlassIntensity("dark", {
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBe(1);
    expect(
      writeGlassIntensity(
        "dark",
        0.7,
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        root,
      ),
    ).toBe(0.7);
    expect(properties.get("--glass-intensity-dark")).toBe("0.7");
  });
});
