# How to Contribute

Work on `staging`. Every committed change must pass CI before its shared preview is deployed. Keep `main` for reviewed production candidates. Production publication requires the owner's approval of the exact candidate in Daedalus; merging alone does not publish.

## Commit Messages

Use one of these prefixes in each commit:

- `✨feat: ...` for new features, artifacts, or capabilities.
- `🐛fix: ...` for bug fixes or corrections.
- `⚙️ci: ...` for CI/CD, automation, deployment, or infrastructure changes.
- `📄docs: ...` for documentation-only changes.

Keep commits focused and atomic. Write commit messages in English only. Use the configured GitHub account. Do not add AI assistant co-authorship notes or `Co-authored-by` lines.

Agent worktrees stay local until their reviewed changes can advance `staging` without replacing existing work. Never force-push shared branches. Delete obsolete remote branches only after verifying their changes are in the deployed production tree. Preserve unmerged work.
