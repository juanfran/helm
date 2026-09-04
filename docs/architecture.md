# Architecture

## Product boundary

Helm stores and coordinates work. It does not run coding agents. The browser UI, server functions, raw HTTP endpoints, and MCP are adapters around one local application core.

The default process listens on `127.0.0.1`. SQLite is the only authoritative store. A repository remains authoritative for its own files; Helm stores paths and external references rather than copying source code.

## Module boundaries

```text
Browser UI ─┐
Server RPC ─┼─> commands and queries ─> domain ─> repositories ─> SQLite
HTTP/SSE  ──┤          │                    │             │
MCP       ──┘          └─> Effect errors    └─> events ───┘
                                │
                                └─> adapter-specific responses
```

- **Domain** owns lifecycle, eligibility, ranking, relations, attempts, leases, policies, and invariants. It has no UI, protocol, or database imports.
- **Application** exposes semantic commands and queries as Effect programs. It establishes actor context, authorization assumptions, idempotency, expected versions, transactions, and typed failures.
- **Persistence** implements repositories with Drizzle and SQLite. A command updates current-state projections and appends audit events atomically.
- **Adapters** validate input, execute an application program, and translate typed results for TanStack Start or MCP. They contain no domain decisions.
- **Client data** uses TanStack DB collections for reactive records and optimistic mutations. TanStack Query supplies the collection adapter and isolated non-collection reads.
- **Presentation** uses Base UI primitives and repository-owned components styled through StyleX tokens.

This is not full event sourcing. Current tables are the efficient source for queries; the append-only event table is an audit and realtime change feed. Projection changes and events share one transaction so they cannot disagree.

## Command contract

Every mutation carries:

- A compiled Zod input schema.
- Actor and, for agents, run identity derived from the connection rather than free text.
- An idempotency key for retry-safe protocol calls.
- The expected aggregate version when modifying existing state.
- A semantic reason when the operation needs human explanation.

A successful command commits its projection changes and one parent event atomically. Bulk commands may create child events linked to the parent. A failure commits neither.

Expected-version conflicts return the current version and a compact change summary. The adapter never silently retries a semantic conflict.

Compile stable synchronous schemas once at module scope with `z.compile(Schema)`. Tests run compiled and normal parsing against representative inputs. Schemas with unsupported asynchronous or transform behavior stay on the normal parser.

## Core records

| Record                        | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| Project                       | Repository root, defaults, policies, and sequence namespace              |
| Task                          | Current lifecycle, content, priority, position, dates, size, and version |
| Task relation                 | Blocking or informational link between two tasks                         |
| Tag                           | Named classification with optional exclusive group                       |
| Capability                    | Requirement used for work discovery                                      |
| Custom field definition/value | Typed project customization without lifecycle changes                    |
| Saved view                    | Versioned structured filter, grouping, and ordering definition           |
| Agent profile                 | Durable display identity and capabilities                                |
| Agent run                     | One MCP-connected execution session                                      |
| Attempt                       | One execution of a task, including outcome and evidence                  |
| Lease                         | Exclusive expiring claim tied to a task, attempt, and run                |
| Comment                       | Immutable semantic message with optional withdrawal metadata             |
| Event                         | Attributed append-only audit entry with monotonic cursor                 |
| Idempotency record            | Durable result of a retryable command key                                |

Identifiers are opaque and stable. A separate project-local sequence provides compact human references without using it as the primary key.

## Lifecycle and eligibility

Lifecycle state records human intent:

```text
backlog -> ready -> in_progress -> review -> done
   │         │           │           │
   └─────────┴───────────┴───────────┴-> cancelled
```

Reopening `done` returns the task to `ready` unless the actor explicitly chooses `backlog`. Rejecting
`review` returns it to `ready`. Both preserve prior attempts; a fresh attempt is created only by the next
successful claim.

`scheduled`, `blocked`, `claimable`, and `claimed` are eligibility projections, not extra lifecycle values:

- Scheduled: lifecycle is ready and `not_before` is in the future.
- Blocked: a blocking dependency is incomplete or a manual blocker is active.
- Claimable: ready, not scheduled, not blocked, capability-compatible, and without a valid lease.
- Claimed: a valid lease exists. Starting its attempt moves lifecycle to `in_progress`.

Keeping these axes separate prevents contradictory combinations and makes queries explainable.

## Ranking

Candidate ordering is deterministic:

