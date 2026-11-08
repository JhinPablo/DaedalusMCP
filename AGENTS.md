# Daedalus

When interacting with Cloudflare, use the cf CLI unless the project has a Wrangler configuration file.

- The panel is the human approval authority. Connector and MCP credentials must never grant human approvals.
- Codex uses ChatGPT authentication through local app-server; never silently switch to an API key.
- OpenCode planning uses only the explicitly selected free DeepSeek model. An explicitly enabled Luna-high fallback may use local Codex with ChatGPT authentication, read-only planning and no API key. Otherwise fail closed if DeepSeek is unavailable.
- Never replay a run whose execution outcome is uncertain.
- Keep credentials, runtime journals and worktrees in ignored `.daedalus/` directories.
