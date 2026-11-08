import { SqliteRepository, SqliteBlobs } from "./storage";
import { DurableObject } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { type Principal } from "../shared/model";
import { Service, errorResponse } from "../server/service";
import { readJson } from "../server/service";
import { digest, DomainError } from "../shared/engine";
import { normalizeWorkspace, type Workspace, activeStatuses } from "../shared/model";
import { handleMcp } from "../server/mcp";

export interface Env {
  WORKSPACE: DurableObjectNamespace<WorkspaceObject>;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  BUILD_ID: string;
  REPOSITORY: string;
  STAGING_URL: string;
  BOOTSTRAP_HASH?: string;
  BOOTSTRAP_EXPIRES?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
}
const accessKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export class WorkspaceObject extends DurableObject<Env> {
  private service: Service;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new Service(
      new SqliteRepository(ctx.storage),
      new SqliteBlobs(ctx.storage),
      () => {
        for (const ws of ctx.getWebSockets()) {
          try {
            ws.send(JSON.stringify({ type: "changed" }));
          } catch {
            ws.close();
          }
        }
      },
      {
        buildId: env.BUILD_ID,
        environment: env.ENVIRONMENT,
        stagingUrl: env.STAGING_URL,
      },
    );
  }
  async authenticate(token: string) {
    return this.service.authenticate(token);
  }
  async fetch(request: Request) {
    try {
      const principal = JSON.parse(
        request.headers.get("X-Daedalus-Principal") ?? "null",
      ) as Principal | null;
      if (!principal) return new Response("Unauthorized", { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === "/api/migration" && request.method === "POST") {
        if (principal.role !== "migration")
          return new Response("Forbidden", { status: 403 });
        const payload = (await readJson(request)) as {
          migrationId: string;
          state: Workspace;
          blobs?: Array<{ key: string; content: string }>;
        };
        const existing = this.service.repo.read();
        if (!/^[a-f0-9-]{36}$/.test(payload.migrationId))
          throw new DomainError(400, "Identidad de migración inválida.");
        if (
          (existing.revision ||
            existing.projects.length ||
            existing.sessions.length ||
            existing.credentials.length) &&
          existing.migrationId !== payload.migrationId
        )
          throw new DomainError(
            409,
            "El entorno ya tiene datos; la migración inicial no puede repetirse.",
          );
        const state =
          existing.migrationId === payload.migrationId
            ? existing
            : normalizeWorkspace(payload.state);
        state.migrationId = payload.migrationId;
        if (
          state.schemaVersion !== 1 ||
          !Array.isArray(state.sessions) ||
          !Array.isArray(state.runs) ||
          !Array.isArray(state.credentials) ||
          state.runs.some((r) => activeStatuses.includes(r.status))
        )
          throw new DomainError(
            409,
            "La migración requiere una instantánea sin ejecuciones activas ni en cola.",
          );
        if (
          state.credentials.some(
            (c) =>
              !["ci", "connector", "mcp"].includes(c.role) ||
              !/^[a-f0-9]{64}$/.test(c.hash),
          )
        )
          throw new DomainError(400, "Credenciales de migración inválidas.");
        this.service.repo.write({ ...state, revision: Math.max(1, state.revision) });
        for (const blob of payload.blobs ?? []) {
          const a = state.artifacts.find((a) => a.key === blob.key);
          if (!a) continue;
          if ((await this.service.blobs.get(blob.key)) !== null) continue;
          const storage = await this.service.storeArtifact(blob.key, blob.content);
          a.storage = storage;
        }
        this.service.repo.write({ ...state, revision: Math.max(1, state.revision) });
        return Response.json({
          ok: true,
          sessions: state.sessions.length,
          artifacts: state.artifacts.length,
        });
      }
      if (path === "/events") {
        if (principal.role !== "owner")
          return new Response("Forbidden", { status: 403 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (path === "/mcp") return handleMcp(request, this.service, principal);
      return this.service.handle(request, principal);
    } catch (error) {
      return errorResponse(error);
    }
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
      if (
        bearer?.startsWith("Bearer ") &&
        url.pathname === "/api/migration" &&
        ["production", "staging"].includes(env.ENVIRONMENT) &&
        env.BOOTSTRAP_HASH &&
        Date.parse(env.BOOTSTRAP_EXPIRES ?? "") > Date.now() &&
        digest(bearer.slice(7)) === env.BOOTSTRAP_HASH
      )
        principal = { role: "migration", id: "one-time-migration" };
      else if (bearer?.startsWith("Bearer "))
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
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Cache-Control", "no-store");
        responseHeaders.set("X-Content-Type-Options", "nosniff");
        responseHeaders.set("Referrer-Policy", "same-origin");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      }
      return response;
    } catch (e) {
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<Env>;
