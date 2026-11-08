import { lensEligibility, rimOffset } from "./material";
const namespace = "http://www.w3.org/2000/svg";
type Patch = {
  source: string;
  position: "tl" | "tr" | "br" | "bl" | "top" | "right" | "bottom" | "left";
};
const cache = new Map<string, Promise<{ patches: Patch[]; size: number }>>();
function patchesFor(radius: number, rim: number) {
  const key = `${radius}:${rim}`;
  let existing = cache.get(key);
  if (existing) return existing;
  existing = (async () => {
    const size = Math.ceil(radius + rim),
      patches: Patch[] = [];
    for (const position of [
      "tl",
      "tr",
      "br",
      "bl",
      "top",
      "right",
      "bottom",
      "left",
    ] as const) {
      const corner = position.length === 2;
      const width = corner || position === "left" || position === "right" ? size : 1;
      const height = corner || position === "top" || position === "bottom" ? size : 1;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      const pixels = context.createImageData(width, height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const right = position === "tr" || position === "br" || position === "right";
          const bottom =
            position === "bl" || position === "br" || position === "bottom";
          const px = right ? width - 1 - x : x,
            py = bottom ? height - 1 - y : y;
          let d: number,
            nx = 0,
            ny = 0;
          if (corner && px < radius && py < radius) {
            const vx = radius - px,
              vy = radius - py,
              length = Math.hypot(vx, vy);
            d = radius - length;
            nx = vx / (length || 1);
            ny = vy / (length || 1);
          } else if (
            position === "left" ||
            position === "right" ||
            (corner && px < py)
          ) {
            d = px;
            nx = 1;
          } else {
            d = py;
            ny = 1;
          }
          const offset = rimOffset(d, rim),
            i = (y * width + x) * 4;
          pixels.data[i] =
            128 + (((right ? -1 : 1) * nx * offset) / (2 * 1.1 * rim)) * 255;
          pixels.data[i + 1] =
            128 + (((bottom ? -1 : 1) * ny * offset) / (2 * 1.1 * rim)) * 255;
          pixels.data[i + 2] = 128;
          pixels.data[i + 3] = 255;
        }
      context.putImageData(pixels, 0, 0);
      const source = canvas.toDataURL();
      const image = new Image();
      image.src = source;
      await image.decode();
      patches.push({ source, position });
    }
    return { patches, size };
  })();
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, existing);
  return existing;
}
function svgElement(name: string, attributes: Record<string, string | number> = {}) {
  const node = document.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attributes))
    node.setAttribute(key, String(value));
  return node;
}
export function attachLens(surface: HTMLElement) {
  let svg: SVGElement | undefined,
    disposed = false,
    generation = 0;
  const update = async () => {
    const current = ++generation,
      rect = surface.getBoundingClientRect(),
      styles = getComputedStyle(surface);
    const supported = CSS.supports("backdrop-filter", "url(#daedalus-probe)");
    const allowed = lensEligibility({
      width: rect.width,
      height: rect.height,
      transform: styles.transform,
      willChange: styles.willChange,
      cornerShape: styles.getPropertyValue("corner-shape"),
      chromium:
        /Chrome|Chromium|Edg\//.test(navigator.userAgent) &&
        !/Firefox/.test(navigator.userAgent),
      supported,
    });
    const reduced =
      matchMedia("(prefers-reduced-transparency: reduce)").matches ||
      matchMedia("(forced-colors: active)").matches;
    surface.style.removeProperty("--glass-lens");
    svg?.remove();
    svg = undefined;
    surface.dataset.glassLens = "css-only";
    if (!allowed || reduced) return;
    const rim = Math.max(4, Math.min(44, Math.min(rect.width, rect.height) / 3.5));
    const radius = Math.min(
      parseFloat(styles.borderTopLeftRadius) || 0,
      Math.min(rect.width, rect.height) / 2,
    );
    const decoded = await patchesFor(Math.round(radius), Math.round(rim));
    if (
      disposed ||
      current !== generation ||
      decoded.size * 2 > Math.min(rect.width, rect.height)
    )
      return;
    const id = "daedalus-lens-" + crypto.randomUUID();
    svg = svgElement("svg", { width: 0, height: 0, "aria-hidden": "true" });
    svg.style.cssText = "position:fixed;pointer-events:none;overflow:hidden";
    const filter = svgElement("filter", {
      id,
      x: 0,
      y: 0,
      width: rect.width,
      height: rect.height,
      filterUnits: "userSpaceOnUse",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB",
    });
    filter.appendChild(
      svgElement("feFlood", { "flood-color": "rgb(128,128,128)", result: "neutral" }),
    );
    const merge = svgElement("feMerge", { result: "map" });
    merge.appendChild(svgElement("feMergeNode", { in: "neutral" }));
    for (const [i, patch] of decoded.patches.entries()) {
      const p = decoded.size,
        w = rect.width,
        h = rect.height;
      const positions: Record<Patch["position"], number[]> = {
        tl: [0, 0, p, p],
        tr: [w - p, 0, p, p],
        br: [w - p, h - p, p, p],
        bl: [0, h - p, p, p],
        top: [p, 0, w - 2 * p, p],
        right: [w - p, p, p, h - 2 * p],
        bottom: [p, h - p, w - 2 * p, p],
        left: [0, p, p, h - 2 * p],
      };
      const [x, y, width, height] = positions[patch.position];
      filter.appendChild(
        svgElement("feImage", {
          href: patch.source,
          x,
          y,
          width,
          height,
          preserveAspectRatio: "none",
          result: "patch" + i,
        }),
      );
      merge.appendChild(svgElement("feMergeNode", { in: "patch" + i }));
    }
    filter.appendChild(merge);
    for (const [channel, scale] of [1.15, 1, 0.85].entries()) {
      filter.appendChild(
        svgElement("feDisplacementMap", {
          in: "SourceGraphic",
          in2: "map",
          scale: 2 * 1.1 * rim * scale,
          xChannelSelector: "R",
          yChannelSelector: "G",
          result: "bend" + channel,
        }),
      );
      const matrix = Array(20).fill(0);
      matrix[channel * 6] = 1;
      matrix[18] = 1;
      filter.appendChild(
        svgElement("feColorMatrix", {
          in: "bend" + channel,
          type: "matrix",
          values: matrix.join(" "),
          result: "color" + channel,
        }),
      );
    }
    filter.appendChild(
      svgElement("feBlend", {
        in: "color0",
        in2: "color1",
        mode: "screen",
        result: "redGreen",
      }),
    );
    filter.appendChild(
      svgElement("feBlend", { in: "redGreen", in2: "color2", mode: "screen" }),
    );
    svg.appendChild(filter);
    document.body.appendChild(svg);
    surface.style.setProperty("--glass-lens", `url("#${id}")`);
    surface.dataset.glassLens = "active";
  };
  const safelyUpdate = () => {
    void update().catch(() => {
      surface.style.removeProperty("--glass-lens");
      surface.dataset.glassLens = "css-only";
    });
  };
  const observer = new ResizeObserver(safelyUpdate);
  observer.observe(surface);
  const transparency = matchMedia("(prefers-reduced-transparency: reduce)"),
    colors = matchMedia("(forced-colors: active)");
  transparency.addEventListener("change", safelyUpdate);
  colors.addEventListener("change", safelyUpdate);
  safelyUpdate();
  return () => {
    disposed = true;
    generation++;
    observer.disconnect();
    transparency.removeEventListener("change", safelyUpdate);
    colors.removeEventListener("change", safelyUpdate);
    svg?.remove();
    surface.style.removeProperty("--glass-lens");
    delete surface.dataset.glassLens;
  };
}
