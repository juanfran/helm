# Product requirements

## Problem Statement

A developer working with several coding agents lacks a durable, local place to decide what should happen next, explain the work precisely, prevent duplicate execution, and review what humans and agents changed. General project tools are optimized for human teams. Plain task files are easy to create but weak at atomic claiming, deterministic prioritization, bulk changes, realtime observation, and machine-oriented discovery.

The result is fragmented context, agents selecting the wrong work, abandoned tasks, repeated failures, and an audit trail that cannot answer who changed what or why.

## Solution

Helm is a local control plane for one developer and many coding agents. SQLite is the source of truth. A fast human interface and a semantic MCP contract operate on the same command and query layer.

Humans and agents capture work, prepare it, prioritize it, schedule it, relate it, and update it in bulk. Agents discover eligible work by capability, atomically claim it with a renewable lease, report progress and evidence, and complete or fail an execution attempt. Humans can review, comment, request changes, or reopen work without losing earlier attempts. Every mutation records an immutable event attributed to a human, agent profile, and agent run.

Helm does not execute agents. External agents connect to the local server and decide when to request work.

## User Stories

1. As a developer, I want to create a local project for a repository so that Helm can organize its work without an account.
2. As a developer, I want to capture an incomplete idea in an inbox so that it is not accidentally offered to an agent.
3. As a developer, I want to turn an idea into ready work so that an agent receives an actionable task.
4. As a developer, I want task descriptions and acceptance criteria stored separately so that completion can be evaluated consistently.
5. As a developer, I want to add agent-specific context without cluttering the human summary so that both audiences get useful instructions.
6. As a developer, I want tasks with one level of subtasks so that work can be decomposed without creating an unreadable hierarchy.
7. As a developer, I want to relate tasks as blocking, related, duplicate, or discovered work so that execution and provenance are clear.
8. As a developer, I want dependency cycles rejected so that eligibility stays deterministic.
9. As a developer, I want urgent, high, normal, and low priorities so that broad importance is visible.
10. As a developer, I want to manually order tasks within a priority so that ties reflect my intent.
11. As a developer, I want Helm to explain task ordering so that prioritization never feels arbitrary.
12. As a developer, I want a task hidden from agents until its start date so that future work does not begin early.
13. As a developer, I want an optional due date and size estimate so that I can plan without inventing precise hours.
14. As a developer, I want tags with descriptions and colors so that work can be organized consistently.
15. As a developer, I want tasks to require capabilities so that different agents can focus on different work.
16. As a developer, I want mutually exclusive tag groups when useful so that invalid classifications are prevented.
17. As a developer, I want typed custom fields so that Helm can adapt to my workflow without changing its core lifecycle.
18. As a developer, I want saved filtered views so that recurring work queues are one action away.
19. As a developer, I want full-text search combined with structured filters so that I can find work and history quickly.
20. As a developer, I want list-first views with dense selection controls so that bulk work remains efficient.
21. As a developer, I want to preview a bulk update so that I know exactly which tasks it will affect.
22. As a developer, I want bulk changes to share the normal command path so that their audit history is complete.
23. As a developer, I want a dashboard of claimable, active, blocked, failed, and review work so that I can understand the system at a glance.
24. As a developer, I want an activity view attributed to humans and agents so that I can reconstruct decisions.
25. As a developer, I want open pages to update immediately when agents change work so that I do not refresh manually.
26. As a developer, I want important in-app notifications without constant noise so that failures and reviews get attention.
27. As a developer, I want light and dark themes so that the interface fits my environment.
28. As a developer, I want essential monitoring and review actions to fit narrow screens when inexpensive so that responsiveness does not distort the desktop architecture.
29. As a developer, I want to archive work rather than destroy it so that history remains trustworthy.
30. As a developer, I want JSON and Markdown exports so that my data is portable and readable.
31. As a developer, I want a consistent SQLite backup so that local data can be restored safely.
32. As a developer, I want dry-run imports from JSON or CSV so that large migrations can be validated before writing.
33. As an agent, I want to register a profile and run with capabilities so that my activity has a durable identity.
34. As an agent, I want to search candidate work without claiming it so that supervised workflows can inspect the choice.
35. As an agent, I want an atomic claim-next operation so that autonomous workers cannot duplicate execution.
36. As an agent, I want each candidate accompanied by an ordering explanation so that I can communicate why it was selected.
37. As an agent, I want a renewable lease so that active work remains mine while abandoned work recovers automatically.
38. As an agent, I want to learn when my lease is cancelled or invalidated so that a late result cannot overwrite human intent.
39. As an agent, I want a complete task context package so that I can begin with relevant instructions, paths, history, and acceptance criteria.
40. As an agent, I want to report progress, blockers, failures, and decisions with semantic commands so that updates stay machine-readable.
41. As an agent, I want completion to include evidence and verification results so that review starts with useful facts.
42. As an agent, I want reopened work to create a new attempt linked to prior failures so that I do not repeat them blindly.
43. As an agent, I want idempotent writes and optimistic concurrency errors so that retries cannot duplicate or erase changes.
44. As an agent, I want bulk mutations to require a dry run so that broad changes are explicit and recoverable.
45. As an agent, I want to read events after a cursor so that I can notice changes without rescanning the entire project.

