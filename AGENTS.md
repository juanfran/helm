# Helm agent guide

Read [docs/product.md](docs/product.md) for product intent and [docs/architecture.md](docs/architecture.md) for system boundaries. Work from an approved GitHub issue and update it with verified progress.

- Task lifecycle, eligibility, priority, leases, attempts, or audit history: read [.agents/skills/helm-domain/SKILL.md](.agents/skills/helm-domain/SKILL.md).
- End-to-end behavior spanning UI, commands, persistence, realtime, or MCP: read [.agents/skills/helm-slice/SKILL.md](.agents/skills/helm-slice/SKILL.md).
- Components, themes, responsive behavior, or visual changes: read [.agents/skills/helm-ui/SKILL.md](.agents/skills/helm-ui/SKILL.md).

Keep every repository artifact in English. Use Helm terminology and generic names for integrations and coding agents.

<!-- intent-skills:start -->

## Skill loading

Before substantial edits, run `npx @tanstack/intent@latest list` from the workspace root. Load the most specific matching local skill with `npx @tanstack/intent@latest load <package>#<skill>` and follow its `SKILL.md`.
<!-- intent-skills:end -->
