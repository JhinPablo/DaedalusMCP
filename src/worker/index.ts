import { DurableObject } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { emptyWorkspace, type Principal, type Workspace } from "../shared/model";
import { Service, errorResponse, type Repository } from "../server/service";
import { handleMcp } from "../server/mcp";

export interface Env {
  WORKSPACE: DurableObjectNamespace<WorkspaceObject>;
  ASSETS: Fetcher;
  ARTIFACTS: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
}
const accessKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export class WorkspaceObject extends DurableObject<Env> {
  private service: Service;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS workspace_parts (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    const repo: Repository = {
      read: () => {
        const parts=ctx.storage.sql.exec<{value:string}>('SELECT value FROM workspace_parts ORDER BY id').toArray();
        if(parts.length)return JSON.parse(parts.map(p=>p.value).join('')) as Workspace;
        // Preserve snapshots from the initial single-row storage format.
        if(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'").toArray().length){const legacy=ctx.storage.sql.exec<{value:string}>('SELECT value FROM workspace WHERE id=1').toArray()[0];if(legacy)return JSON.parse(legacy.value) as Workspace;}
        return emptyWorkspace();
      },
      write: (s) => {
        const json=JSON.stringify(s);
        ctx.storage.transactionSync(()=>{ctx.storage.sql.exec('DELETE FROM workspace_parts');let index=0;for(let offset=0;offset<json.length;){let end=Math.min(offset+65536,json.length);const code=json.charCodeAt(end-1);if(end<json.length&&code>=0xd800&&code<=0xdbff)end--;ctx.storage.sql.exec('INSERT INTO workspace_parts(id,value) VALUES(?,?)',index++,json.slice(offset,end));offset=end;}});
      },
    };
    this.service = new Service(
      repo,
      {
        put: async (k, v) => {
          await env.ARTIFACTS.put(k, v);
        },
        get: async (k) => (await env.ARTIFACTS.get(k))?.text() ?? null,
      },
      () => {
        for (const ws of ctx.getWebSockets()) {
          try {
            ws.send(JSON.stringify({ type: "changed" }));
          } catch {
            ws.close();
          }
        }
      },
    );
  }
  async authenticate(token: string) {
    return this.service.authenticate(token);
  }
  async fetch(request: Request) {
    const principal = JSON.parse(
      request.headers.get("X-Daedalus-Principal") ?? "null",
    ) as Principal | null;
    if (!principal) return new Response("Unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/events") {
      if (principal.role !== "owner") return new Response("Forbidden", { status: 403 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === "/mcp") return handleMcp(request, this.service, principal);
    return this.service.handle(request, principal);
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }
  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url),
        api =
          url.pathname.startsWith("/api/") ||
          url.pathname === "/mcp" ||
          url.pathname === "/events";
      if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL)
        return Response.json(
          {
            error:
              "Configura Cloudflare Access y OWNER_EMAIL antes de habilitar Daedalus.",
          },
          { status: 503 },
        );
      const stub = env.WORKSPACE.getByName("owner-workspace");
      let principal: Principal | null = null;
      const bearer = request.headers.get("authorization");
      if (bearer?.startsWith("Bearer "))
        principal = await stub.authenticate(bearer.slice(7));
      else {
        const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
        if (assertion) {
          const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
          let keys = accessKeys.get(issuer);
          if (!keys) {
            keys = createRemoteJWKSet(new URL(issuer + "/cdn-cgi/access/certs"));
            accessKeys.set(issuer, keys);
          }
          try {
            const { payload } = await jwtVerify(assertion, keys, {
              issuer,
              audience: env.ACCESS_AUD,
            });
            if (payload.email === env.OWNER_EMAIL)
              principal = { role: "owner", id: String(payload.sub) };
          } catch {
            return new Response("Unauthorized", { status: 401 });
          }
        }
      }
      if (!principal)
        return Response.json({ error: "Autenticación requerida." }, { status: 401 });
      if (url.pathname === "/events" && request.headers.get("Origin") !== url.origin)
        return new Response("Forbidden", { status: 403 });
      if (
        principal.role === "owner" &&
        api &&
        request.method !== "GET" &&
        request.method !== "HEAD"
      ) {
        if (
          request.headers.get("Origin") !== url.origin ||
          request.headers.get("X-Daedalus-Panel") !== "1"
        )
          return new Response("Forbidden", { status: 403 });
      }
      if (!api) {
        if (principal.role !== "owner")
          return new Response("Forbidden", { status: 403 });
        return env.ASSETS.fetch(request);
      }
      const headers = new Headers(request.headers);
      headers.set("X-Daedalus-Principal", JSON.stringify(principal));
      const response = await stub.fetch(new Request(request, { headers }));
      if (response.status !== 101) {
        response.headers.set("Cache-Control", "no-store");
        response.headers.set("X-Content-Type-Options", "nosniff");
        response.headers.set("Referrer-Policy", "same-origin");
      }
      return response;
    } catch (e) {
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<Env>;
