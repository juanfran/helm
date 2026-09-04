---
name: helm-slice
description: Delivers Helm behavior as a tracer-bullet vertical slice through UI, application commands, SQLite, realtime, and MCP. Use when implementing an approved feature issue or changing a behavior exposed through more than one adapter.
---

# Helm vertical slice

## Workflow

1. Read the approved issue, [`docs/product.md`](../../../docs/product.md), and [`docs/architecture.md`](../../../docs/architecture.md). State the single demonstrable behavior.
2. Load the most specific TanStack Intent skills before editing framework code.
3. Define shared compiled Zod input/output schemas and tagged application errors.
4. Implement one Effect command or query. Keep domain policy here and persistence behind repository services.
5. Add or migrate Drizzle tables only as required by this behavior. Update the current projection and audit event in one transaction.
6. Expose the same operation through the necessary adapters. Server functions serve the app; raw server routes serve SSE or protocol contracts; MCP tools stay semantic.
7. Use TanStack DB for reactive task records. Preload the stable collection or live query in the route loader and render it through Suspense with an error boundary.
8. Add StyleX presentation using repository tokens and Base UI primitives.
9. Test the application seam first, then add thin adapter and critical UI tests.
10. Run `pnpm check` and `pnpm build`. Update the GitHub issue with behavior, verification, and remaining risk.

## Completion criteria

- The slice is demoable without unfinished horizontal layers.
- UI and MCP observe identical state transitions and errors.
- Agent-originated changes reach an open UI through the durable event cursor.
- Retry, stale-version, and transaction failure behavior is explicit.
