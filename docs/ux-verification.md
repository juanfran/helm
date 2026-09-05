# UX fixes and verification

Tracking: [#23](https://github.com/juanfran/helm/issues/23). The issue contains the original
2026-09-05 audit and reproduction steps.

Follow-up [#24](https://github.com/juanfran/helm/issues/24) replaces project/view query navigation
with concrete project-scoped file routes. Task URLs are now `/<projectId>/tasks/<taskId>` and
workspace pages use `/<projectId>/tasks`, `/dashboard`, `/activity`, and `/settings`. Search and
saved views are project-scoped too; only actual search/filter/pagination values use query strings.
There are no legacy compatibility redirects. Route tests cover default stripping and path identity;
the browser smoke covers direct visits, refresh/back, new tabs, and missing/old URLs.

## Interaction contract

| Original finding                                 | Implemented behavior                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning saves discarded content                 | One save submits preparation and planning together.                                                                                            |
| Navigation and agent updates erased edits        | Recoverable per-tab drafts, explicit version-conflict reconciliation, and a close-tab warning.                                                 |
| Incomplete preparation could not be saved        | Save draft keeps backlog work unclaimable; Move to ready validates complete instructions. Enter saves without transitioning.                   |
| Tasks and workspace sections had no URL identity | Project-scoped task URLs; URL-backed workspace views and queue filters.                                                                        |
| Search and saved views could not open tasks      | Real task links, separate from bulk-selection checkboxes.                                                                                      |
| Cancellation displaced the task                  | Content first, optional planning/relations, review reports prominent only during review, secondary Archive and reason-gated Cancel task.       |
| Planning fields overlapped                       | Available-width grid, constrained controls, associated labels, and a full-width review-policy section.                                         |
| Utilities were one-way launchers                 | Dismissible project popover; single-click notifications; one appearance control; explicit exit from bulk selection.                            |
| Search navigation was misaligned                 | Shared navigation links and a layered CSS reset that preserves production typography.                                                          |
| Mobile stacked detail above the queue            | Separate list/detail presentation with Back to tasks and deliberate detail-heading focus.                                                      |
| Navigation changed between surfaces              | Shared project header, primary navigation, utilities, and project-preserving search/pagination. Saved views are also reachable from the queue. |
| Copy and oversized introductions obscured work   | Compact Search tasks and Dashboard headings; shorter task-oriented instructions.                                                               |
| Visible field labels were not associated         | Stable input IDs, real labels, linked descriptions, and consistent control sizing.                                                             |

Additional protections preserve checklist identity/completion during unrelated saves, keep
cancellation errors inside their dialog, and suppress unavailable lifecycle actions on archived tasks.

## Repeatable checks

Run these **sequentially**: the operational smoke intentionally invalidates and rebuilds production
output, so it must not run alongside another production build or browser smoke.

```sh
pnpm check
pnpm build
pnpm smoke:workflow
pnpm smoke:operational
```

The workflow smoke uses an isolated SQLite database and repository. It exercises partial saves,
refreshable task URLs, draft recovery after navigation, real competing MCP claims, an agent update
while a human has unsaved edits, completion/review/reopening, search and saved views, mobile
list/detail navigation, menu dismissal/focus restoration, and route failure/retry.

It also checks navigation geometry and date-field overlap/horizontal overflow at 390, 800, 1024,
1280, and 1440 pixels. Unit/application coverage includes draft recovery, storage failure fallback,
conflict reconciliation, partial-draft lifecycle restrictions, transaction rollback, stale versions,
idempotent retries, checklist preservation, keyboard saving, and dialog errors.

Manual Chromium inspection covers the built task form, project menu, search, and mobile planning
in light and dark themes. This is not a claim of exhaustive assistive-technology or cross-browser
certification. The user's development database is never used for test mutations.

The existing stack and existing loading budgets remain in place. The new direct-task route has
its own cumulative budget, including its automatically loaded detail form; see
[Client bundle budget](client-bundle-budget.md). No release is required to test these changes locally.

For everyday usage, see [Your first human–agent workflow](getting-started.md).
