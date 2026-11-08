import { expect, it } from "vitest";
import {
  lensEligibility,
  materialForBackground,
  rimOffset,
  type RGB,
} from "../src/web/glass/material";
it("limita la refracción al borde y deja plano el centro", () => {
  expect(rimOffset(0, 44)).toBeCloseTo(48.4);
  expect(rimOffset(22, 44)).toBeGreaterThan(0);
  expect(rimOffset(44, 44)).toBe(0);
  expect(rimOffset(-1, 44)).toBe(0);
});
it("mantiene tinta por histéresis y fuerza la variante legible del tema para fondos vivos", () => {
  const neutral = Array.from({ length: 15 }, () => [128, 128, 128] as RGB);
  expect(materialForBackground(neutral, "light", "light").ink).toBe("light");
  expect(materialForBackground(neutral, "light", "dark").ink).toBe("dark");
  expect(materialForBackground(null, "dark")).toMatchObject({
    ink: "light",
    density: 1,
    fallback: true,
  });
  expect(materialForBackground(null, "light")).toMatchObject({
    ink: "dark",
    density: 1,
    fallback: true,
  });
  const vivid = materialForBackground(
    Array.from({ length: 15 }, () => [255, 0, 0] as RGB),
    "light",
  );
  expect(vivid.saturationKept).toBe(0.45);
  expect(vivid.density).toBeLessThanOrEqual(1);
});
it("excluye Firefox, elementos pequeños, compuestos y curvas sin correspondencia exacta", () => {
  const surface = {
    width: 600,
    height: 500,
    willChange: "auto",
    transform: "none",
    chromium: true,
    supported: true,
  };
  expect(lensEligibility(surface)).toBe(true);
  expect(lensEligibility({ ...surface, height: 31 })).toBe(false);
  expect(lensEligibility({ ...surface, chromium: false })).toBe(false);
  expect(lensEligibility({ ...surface, willChange: "transform" })).toBe(false);
  expect(lensEligibility({ ...surface, transform: "matrix(1,0,0,1,0,0)" })).toBe(false);
  expect(lensEligibility({ ...surface, cornerShape: "superellipse(2)" })).toBe(false);
});
