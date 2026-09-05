# Running and maintaining Helm

For your first project and MCP connection, start with the [getting-started tutorial](getting-started.md).
This guide covers configuration, safe backups, moving data, and common problems.

## Choose how to run it

Use Node.js 22.13+ and pnpm 11. From the Helm checkout:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server is available at `http://127.0.0.1:3000`. For everyday use, stop the development
server and run the production build:

```sh
pnpm build
pnpm start
```

`pnpm start` rebuilds automatically if the production output is missing or its inputs have changed.
The first start after an update can therefore take longer. `./start.sh` is an alternative launcher
that changes to the Helm checkout and runs the same startup command. Stop either server with Ctrl+C.

Keep Helm running while using the browser or an MCP client. Helm does not start or supervise coding
agents; run them separately.

## Configuration and data location

Defaults work without a configuration file. To override them, copy [`.env.example`](../.env.example)
to `.env.local` in the Helm checkout and edit it:

```dotenv
DATABASE_URL=./data/helm.db
HOST=127.0.0.1
```

`DATABASE_URL` is a SQLite file path, relative to the Helm checkout or absolute. Helm creates missing
parent directories and applies database migrations when it opens the store. All projects share that
database; each project points to its own Git repository. Helm does not copy your source files.

Configuration precedence is: existing process environment, then `.env.local`, then `.env`. Development,
production startup, and database commands use the same precedence. Restart the server after changes.
Keep local environment files private and never put provider credentials in task records or exports.

Use `HOST` and `PORT` for production listener settings. The launcher ignores the underlying runtime's
`NITRO_HOST` and `NITRO_PORT` aliases so they cannot override Helm's validated host or requested port.

The default host is `127.0.0.1`. Helm has no authentication and is intended only for local use. It rejects
non-loopback binding unless `HELM_UNSAFE_ALLOW_REMOTE=1` explicitly overrides the safeguard; this is
unsupported exposure, not a secure remote-access mode. A remote agent cannot connect to your machine
using its own `127.0.0.1`; use a client running locally.

## Back up before making changes

Open **Settings → Back up, export, or import**. Choose the format for your purpose:

| Format          | Use it for                                | What it preserves                                                           |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| SQLite backup   | Recovering the whole Helm instance        | All projects, preferences, event cursors, and stored history exactly        |
| JSON export     | Moving one project between Helm instances | Project settings, tasks, relations, views, and attributed execution history |
| Markdown export | Reading or sharing a snapshot             | Human-readable project or saved-view content; not a restorable backup       |

The SQLite download is a consistent snapshot even while Helm is running. Use it instead of copying a
live `.db` file: committed changes may still be in SQLite's WAL companion file. Store backups somewhere
safe; they contain your task text and history. Repository files need their own backup, such as Git.

### Restore an exact backup

Stop Helm and disconnect agents first. Choose a destination path that does **not** exist:

```sh
pnpm backup:restore /absolute/path/to/helm-backup.sqlite /absolute/path/to/restored-helm.sqlite
```

Set `DATABASE_URL` to that restored file, then start Helm. Omitting the second argument restores to the
configured `DATABASE_URL`, but that destination must also be absent. The command verifies the snapshot
and refuses to overwrite anything—even an empty file. Keep your previous database until you have
checked the restored projects and history.

An exact backup preserves stored execution records, but it does not resume an agent process or an MCP
session. After startup, agents must reconnect and discover or claim work again; old lease tokens are
not authorization to continue an earlier attempt.

### Move a project with JSON

1. Download **JSON export** from the source project's Settings.
2. In the destination Helm instance, open the import controls and choose the JSON file.
3. Choose a new project or the matching existing project. For a new project, supply its local repository
   root; move or clone the repository separately.
4. Enter a reason and select **Preview import**.
5. Check the creates, updates, no-ops, conflicts, and unsupported data. Import only when the preview
   allows it.

On a fresh destination, import as a new project directly; do not create an empty project first.
An existing target must have the archive's Helm project ID and compatible registered repository root.
A matching display name alone is not enough.

JSON transfers supported project state and history, not active leases, token hashes, MCP sessions,
retry records, or UI preferences. Imported active execution becomes inactive history, and in-progress
tasks become ready. Import creates fresh, human-attributed local audit events and preserves source
events as provenance; it does not reuse their original event cursors.

