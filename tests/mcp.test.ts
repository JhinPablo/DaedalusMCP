import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Service } from "../src/server/service";
import { handleMcp } from "../src/server/mcp";
import { emptyWorkspace } from "../src/shared/model";

it("negocia MCP real por Streamable HTTP y no ofrece herramientas de autoaprobación", async () => {
  let state = emptyWorkspace();
  const service = new Service(
    {
      read: () => state,
      write: (s) => {
        state = s;
      },
    },
    { put: async () => {}, get: async () => null },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("https://daedalus.test/mcp"),
    {
      fetch: async (input, init) =>
        handleMcp(new Request(input, init), service, {
          role: "mcp",
          id: "test-client",
        }),
    },
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name)).toEqual([
    "get_context",
    "propose_plan",
    "get_run",
    "record_observation",
    "list_engines",
    "select_engine",
  ]);
  const result = await client.callTool({ name: "get_context", arguments: {} });
  expect(result.isError).not.toBe(true);
  const engines = await client.callTool({
    name: "list_engines",
    arguments: {},
  });
  expect(engines.isError).not.toBe(true);
  await client.close();
});
it("selecciona el motor OpenCode desde MCP y valida el catálogo", async () => {
  let state = emptyWorkspace();
  state.connectors.push({
    id: "device",
    name: "Equipo",
    lastSeen: new Date().toISOString(),
    codex: true,
    opencode: true,
    models: [
      {
        id: "deepseek-v4.1-flash",
        providerID: "opencode",
        name: "DeepSeek V4.1 Flash",
        variants: ["low", "high", "max"],
      },
    ],
  });
  const service = new Service(
    {
      read: () => state,
      write: (s) => {
        state = s;
      },
    },
    { put: async () => {}, get: async () => null },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("https://daedalus.test/mcp"),
    {
      fetch: async (input, init) =>
        handleMcp(new Request(input, init), service, {
          role: "mcp",
          id: "phone",
        }),
    },
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const unknown = await client.callTool({
    name: "select_engine",
    arguments: { model: "otro-modelo" },
  });
  expect(unknown.isError).toBe(true);
  const invalidVariant = await client.callTool({
    name: "select_engine",
    arguments: { model: "deepseek-v4.1-flash", variant: "turbo" },
  });
  expect(invalidVariant.isError).toBe(true);
  const ok = await client.callTool({
    name: "select_engine",
    arguments: { model: "deepseek-v4.1-flash", variant: "max" },
  });
  expect(ok.isError).not.toBe(true);
  expect(state.engines?.opencode).toMatchObject({
    model: "deepseek-v4.1-flash",
    variant: "max",
  });
  await client.close();
});
it("rechaza un conector como cliente MCP", async () => {
  const state = emptyWorkspace();
  const service = new Service(
    { read: () => state, write: () => {} },
    { put: async () => {}, get: async () => null },
  );
  const response = await handleMcp(new Request("http://localhost/mcp"), service, {
    role: "connector",
    id: "device",
  });
  expect(response.status).toBe(403);
});
