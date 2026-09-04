# Helm

Helm is a local control plane for one developer and many coding agents. It keeps work discoverable, claimable, reviewable, and auditable through a human interface and MCP.

Helm is under active development. Product behavior is specified in [docs/product.md](docs/product.md).

## Run locally

Requirements: Node.js 22.13+ and pnpm 11.

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

On first launch, Helm asks for the absolute path to a local Git repository root. Use the project
switcher in the application header to add another repository or change the active project. Helm
canonicalizes every root, keeps browser data scoped to its project, and restores the selected project
and light, dark, or system appearance preference on the next launch.

Coding-agent clients can connect to the local streamable HTTP MCP endpoint at
`http://127.0.0.1:3000/api/mcp`. Register the connection with `register_agent_run` before using
agent-attributed tools, using a fresh `idempotencyKey` for each logical registration. A reconnect can
resume its run by ID; after an ungraceful client exit, set `takeoverActiveRun` explicitly to transfer
that run from the stale session. Registered agents can discover paginated work with `find_work`, load a
complete package with `get_task_context`, and atomically reserve work with `claim_task` or `claim_next`.
Every claim returns a lease token that is never persisted in plaintext. Keep it private and use it with
`renew_lease`, `release_lease`, `complete_task`, or `fail_task`. Completion requires a structured report
covering the result, changed areas, verification, references, risks, and follow-up work. The project's
review policy routes accepted reports either to human review or directly to done. Classified failure
reports close the attempt and return the task to the ready queue. Release, expiry, human cancellation or
reassignment, session closure, and a server restart make the token unusable.

Registered agents can use `add_comment`, `record_decision`, and `request_change` to append attributed
task history. `report_progress` additionally requires the active claim's lease token, which binds the
entry to its execution attempt. `report_blocker` uses the same lease proof to create an explicit manual
blocker for human attention; only the local human resolves it. `list_task_entries` returns stable text
projections, and `read_events` reads one project's durable event log after a monotonic cursor. Helm
records automatic lease expiry and agent-session closure as system timeline entries. The browser's task,
list, dashboard, and activity views use the same event log through `/api/events`; reconnects replay
missed commits and update only affected local records. Humans can add the same semantic entries, report
or resolve explicit manual blockers, and withdraw human or agent entries without deleting their audit
metadata.

The human workspace shows immutable attempt reports and supports approval, structured change requests,
explicit task cancellation and restoration, and reasoned reopening. Reopening never rewrites an earlier
attempt; a new attempt is created only when the reopened task is claimed again.

The operational dashboard projects claimable work, active agents and lease expiry, review, blockers,
latest failures, schedules, and reopened work from those same live records. Its notification center keeps
routine activity quiet, persists a per-project read watermark, and links important events back to the
existing task controls. The light, dark, or system appearance control is available throughout the human
workspace and applies optimistically without replacing the server-rendered first-paint theme.

Task lists, search results, and saved views expose visible-task selection for bulk planning changes.
Every bulk change must first be previewed; the preview reports the stable target set, projected field
changes, no-ops, and validation failures. Execution accepts only that exact preview, applies all changes
in one transaction, and records one attributed parent event linked to every affected task event.
Registered agents use the same command engine through `preview_bulk_tasks` and `execute_bulk_tasks`,
targeting either explicit task IDs or the structured filter language shared with `search_tasks`.

## Back up and move project data

The Settings view provides three downloads: an exact SQLite backup of the whole Helm instance, a
versioned semantic JSON export of the current project, and a readable Markdown snapshot. Markdown can
also be scoped to a saved view. Downloads are prepared from one consistent database snapshot while Helm
continues serving normal local work. SQLite backup bytes stream from the verified temporary image through
the browser's native download pipeline instead of being copied into server memory or an in-memory browser
Blob.

Restore an exact backup only while Helm is stopped. The target path must not exist, including as an empty
file; the command snapshots the source through SQLite (including committed WAL pages), verifies the
resulting image, and atomically refuses to overwrite any filesystem entry:

```sh
pnpm backup:restore /absolute/path/to/helm-backup.sqlite
```

The default target is `DATABASE_URL`. To restore into a different clean path, pass it explicitly:

```sh
pnpm backup:restore /absolute/path/to/helm-backup.sqlite /absolute/path/to/new-helm.sqlite
```

JSON is the portable, project-scoped format. It includes project settings, task state, relations, views,
tags, custom fields, agent attribution, attempts, comments, blockers, and source-event provenance. It
does not transfer active leases, token hashes, retry records, UI preferences, or MCP session identifiers,
and imported execution history cannot resume a run. CSV is a task-oriented migration format rather than
a full-fidelity backup. Both formats require a dry-run preview; Helm reports creates, updates, no-ops,
conflicts, and unsupported data before one atomic, human-attributed import is enabled.
CSV preview and execution delegate to Helm's normal bulk-task command engine. JSON uses the normal
project-import command because restoring stable identities, relations, and immutable history is a
cross-aggregate operation the task-only bulk command cannot represent; it retains the same actor,
version, idempotency, transaction, and audit contract.
Imported source events are preserved field-for-field inside bounded provenance audit batches with fresh
local cursors; their original cursors are never replayed. Import audit batches also identify every changed
entity, its previous and new version, and the fields changed. Referenced repository paths are canonicalized
and validated against the destination repository during both preview and execution.
When JSON is merged into an existing project, mutable versioned records must still be at the archive's
expected version; versionless history is never overwritten and records omitted from the archive remain
untouched. Browser imports reject CSV files larger than 2 MiB and JSON files larger than 64 MiB before
reading them into memory; the same format-specific bounds are enforced during server validation. JSON
export checks the same 64 MiB and 100,000-record-per-collection envelope, so Helm never emits an archive
that its matching importer rejects.

CSV headers are normalized case-insensitively and may include `task_id`, `expected_version`, `title`,
`lifecycle`, `priority`, `position`, `not_before`, `due_at`, `size`, `description`, `expected_outcome`,
`acceptance_criteria`, `agent_context`, `checklist`, `tags`, `capabilities`, `parent_task_id`,
`review_mode_override`, `archived`, and `custom.<field_key>`. A blank `task_id` creates a task; an update
requires both `task_id` and `expected_version`. Preview explicitly reports fields that are recognized but
unsafe for that operation. List cells accept a JSON string array or comma-, semicolon-, or pipe-separated
values; blank update cells clear dates, tags, capabilities, and custom-field values when those columns are
present.

`list_projects` and `get_active_project` expose the same current selection as the browser. Agent reads and
mutations still require an explicit project ID, so an active-project change never leaks records between
projects or silently redirects an agent's in-flight work. Discovery cursors are bound to the queue
revision, evaluation date, project, and normalized agent capabilities. If any of that context changes
between pages, restart discovery without the stale cursor.

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

The operational smoke test uses a temporary database and verifies a fresh nested-path migration, rejected
unsafe remote binding, loopback-only HTTP readiness, a real MCP session, a stale-build rebuild, persisted
project selection through browser and MCP reads after restart, and graceful port-releasing shutdown
through both launchers.

GitHub Actions runs the same repository-local gates from a clean checkout on pull requests and pushes to
`main`, with pinned Node.js and pnpm versions and a frozen lockfile. The production build owns TanStack
Start route generation; CI also replays Drizzle generation and rejects any resulting repository drift.

See [docs/architecture.md](docs/architecture.md) for system boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) before changing the project.
