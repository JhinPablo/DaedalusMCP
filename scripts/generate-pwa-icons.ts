import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer) {
  const t = Buffer.from(type),
    size = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([size, t, data, sum]);
}
await mkdir("public/icons", { recursive: true });
for (const [name, size] of [
  ["icon-192", 192],
  ["icon-512", 512],
  ["maskable-512", 512],
  ["apple-touch-icon", 180],
  ["badge", 96],
] as const) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const points = [
    [0.26, 0.72],
    [0.26, 0.26],
    [0.74, 0.26],
    [0.74, 0.74],
    [0.35, 0.74],
    [0.35, 0.35],
    [0.65, 0.35],
    [0.65, 0.65],
    [0.44, 0.65],
    [0.44, 0.44],
    [0.56, 0.44],
    [0.56, 0.56],
    [0.5, 0.56],
  ];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const xx = x / size,
        yy = y / size;
      const ink = points.some((p, i) => {
        if (!i) return false;
        const a = points[i - 1];
        return (
          xx >= Math.min(a[0], p[0]) - 0.014 &&
          xx <= Math.max(a[0], p[0]) + 0.014 &&
          yy >= Math.min(a[1], p[1]) - 0.014 &&
          yy <= Math.max(a[1], p[1]) + 0.014
        );
      });
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw.set(
        ink ? [224, 245, 250, 255] : [16, 42, 60, name === "badge" ? 0 : 255],
        offset,
      );
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(
    `public/icons/${name}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
