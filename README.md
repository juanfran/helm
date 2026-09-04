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

On first launch, Helm asks for the absolute path to a local Git repository root. The selected
project and light, dark, or system appearance preference are stored in SQLite and restored on the
next launch.

Coding-agent clients can connect to the local streamable HTTP MCP endpoint at
`http://127.0.0.1:3000/api/mcp`. Register the connection with `register_agent_run` before using
agent-attributed tools, using a fresh `idempotencyKey` for each logical registration. A reconnect can
resume its run by ID; after an ungraceful client exit, set `takeoverActiveRun` explicitly to transfer
that run from the stale session. Registered agents can discover paginated work with `find_work` and load a
complete package with `get_task_context`; `list_projects` and `get_active_project` remain available
as read-only project queries. Discovery cursors are bound to the queue revision, evaluation date, project,
and normalized agent capabilities. If any of that context changes between pages, restart discovery without
the stale cursor.

## Production build

```sh
pnpm build
pnpm start
```

`./start.sh` builds first when needed, then starts the local server.

## Checks

```sh
pnpm check
pnpm build
```

See [docs/architecture.md](docs/architecture.md) for system boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) before changing the project.