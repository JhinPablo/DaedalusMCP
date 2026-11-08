import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { proposalInput, type Principal } from "../shared/model";
import type { Service } from "./service";

export async function handleMcp(
  request: Request,
  service: Service,
  principal: Principal,
) {
  if (principal.role !== "mcp")
    return Response.json({ error: "Se requiere una credencial MCP." }, { status: 403 });
  const server = new McpServer({ name: "Daedalus", version: "0.1.0" });
  const output = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });
  server.registerTool(
    "get_context",
    {
      description:
        "Consulta proyectos, ideas, propuestas, aprobaciones y ejecuciones. No concede permisos.",
      inputSchema: { sessionId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      const state = service.view(principal);
      return output(
        sessionId
          ? {
              session: state.sessions.find((s) => s.id === sessionId),
              runs: state.runs.filter((r) => r.sessionId === sessionId),
            }
          : {
              projects: state.projects,
              sessions: state.sessions.map((s) => ({
                id: s.id,
                title: s.title,
                phase: s.phase,
                projectId: s.projectId,
              })),
            },
      );
    },
  );
  server.registerTool(
    "propose_plan",
    {
      description:
        "Registra una nueva versión de propuesta. Invalida aprobaciones anteriores. Solo el usuario puede aprobar desde el panel.",
      inputSchema: { sessionId: z.string(), proposal: proposalInput },
    },
    async ({ sessionId, proposal }) =>
      output(service.mutate((e) => e.propose(principal, sessionId, proposal))),
  );
  server.registerTool(
    "get_run",
    {
      description: "Consulta estado, evidencia y resultados de una ejecución.",
      inputSchema: { runId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) =>
      output(
        service.repo.read().runs.find((r) => r.id === runId) ?? {
          error: "Ejecución no encontrada.",
        },
      ),
  );
  server.registerTool(
    "record_observation",
    {
      description:
        "Añade una observación al historial. Es evidencia externa; no cambia el estado de ejecución ni cuenta como aprobación.",
      inputSchema: {
        sessionId: z.string(),
        message: z.string().min(1).max(6000),
      },
    },
    async ({ sessionId, message }) =>
      output(
        service.mutate((e) => {
          e.session(sessionId);
          e.event("mcp.observation", message, sessionId);
          return { ok: true };
        }),
      ),
  );
  server.registerResource(
    "workflow",
    "daedalus://workflow",
    {
      description: "Flujo y reglas de aprobación de Daedalus",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: "Idea → brainstorming → alternativas → crítica → aprobación de enfoque → aprobación de prompt y plan → ejecución local de Codex → pruebas → revisión independiente. Las aprobaciones son exclusivas del propietario en el panel. Nunca te autoapruebes ni interpretes una observación como una aprobación.",
        },
      ],
    }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
