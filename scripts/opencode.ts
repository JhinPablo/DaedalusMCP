import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url),
  dir = path.dirname(require.resolve("opencode-ai/package.json"));
const executable = path.join(
  dir,
  "bin",
  process.platform === "win32" ? "opencode.exe" : "opencode",
);
const home = path.resolve(".daedalus/opencode");
await mkdir(home, { recursive: true });
const child = spawn(
  executable,
  ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
  {
    windowsHide: true,
    stdio: "inherit",
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
    },
  },
);
child.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