1. Claimable tasks only.
2. Required capabilities must be satisfied.
3. Explicit priority: urgent, high, normal, low.
4. Manual position within the priority lane.
5. Due date when present.
6. Creation sequence as a stable final tie-breaker.

The query result includes eligibility facts and a short ordering explanation. Due dates never mutate priority automatically unless a future explicit rule is enabled.

## Attempts and leases

Claiming is a single SQLite transaction that verifies eligibility, creates an attempt, creates the lease,
changes lifecycle to `in_progress`, increments the task version, and appends events. Completion and
failure require that attempt's active lease token and the current task version. A completion report is
stored immutably on the attempt; the effective review policy is resolved in the same transaction and
routes the task to `review` or `done`. Failure stores a classified report and returns the task to `ready`.

Review policy has three fixed scopes. A task override wins over tag overrides, and tag overrides win
over the project default. When several assigned tags disagree, `required` wins so adding a tag can make
review stricter but cannot silently bypass it; tag names and IDs provide a stable order for the
explanation returned with the task context and completion result. Only the local human may change an
override. Policy changes never add lifecycle states or weaken the normal version, lease, and transition
checks.

Lease renewal requires the lease token, current task version, and active run. Expiration makes the task
claimable again and closes the attempt as abandoned when cleanup observes it. Lease invalidation returns
work to ready; human task cancellation is a distinct attributed command that moves the task to
`cancelled`, closes active execution without success, and invalidates the token immediately. Late results
from any invalid lease are rejected without changing task or attempt history.

## Typed project fields

Project custom-field definitions use a fixed set of value types: text, number, boolean, ISO date, and
single select. Each definition owns its validation, optional default, display metadata, and stable
project-local key. The type and key are immutable after creation. Defaults are resolved at read time;
they do not rewrite every task row. Clearing an explicit task value therefore reveals its current
default (or an unset value).

Definitions can be reordered or retired. Retirement prevents new values but preserves the definition
and every historical task value, so old work, saved views, and audit evidence remain readable. The same
tagged value representation is used by task commands, structured filters, bulk previews, the UI, and
MCP context. Customization extends task metadata only: Helm's lifecycle enum and transition invariants
remain closed.

## MCP boundary

MCP uses the local server's supported HTTP transport. The tool surface is semantic rather than CRUD-shaped:

- Discover candidates and explain their order.
- Read a complete task context package.
- Atomically claim a chosen task or the next eligible task.
- Renew or release a lease and observe cancellation.
- Report progress, decisions, blockers, failure, and completion evidence.
- Create, update, relate, comment on, and reopen work.
- Dry-run and execute bulk commands.
- Read project events after a cursor.

Tools return compact structured data plus readable summaries. List calls paginate and select fields. Mutations support idempotency keys. Read tools have no write side effects.

## Realtime

Every committed event receives a monotonic SQLite sequence. The server publishes new sequences through an SSE endpoint. Clients reconnect with their last cursor, replay missed events from SQLite, then continue live.

The browser uses an event to invalidate only affected collection subsets or query keys. Optimistic local mutations remain visible while the server command persists; authoritative events reconcile them. Slow consumers can discard transient notifications and recover from the durable cursor.

## Client data and navigation

TanStack DB is the default for task-shaped reactive data. Collections use the TanStack Query adapter and are scoped to the router's QueryClient and business scope.

- Routes backed by TanStack DB disable SSR, define stable collections or live-query collections outside render, and await `collection.preload()` or `liveQuery.preload()` in the route loader.
- Components read preloaded data with Suspense-capable live queries inside error boundaries.
- On-demand collections preload the exact live query; preloading their source collection is a no-op.
- Non-reactive singleton data uses TanStack Query. Its route loader calls `queryClient.ensureQueryData(queryOptions)` and the component uses `useSuspenseQuery` with the same options.
- Links preload on intent. Search parameters participating in data selection are validated and included in loader dependencies.
- Loaders never import SQLite or filesystem modules. Server-only work lives behind server functions or server routes.

This division avoids duplicate caches: TanStack DB owns reactive task data; TanStack Query is its transport/cache adapter and owns only reads that do not justify a collection.

## Backend runtime

Effect owns application workflows, service dependencies, resource lifetime, typed errors, retries, and interruption. Drizzle owns SQL construction and migrations. SQLite transactions are exposed to application commands through a narrow repository service.

