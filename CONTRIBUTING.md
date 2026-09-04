# Contributing

Work from an approved GitHub issue and keep the slice demonstrable end to end.

1. Read [AGENTS.md](AGENTS.md) and load the skill linked for your change.
2. Install dependencies with `pnpm install`.
3. Implement the narrowest complete vertical slice.
4. Run `pnpm check` and `pnpm build`.
5. Update the issue with completed behavior, verification, and remaining risk.

For startup, environment, or database-tooling changes, also run `pnpm smoke:operational`.

Use English for code, documentation, issues, and commit messages. Use Helm terminology and neutral names for external systems and agents.

Local configuration follows process environment, `.env.local`, then `.env` precedence. Never commit
those private files or print their values in logs; add placeholder-only keys to `.env.example` when a
new setting is introduced. Operational and migration tests must set `DATABASE_URL` to their own
temporary directory so they cannot read or modify a developer's Helm database.