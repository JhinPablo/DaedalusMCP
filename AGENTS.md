# Daedalus

When interacting with Cloudflare, use the cf CLI unless the project has a Wrangler configuration file.

- The panel is the human approval authority. Connector and MCP credentials must never grant human approvals.
- Codex uses ChatGPT authentication through local app-server; never silently switch to an API key.
- OpenCode planning uses only the explicitly selected free DeepSeek model. An explicitly enabled Luna-high fallback may use local Codex with ChatGPT authentication, read-only planning and no API key. Otherwise fail closed if DeepSeek is unavailable.
- Never replay a run whose execution outcome is uncertain.
- Keep credentials, runtime journals and worktrees in ignored `.daedalus/` directories.
- Follow CONTRIBUTING.md: English atomic commits with `✨feat:`, `🐛fix:`, `⚙️ci:`, or `📄docs:`. Use the configured GitHub account and never add AI co-authorship notes or `Co-authored-by` lines.
- Keep `main` and `staging` as permanent remote branches. Preview tested commits on `staging`; retain isolated agent worktrees locally and never overwrite shared work.
