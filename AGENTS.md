# Daedalus

When interacting with Cloudflare, use the cf CLI unless the project has a Wrangler configuration file.

- The panel is the human approval authority. Connector and MCP credentials must never grant human approvals.
- Codex uses ChatGPT authentication through local app-server; never silently switch to an API key.
- OpenCode planning and the final review use the explicitly selected DeepSeek model from the OpenCode Go subscription. Codex implements the approved plan with its local ChatGPT session. An explicitly enabled Luna-high fallback may use local Codex with ChatGPT authentication, read-only planning and no API key. Otherwise fail closed if the subscription or model is unavailable.
- The owner in the panel, or an MCP client via `select_engine`, may switch the DeepSeek model and its reasoning variant; the connector applies the selection on its next cycle. Engine selection never grants approvals or permissions.
- The connector reports the 5-hour, weekly and monthly OpenCode Go usage windows without sending the credential to Daedalus.
- Never replay a run whose execution outcome is uncertain.
- Keep credentials, runtime journals and worktrees in ignored `.daedalus/` directories.
- Follow CONTRIBUTING.md: English atomic commits with `✨feat:`, `🐛fix:`, `⚙️ci:`, or `📄docs:`. Use the configured GitHub account and never add AI co-authorship notes or `Co-authored-by` lines.
- Keep `main` and `staging` as permanent remote branches. Preview tested commits on `staging`; retain isolated agent worktrees locally and never overwrite shared work.