## Implementation Decisions

- The product targets one developer and multiple local coding agents on one machine.
- The server binds to `127.0.0.1` by default. Network exposure is unsupported without a future authentication design.
- SQLite is authoritative. Repository files and external tracker items are references, not synchronized sources of truth.
- A project maps to one repository root. Multi-repository projects are deferred.
- A task may have one parent; nesting beyond a parent and its direct children is rejected.
- Lifecycle state and execution eligibility are separate. Lifecycle records intent and progress; eligibility derives claimability, scheduling, and blocking from dates, dependencies, review policy, and active leases.
- Core lifecycle values remain fixed. Custom fields, tags, views, and review policies provide workflow flexibility without redefining lifecycle semantics.
- Ordering combines explicit priority, manual position, satisfied dependencies, start date, capability match, and stable age. Queries return a human-readable explanation.
- Only blocking relations affect eligibility. Informational relations do not.
- An attempt records one execution of a task. Reopening preserves the task and prior attempts; the next successful claim creates a new attempt.
- Claims use atomic, renewable, expiring leases. Cancellation, reassignment, or version conflict invalidates stale completion.
- Completion reports include a result summary, changed areas, verification, references, risks, and follow-up work.
- Review policy can be set by project, tag, or task. The most specific policy wins.
- Every successful mutation appends an immutable attributed event in the same SQLite transaction as the current-state projection.
- Corrections are new commands and events. Tasks are archived, and withdrawn comments retain audit metadata.
- Human, agent profile, and agent run are distinct actor concepts. MCP sessions are associated with registered runs.
- Rich text is edited with TipTap, stored as a versioned structured document, and projected to stable plain text for search and MCP.
- A ready task requires a title, expected outcome, acceptance criteria, and at least one checklist item. Description and agent context remain optional; backlog capture requires only a title.
- The UI is list-first. Inbox, Ready, Scheduled, Active, Review, Activity, saved views, task detail, and an operational dashboard form the primary information architecture.
- Realtime UI updates use a local ordered event stream. Toasts are reserved for failures, blockers, expired claims, and requested reviews.
- UI and MCP call the same semantic command and query modules. Generic read operations never mutate state.
- MCP offers explicit discovery, claim, lease, progress, completion, relation, comment, and bulk tools. It also exposes cursor-based event reads.
- Bulk updates can refresh task content as well as planning metadata. An explicit, previewed reconciliation intent lets an authorized importer refresh matched external work with individual task versions, source references, and content/state patches. External in-progress and completed states record source progress without creating Helm leases, attempts, verification evidence, or review approval. Reconciliation cannot overwrite active Helm execution or pending review; source attribution and before/after changes remain in the audit trail.
- Bulk commands support ID and filter selection, a dry run, stable affected counts, and a parent audit event.
- Full-text search covers task content, acceptance criteria, comments, and reports. Structured filtering is shared by UI, views, bulk commands, and MCP.
- Installation targets Node.js developers: `pnpm install`, `pnpm dev`, `pnpm build`, and `pnpm start`. A small shell launcher is included.
- Mobile support is opportunistic. Essential monitoring and review actions may be responsive, but mobile requirements cannot complicate the architecture or delay desktop behavior.

## Testing Decisions

- The primary test seam is the application command/query boundary against a temporary SQLite database.
- Command tests assert externally observable state, emitted events, attribution, versions, and transactional rollback rather than internal helper calls.
- Ranking and eligibility tests cover stable ordering, dates, dependencies, capability matching, and cycle rejection.
- Concurrency tests race claims, lease renewal, cancellation, retries, stale versions, and late completion.
- Adapter contract tests run the same behavior through server functions and MCP tools with minimal boundary-specific assertions.
- Realtime tests reconnect from an event cursor and prove that no committed event is lost or duplicated.
- UI tests focus on critical workflows: capture, prepare, bulk preview, claim visibility, review, reopen, and conflict recovery.
- Migration tests open previous schema fixtures and verify both projected state and audit history.
- Backup and import tests restore into a clean process and compare observable project data.

## Out of Scope

- Running, supervising, or terminating coding-agent processes.
- Authentication, accounts, teams, remote collaboration, or default LAN access.
- Projects spanning multiple repositories.
- Unlimited task hierarchy.
- Arbitrary scripts or a general automation engine.
- Fully customizable lifecycle states.
- Bidirectional synchronization with external services.
- Managed binary attachments.
- Recurring tasks.
- Native mobile applications or a mobile-first interface.
- Productivity scoring, agent rankings, velocity, or surveillance metrics.
- Operating-system notifications in the first release.

## Further Notes

The release loop is: capture, prepare, prioritize, discover, claim, execute, report, review or reopen, and audit. The MVP is successful when that loop remains fast and understandable with concurrent agents, failures, retries, and bulk edits.
