# Helm

Helm is a local control plane for one developer and many coding agents. It keeps work discoverable, claimable, reviewable, and auditable through a human interface and MCP.

The project is in its foundation phase. Product behavior is specified in [docs/product.md](docs/product.md).

## Run locally

Requirements: Node.js 22.12+ and pnpm 11.

```sh
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

Helm reads configuration in this order: an existing process environment value wins, followed by
`.env.local`, then `.env`. The same order is used by development, production startup, and database
commands. Copy [`.env.example`](.env.example) when local overrides are useful; keep `.env` and
`.env.local` private. `DATABASE_URL` defaults to `./data/helm.db`, and Helm creates missing parent
directories before opening or migrating it.

`HOST` defaults to `127.0.0.1`. Helm rejects a non-loopback host unless
`HELM_UNSAFE_ALLOW_REMOTE=1` explicitly acknowledges that unsupported exposure. Do not put provider
credentials in Helm environment files or task records.

On first launch, Helm asks for the absolute path to a local Git repository root. The selected
project and light, dark, or system appearance preference are stored in SQLite and restored on the
next launch.

Coding-agent clients can connect to the local streamable HTTP MCP endpoint at
`http://127.0.0.1:3000/api/mcp`. Register the connection with `register_agent_run` before using
agent-attributed tools, using a fresh `idempotencyKey` for each logical registration. A reconnect can
resume its run by ID; after an ungraceful client exit, set `takeoverActiveRun` explicitly to transfer
that run from the stale session. Registered agents can discover paginated work with `find_work`, load a
complete package with `get_task_context`, and atomically reserve work with `claim_task` or `claim_next`.
Every claim returns a lease token that is never persisted in plaintext. Keep it private and use it with
`renew_lease` or `release_lease`; release, expiry, human cancellation or reassignment, session closure,
and a server restart make the token unusable.

Registered agents can use `add_comment`, `record_decision`, and `request_change` to append attributed
task history. `report_progress` additionally requires the active claim's lease token, which binds the
entry to its execution attempt. `list_task_entries` returns stable text projections, and `read_events`
reads the durable event log after a monotonic cursor. The browser's task, list, and activity views use the
same event log through `/api/events`; reconnects replay missed commits and update only affected local
records. Humans can add the same semantic entries, report or resolve explicit manual blockers, and
withdraw entries without deleting their audit metadata.

`list_projects` and `get_active_project` remain available as read-only project queries. Discovery cursors
are bound to the queue revision, evaluation date, project, and normalized agent capabilities. If any of
that context changes between pages, restart discovery without the stale cursor.

## Production build

```sh
pnpm build
pnpm start
```

`pnpm start` fingerprints production inputs and rebuilds when `.output` is missing or stale before
starting the local server. `./start.sh` changes to the repository root and delegates to the same
command, so both entry points have identical environment, database, build, and host safeguards.

Apply migrations explicitly when needed with:

```sh
pnpm db:migrate
```

The command is safe with a new nested database path whose parent directories do not exist yet.

## Checks

```sh
pnpm check
pnpm build
pnpm smoke:operational
```

The operational smoke test uses a temporary database and verifies migration, a stale-build rebuild,
HTTP and MCP readiness, persisted preferences after restart, and clean shutdown through both launchers.

See [docs/architecture.md](docs/architecture.md) for system boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) before changing the project.