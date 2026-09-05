# Client bundle budget

Helm treats route loading as a production contract. The production Vite build emits
`.output/public/.vite/manifest.json`; `pnpm bundle:check` follows that manifest's static import graph,
reads the emitted client JavaScript, and rejects a build that exceeds any limit below.

All limits use decimal bytes (1 kB = 1,000 bytes). Gzip measurements compress each emitted file
independently with Node.js `gzipSync` at level 9 and `mtime: 0`, matching the bytes transferred for
separate HTTP assets while keeping results deterministic.

| Measurement                                     | Raw limit | Gzip limit |
| ----------------------------------------------- | --------: | ---------: |
| Initial client shell                            |    500 kB |     150 kB |
| Any individual JavaScript asset                 |    450 kB |     140 kB |
| Any dynamic-entry increment                     |    500 kB |     160 kB |
| `/` navigation                                  |    900 kB |     280 kB |
| `/search` navigation                            |    850 kB |     260 kB |
| `/views/$viewId` navigation                     |    850 kB |     260 kB |
| `/projects/$projectId/tasks/$taskId` navigation |  1,050 kB |     330 kB |

The limits were fixed from the Node.js 22.13.0 production graph on 2026-09-04. That baseline measured
369,866 raw / 120,145 gzip bytes for the client shell, 871,529 / 263,442 for `/`, 837,132 /
254,276 for `/search`, and 830,228 / 252,685 for `/views/$viewId`. Search and saved views both
legitimately include the same 409,296 raw / 114,054 gzip TanStack DB reactive-query path; their rounded
850/260 ceilings retain narrow regression headroom without weakening the shell, asset, dynamic-entry,
or workspace limits.

Issue [#23](https://github.com/juanfran/helm/issues/23) adds addressable task detail. Its new
1,050/330 ceiling includes the task form automatically loaded on a direct visit (measured at
985,204 raw / 300,919 gzip bytes during implementation). Existing route, shell, asset, and
dynamic-entry limits are unchanged.

The route split increments at that baseline were:

| Lazy route entry                 | Raw bytes | Gzip bytes | Applied increment budget |
| -------------------------------- | --------: | ---------: | -----------------------: |
| `/` loader                       |   346,233 |     96,429 |            500 kB/160 kB |
| `/` component                    |   499,322 |    142,002 |            500 kB/160 kB |
| `/` error component              |       297 |        235 |            500 kB/160 kB |
| `/search` loader                 |   348,732 |     97,430 |            500 kB/160 kB |
| `/search` component              |   464,446 |    132,444 |            500 kB/160 kB |
| `/search` error component        |       389 |        292 |            500 kB/160 kB |
| `/views/$viewId` loader          |   348,824 |     97,471 |            500 kB/160 kB |
| `/views/$viewId` component       |   457,146 |    130,545 |            500 kB/160 kB |
| `/views/$viewId` error component |       390 |        298 |            500 kB/160 kB |

The measurements are defined as follows:

- The **client shell** is the JavaScript entry and the complete closure of its static imports.
- An **asset** is one emitted JavaScript file. Multiple manifest records that name the same file count
  it once.
- A **dynamic-entry increment** is the new network payload at the point that entry can load. Route split
  entries are measured against the client shell. A nested interaction entry is measured against the
  static closure of its owning dynamic parent and that parent's loading ancestry. When the parent is a
  route split entry, the baseline includes that route's complete loader/component/error closure. If
  several parents can load the same entry, only files guaranteed to be present on every path are
  deducted. An entry reachable both directly from the client and from a nested parent therefore remains
  shell-relative. The checker measures the union of entries Vite flags with `isDynamicEntry` and every
  manifest key referenced by `dynamicImports`; a missing referenced key is a gate failure.
- A **navigation** is every byte downloaded to render a route before user interaction: the client shell,
  the route's loader/component/error-component closures, and the static closures of every automatic
  dynamic descendant declared navigation-critical. Files shared by any of those closures count once.
  Navigation budgets are therefore cumulative; splitting an automatic surface into several individually
  compliant chunks cannot bypass them.

The checker also requires separate dynamic manifest entries for each route property below. This makes a
route regression fail even when minification happens to keep its combined chunk below the byte limit.

| Route                                | Required split entries             |
| ------------------------------------ | ---------------------------------- |
| `/`                                  | loader, component, error component |
| `/search`                            | loader, component, error component |
| `/views/$viewId`                     | loader, component, error component |
| `/projects/$projectId/tasks/$taskId` | loader, component, error component |

`CLIENT_NAVIGATION_CRITICAL_SOURCES` in `scripts/client-bundle-budget.mjs` is the source-based contract
for dynamic modules requested automatically while a route renders. Each configured source must resolve
to one manifest entry, be dynamic either by flag or reference, and be reachable from its owning route's
split graph. Missing, non-dynamic, ambiguous, and unreachable declarations fail with distinct
diagnostics. A dynamic import triggered only after focus, pointer intent, or activation does not belong
in this map; it remains an interaction increment instead.

| Navigation                           | Automatically requested dynamic source                            |
| ------------------------------------ | ----------------------------------------------------------------- |
| `/`                                  | `src/features/projects/project-landing.tsx` (first-project setup) |
| `/search`                            | None                                                              |
| `/views/$viewId`                     | None                                                              |
| `/projects/$projectId/tasks/$taskId` | `src/features/tasks/task-detail-panel.tsx`                        |

The workspace, search page, and saved-view page are static dependencies of their route component
splits, so their bytes already belong to those route closures. Their optional dynamic descendants are
activated only by explicit user intent and therefore stay outside the navigation map, except the
first-project setup and direct task detail listed above. The home budget conservatively includes
setup even when an existing project makes that download unnecessary.

`src/features/dashboard/operational-dashboard.tsx` and
`src/features/tasks/rich-text-editor.tsx` must also remain dynamic entries. They are interaction-heavy
surfaces and must not silently rejoin a route's initial closure. Their emitted files must be absent from
every normal route navigation closure. The emitted files for every required route and feature entry must
also be absent from the client shell's static closure, even when Vite still marks the corresponding
manifest record as dynamic.

## Running and diagnosing the gate

`pnpm build` always runs the checker after Vite finishes and before Helm marks `.output` as a current
production build. A failure therefore cannot leave a valid build fingerprint. CI additionally runs
`pnpm bundle:check` against the emitted output so the budget is visible as an explicit repository gate.
For a local recheck without rebuilding, run:

```sh
pnpm bundle:check
```

Failure diagnostics list every violation in stable order rather than stopping at the first one. The
target says whether the regression belongs to an individual asset, the shell, a dynamic increment, a
navigation, or a missing split entry. Inspect the manifest's `imports` and `dynamicImports` from that
logical source before changing a limit. Typical fixes are moving interaction-only modules behind a
dynamic import, keeping route declaration files thin, or removing a heavy dependency from a shared
loader/search-parameter module.

Do not raise a limit to make an incidental build pass. Record a new measured baseline and the user-facing
reason in an approved issue, then update the checker, this table, and its tests together when a larger
budget is an intentional product decision.