Adapters run one Effect program and translate known error tags. Unknown defects are logged with an event correlation identifier and become generic boundary errors. Domain modules do not call `Effect.runPromise`; the outer adapter owns execution.

SQLite enables foreign keys, WAL mode, and a bounded busy timeout. Writes remain short. Search uses SQLite full-text indexes maintained in the same transaction as task content.

## Presentation system

StyleX is the only styling authority for components and design tokens. Global CSS is limited to document normalization and generated StyleX output.

Base UI supplies accessible unstyled primitives. The shadcn Base UI registry may be consulted for composition and behavior, but generated utility classes are translated into repository-owned StyleX styles before code is accepted. Component variants are explicit TypeScript props; consumers cannot bypass tokens with arbitrary class strings.

Light and dark values live in exported StyleX variables. Desktop list workflows define the architecture. Narrow layouts receive inexpensive adaptations for monitoring, comments, review, reopen, and reprioritization; complex bulk editing and configuration may remain desktop-oriented.

## Security and portability

- Bind to localhost by default and reject accidental wildcard-host configuration without an explicit unsafe flag.
- Treat task text and repository content as untrusted data at protocol boundaries.
- Resolve repository paths under the configured project root before returning or opening them.
- Store no provider credentials in task records or audit payloads.
- Use consistent SQLite backups and versioned JSON exports.
- Make schema migrations forward-only and verify migration from supported fixture versions.

Portability has two deliberately different trust and fidelity boundaries:

- A SQLite backup is an exact whole-instance recovery artifact. SQLite's online backup API produces a
  consistent image while the live process continues serving reads and short writes. It preserves every
  table, event cursor, sequence, preference, idempotency record, lease, and historical row exactly. A
  restore is an offline operation into an absent database path. It opens the source with SQLite and
  creates another online snapshot so committed WAL pages cannot be omitted, verifies that staged image,
  and atomically refuses to replace any filesystem entry, including an empty file. The browser leaves
  this unbounded response on its native download path rather than buffering it into a Blob.
- A JSON export is a versioned semantic archive for one project. It contains project configuration,
  tags, custom-field definitions and explicit values, tasks, relations, saved views, relevant agent
  identities, attempts, activity, blockers, and source-event provenance. It intentionally excludes
  preferences, idempotency records, lease rows, token hashes, and MCP session identifiers. Active source
  runs are represented as closed history, active attempts as abandoned history, and in-progress work is
  made ready on import so an archive can never resume execution authority.

JSON and task-oriented CSV imports are local-human commands. Preview parses and validates the complete
source, reports creates, updates, no-ops, conflicts, and unsupported data, then binds that result to the
source bytes and current target state. Execution accepts only the matching preview token, applies the
semantic changes in one immediate transaction through normal command invariants, attributes them to the
local human, and appends fresh event cursors. Source event rows are preserved field-for-field inside
bounded provenance audit batches; importing never inserts their original cursors into the live event
sequence. Separate bounded entity batches record every create or update identity, previous and new
versions, and exact changed fields. Referenced repository paths are canonicalized and checked against the
destination repository during preview, then checked again inside execution so a path or symlink swap
cannot escape the repository or leave a partial import.

CSV imports compile to and execute through the ordinary bulk-task command engine. JSON import is a
dedicated application command because exact cross-aggregate identity, relation, attribution, and immutable
history restoration cannot be expressed by a task-only bulk operation. It still follows the normal command
contract: compiled input, local-human actor, semantic reason, state-bound preview, expected versions,
idempotency, one atomic projection-and-event transaction, and typed failures. JSON export and import share
the same 64 MiB serialized envelope and 100,000-record per top-level collection limits, including the
download newline, so a successful export remains within the matching importer's structural limits.

Merging JSON into an existing project treats each archived project, task, or saved-view version as the
expected local version. Identical records are no-ops; a supported mutable difference is applied only
when that expected version still matches, then the local aggregate advances once. Versionless identity
and execution-history records are immutable after creation, and omitted local records are not deleted.
This prevents a numerically newer archive from acting as an unverified last-write-wins clock across
divergent Helm instances.

## Primary test seam

The highest-value seam is an application command or query executed against a temporary SQLite database. It exercises domain rules, Effect services, Drizzle mappings, transactions, current projections, audit events, idempotency, and concurrency together.

Server-function and MCP tests stay thin: validate input, call the shared application operation, and assert serialized output and error mapping. UI tests cover the few workflows where rendering or optimistic behavior adds risk.