Merging into an existing project is not “newest file wins.” Mutable records must match their expected
local version before changes can apply. Existing immutable history is never overwritten, and records
omitted from the archive are not deleted. If the file, destination, reason, or target state changes,
preview again. Repository paths are checked both during preview and during execution.

JSON files are limited to 64 MiB and 100,000 records per top-level collection. Export enforces the same
envelope as import.

### Bring tasks in with CSV

CSV imports tasks into an existing project; it is not a full backup. The maximum file size is 2 MiB.
Start with a small file, preview it in Settings, and inspect the changes before importing:

```csv
title,priority,description
Add empty-state guidance,normal,Explain what to do when no tasks are ready
Check keyboard navigation,high,Verify focus stays visible throughout task review
```

A blank or omitted `task_id` creates a task. Updating an existing task requires both `task_id` and
`expected_version`. Headers are case-insensitive and may include:

```text
task_id, expected_version, title, lifecycle, priority, position, not_before, due_at,
size, description, expected_outcome, acceptance_criteria, agent_context, checklist,
tags, capabilities, parent_task_id, review_mode_override, archived, custom.<field_key>
```

Preview reports fields that are recognized but unsafe for the chosen operation. List cells accept a
JSON string array or comma-, semicolon-, or pipe-separated values. Quote CSV cells containing commas.
For updates, blank cells clear dates, tags, capabilities, and custom-field values when those columns
are present. Omit a column to leave it unchanged. Imports are atomic and use normal task validation.

## Update an existing installation

1. Download a SQLite backup, then stop Helm and disconnect agents.
2. Update your checkout to the commit or version you want to use. Preserve any local code changes.
3. Run the following from the Helm checkout:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start
```

Check your projects and reconnect agents afterward. Migrations are forward-only. To roll back, use the
previous code with a backup made before the update; do not point old code at a newer database schema.
Publishing or installing a tagged release is not required to use a verified checkout.

## Troubleshooting

### The browser or MCP client cannot connect

Check that Helm is running and that `http://127.0.0.1:3000` opens locally. The MCP URL is
`http://127.0.0.1:3000/api/mcp`, using **Streamable HTTP**—not a command-based stdio server or the
browser's `/api/events` stream. No API key is required. Configure the client with the same port as the
server. See the [connection walkthrough](getting-started.md#3-connect-your-coding-agent-through-mcp).

### An agent sees no work

A task must be ready, not scheduled for the future, not blocked, and compatible with the agent's
registered capabilities. Another agent's active claim also excludes it. Check the intended project ID:
switching projects in the browser does not redirect a connected agent's explicit project selection.
Give an incomplete task an outcome, acceptance criteria, and a checklist before moving it to Ready.

### An agent reports a conflict or an invalid lease

Have it re-read task context before changing anything. A version conflict means the task changed;
blindly retrying with an old version is not safe. Lease expiry, release, cancellation, reassignment,
session closure, or server restart can end execution authority. Stop work on an invalid claim and
discover or claim again. Use the same idempotency key only when retrying the same logical request.

On reconnection, an agent may resume its run by ID. Transferring a run from an ungracefully disconnected
session requires explicit `takeoverActiveRun`; do not take over a session that is still doing work.

### Startup reports that the port is in use

Check for another Helm process before starting a second server. Stop the intended existing process or
choose another port. For development: `pnpm dev --port 3001`. Development may also choose the next free
port automatically, so check the URL printed in the terminal. For production on a POSIX shell:
`PORT=3001 pnpm start`. Update the browser and MCP URLs together.

### A database or native-module error appears after changing Node.js

Confirm the Node.js and pnpm requirements, then run these under the Node.js version you will use for
Helm:

```sh
pnpm install --frozen-lockfile
pnpm rebuild better-sqlite3
```

SQLite's native module must match that runtime; reinstalling alone can reuse an older native build.
Do not delete your database as an installation troubleshooting step.

## Verify the checkout

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the automated checks and production smoke tests. The
[architecture](architecture.md) explains the consistency and security boundaries;
[client bundle budgets](client-bundle-budget.md) document loading limits.
