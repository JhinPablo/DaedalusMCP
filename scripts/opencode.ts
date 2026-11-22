import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url),
  dir = path.dirname(require.resolve("opencode-ai/package.json"));
const executable = path.join(
  dir,
  "bin",
  process.platform === "win32" ? "opencode.exe" : "opencode",
);
const home = path.resolve(".daedalus/opencode");
await mkdir(home, { recursive: true });
// OpenCode Go bills only through its own inference route; models.dev points the
// opencode provider at the pay-as-you-go endpoint. Ensure the isolated server
// sends subscription traffic to the Go route with a session routing header.
const goRoute = {
  $schema: "https://opencode.ai/config.json",
  provider: {
    opencode: {
      options: {
        baseURL: "https://opencode.ai/inference/go/v1",
        headers: { "x-opencode-session": "daedalus" },
      },
      models: {
        "deepseek-v4.1-flash": {
          headers: { "x-opencode-session": "daedalus" },
        },
        "deepseek-v4-pro": {
          headers: { "x-opencode-session": "daedalus" },
        },
      },
    },
  },
  providers: {
    opencode: {
      options: {
        baseURL: "https://opencode.ai/inference/go/v1",
        headers: { "x-opencode-session": "daedalus" },
      },
      models: {
        "deepseek-v4.1-flash": {
          headers: { "x-opencode-session": "daedalus" },
        },
        "deepseek-v4-pro": {
          headers: { "x-opencode-session": "daedalus" },
        },
      },
    },
  },
};
const configFile = path.join(home, "config", "opencode", "opencode.jsonc");
let current = "";
try {
  current = await readFile(configFile, "utf8");
} catch {
  /* first run */
}
if (!current.includes("inference/go/v1")) {
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(goRoute, null, 2));
  console.log("OpenCode Go route configured in " + configFile);
}
const login = process.argv.slice(2).includes("--login");
const child = spawn(
  executable,
  login
    ? ["auth", "login"]
    : ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
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
