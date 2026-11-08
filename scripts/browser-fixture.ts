import { createServer } from "node:http";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { Readable } from "node:stream";
import { Service } from "../src/server/service";
import { emptyWorkspace } from "../src/shared/model";
const port = 8895;
let state = emptyWorkspace();
state.projects.push({
  id: "test",
  name: "Proyecto de prueba",
  rootLabel: "fixture",
  connectorId: "test",
  createdAt: new Date().toISOString(),
});
state.connectors.push({
  id: "test",
  name: "Estación de prueba",
  lastSeen: new Date().toISOString(),
  codex: true,
  opencode: false,
  planning: true,
  planningModel: "GPT-6 Luna · alto",
});
const service = new Service(
  {
    read: () => state,
    write: (s) => {
      state = s;
    },
  },
  { put: async () => {}, get: async () => null },
  () => {},
  { buildId: "fixture", environment: "test" },
);
const vite = await createViteServer({
  configFile: false,
  plugins: [react()],
  server: { middlewareMode: true, hmr: false },
  appType: "spa",
});
createServer(async (req, res) => {
  if (!req.url?.startsWith("/api/")) {
    vite.middlewares(req, res);
    return;
  }
  const init: RequestInit & { duplex?: string } = {
    method: req.method,
    headers: req.headers as Record<string, string>,
  };
  if (req.method !== "GET") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  const result = await service.handle(
    new Request(`http://127.0.0.1:${port}` + req.url, init),
    { role: "owner", id: "fixture-owner" },
  );
  res
    .writeHead(result.status, Object.fromEntries(result.headers))
    .end(await result.text());
}).listen(port, "127.0.0.1", () => console.log("Isolated browser fixture ready"));
