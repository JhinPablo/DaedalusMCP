import { createServer, type IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { emptyWorkspace, type Workspace, type Principal } from "../src/shared/model";
import { digest } from "../src/shared/engine";
import { Service, errorResponse } from "../src/server/service";
import { handleMcp } from "../src/server/mcp";
import { inside } from "../src/connector/config";

const production = process.argv.includes("--production");
const port = Number(process.env.DAEDALUS_PORT ?? (production ? 8788 : 8787));
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Puerto local inválido.");
const origin = `http://127.0.0.1:${port}`;

await mkdir(".daedalus/blobs", { recursive: true });
const db = new DatabaseSync(".daedalus/development.sqlite");
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY,value TEXT NOT NULL)",
);
const repo = {
  read: (): Workspace => {
    const row = db.prepare("SELECT value FROM workspace WHERE id=1").get() as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : emptyWorkspace();
  },
  write: (s: Workspace) => {
    db.prepare(
      "INSERT INTO workspace VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    ).run(JSON.stringify(s));
  },
};
const sockets = new WebSocketServer({ noServer: true });
const service = new Service(
  repo,
  {
    put: async (k, v) => {
      const file = path.join(".daedalus/blobs", k);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, v);
    },
    get: async (k) => {
      try {
        return await readFile(path.join(".daedalus/blobs", k), "utf8");
      } catch {
        return null;
      }
    },
  },
  () => {
    for (const ws of sockets.clients)
      if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"changed"}');
  },
);
let connectorToken: string;
try {
  connectorToken = (await readFile(".daedalus/dev-connector-token", "utf8")).trim();
} catch {
  connectorToken = "ddl_" + crypto.randomUUID() + crypto.randomUUID();
  await writeFile(".daedalus/dev-connector-token", connectorToken, {
    mode: 0o600,
  });
}
if (!repo.read().credentials.some((c) => c.id === "local-connector"))
  service.mutate((e) => {
    e.state.credentials.push({
      id: "local-connector",
      role: "connector",
      label: "Conector de desarrollo",
      hash: digest(connectorToken),
      createdAt: new Date().toISOString(),
    });
  });
function principal(req: IncomingMessage): Principal | null {
  const bearer = req.headers.authorization;
  if (bearer)
    return bearer.startsWith("Bearer ") ? service.authenticate(bearer.slice(7)) : null;
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, "http://127.0.0.1:5173"].includes(origin))
    return null;
  if (req.headers["sec-fetch-site"] === "cross-site") return null;
  if (req.method !== "GET" && req.headers["x-daedalus-panel"] !== "1") return null;
  return { role: "owner", id: "local-owner" };
}
const vite = production
  ? undefined
  : await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
const server = createServer(async (req, res) => {
  const host = req.headers.host;
  if (!["127.0.0.1:" + port, "localhost:" + port].includes(host ?? "")) {
    res.writeHead(403).end();
    return;
  }
  const url = origin + req.url;
  if (!req.url?.startsWith("/api/") && !req.url?.startsWith("/mcp")) {
    if (vite) {
      vite.middlewares(req, res);
      return;
    }
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const root = path.resolve("dist/client");
      let file = path.resolve(root, "." + decodeURIComponent(new URL(url).pathname));
      if (!inside(root, file)) {
        res.writeHead(403).end();
        return;
      }
      try {
        if (!(await stat(file)).isFile()) file = path.join(root, "index.html");
      } catch {
        file = path.join(root, "index.html");
      }
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
      };
      const content = await readFile(file);
      res
        .writeHead(200, {
          "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        })
        .end(req.method === "HEAD" ? undefined : content);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  try {
    const p = principal(req);
    if (!p) {
      res
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "Autenticación requerida." }));
      return;
    }
    const init: RequestInit & { duplex?: string } = {
      method: req.method,
      headers: req.headers as Record<string, string>,
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    const request = new Request(url, init),
      response = req.url?.startsWith("/mcp")
        ? await handleMcp(request, service, p)
        : await service.handle(request, p);
    res.writeHead(response.status, {
      ...Object.fromEntries(response.headers),
      "Cache-Control": "no-store",
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    const response = errorResponse(e);
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(await response.text());
  }
});
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/events" && principal(req)?.role === "owner")
    sockets.handleUpgrade(req, socket, head, (ws) =>
      sockets.emit("connection", ws, req),
    );
  else if (req.url === "/events") socket.destroy();
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Daedalus local: ${origin}\nModo local: acceso limitado a loopback. Credencial de conector en .daedalus/dev-connector-token.`,
  ),
);
function close() {
  sockets.close();
  server.close();
  void vite?.close();
  db.close();
}
process.on("SIGINT", () => {
  close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  close();
  process.exit(0);
});
