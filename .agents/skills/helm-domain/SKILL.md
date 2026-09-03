---
name: helm-domain
description: Preserves Helm task lifecycle, eligibility, ranking, attempts, leases, relations, and audit invariants. Use when changing task state, scheduling, dependencies, priority, agent identity, claiming, completion, reopening, or history.
---

# Helm domain

## Workflow

1. Read the relevant product behavior in [`docs/product.md`](../../../docs/product.md) and domain design in [`docs/architecture.md`](../../../docs/architecture.md).
2. Name the command and its externally visible result before editing storage or adapters.
3. List every invariant the command can affect: lifecycle, eligibility, version, lease, attempt, relation cycle, attribution, and audit event.
4. Implement the rule in the domain/application boundary. Keep UI, MCP, and persistence free of independent policy.
5. Persist projection changes and events in one SQLite transaction.
6. Test the command through the application seam against temporary SQLite. Cover success, stale version, idempotent retry, and rollback where applicable.
7. Run `pnpm check` and `pnpm build`. The change is complete when every affected invariant has an observable assertion.

## Invariants

- Lifecycle and eligibility are separate axes. Scheduled, blocked, claimable, and claimed are derived facts.
- Task nesting stops after one parent and its direct children.
- Blocking relations remain acyclic; informational relations never change eligibility.
- Candidate ordering is deterministic and returns an explanation.
- One valid lease may exist for a task. Claim, attempt creation, lifecycle change, version increment, and events are atomic.
- A stale or cancelled lease cannot complete work.
- Reopening preserves earlier attempts and starts a new one.
- Actor identity comes from human context or a registered agent run.
- Corrections append events; normal product flows archive instead of destroying history.