export type RGB = readonly [number, number, number];
export function rimOffset(distance: number, rim: number) {
  return distance < 0 || distance >= rim || rim <= 0
    ? 0
    : 1.1 * rim * (1 - distance / rim) ** 2.6;
}
export function materialForBackground(
  samples: RGB[] | null,
  theme: "light" | "dark",
  previousInk: "light" | "dark" = "dark",
) {
  // A live Remotion composition cannot be sampled as a static image. Fail to the
  // theme's dense tint, as required for live/video/unreadable backdrops.
  if (!samples || samples.length < 5)
    return {
      ink: theme === "dark" ? ("light" as const) : ("dark" as const),
      density: 1,
      saturationKept: 1,
      fallback: true,
    };
  const luminance = ([r, g, b]: RGB) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const sorted = samples
    .slice()
    .sort((a, b) => luminance(a) - luminance(b))
    .slice(2, -2);
  const light = sorted.reduce((sum, c) => sum + luminance(c), 0) / sorted.length;
  const texture = luminance(sorted.at(-1)!) - luminance(sorted[0]);
  const chroma =
    sorted.reduce((sum, c) => sum + (Math.max(...c) - Math.min(...c)) / 255, 0) /
    sorted.length;
  const ink =
    theme === "dark"
      ? "light"
      : light < 0.45
        ? "light"
        : light > 0.55
          ? "dark"
          : previousInk;
  return {
    ink,
    density: Math.min(
      1,
      Math.max(
        0,
        0.55 * (ink === "light" ? light : 1 - light) + 0.7 * texture + 0.3 * chroma,
      ),
    ),
    saturationKept: Math.max(0.45, 1 - 0.75 * chroma),
    fallback: false,
  };
}
export function lensEligibility({
  width,
  height,
  willChange,
  transform,
  cornerShape = "round",
  chromium,
  supported,
}: {
  width: number;
  height: number;
  willChange: string;
  transform: string;
  cornerShape?: string;
  chromium: boolean;
  supported: boolean;
}) {
  return (
    chromium &&
    supported &&
    Math.min(width, height) >= 32 &&
    (!willChange || willChange === "auto") &&
    (!transform || transform === "none") &&
    ["round", "superellipse(1)", ""].includes(cornerShape)
  );
}
