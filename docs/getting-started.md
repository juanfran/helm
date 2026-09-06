# Your first human–agent workflow

This guide takes one task from an idea to an agent's verified result and your approval.
You run Helm and your coding agent separately: Helm coordinates the work; the agent edits your repository.

## 1. Start Helm and connect a repository

You need Git, Node.js 22.13 or newer, and pnpm 11.

```sh
git clone https://github.com/juanfran/helm.git
cd helm
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and leave the server running.
If that port was busy, use the URL printed in the terminal and use the same port for MCP below.
In **Repository root**, enter the absolute path to an existing local Git repository,
such as `/home/me/projects/my-app`, then choose **Create project**. This is the repository
you want to manage, not necessarily Helm's own checkout. Helm does not clone or initialize it for you.

Later, use **Switch project → Add project** to connect another repository.
Each project has its own tasks; switching the browser does not retarget an agent's explicit `projectId`.

For a normal production run, use `pnpm build` followed by `pnpm start` instead of `pnpm dev`.
Database location, configuration, upgrades, and backups are covered in [Operations](operations.md).

## 2. Capture an idea, then make it actionable

In **Tasks**, type `Show a helpful empty search result` into **Capture a task…** and press
Enter or the plus button. It starts in **Backlog**. A title is enough to save an idea;
agents cannot claim backlog tasks.

Select the task and fill in:

| Field                    | Example                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Expected outcome         | People understand when their search has no matches and can clear it.                                                     |
| Acceptance criteria      | An unmatched query shows a clear empty state. Clearing the query restores results. Existing search behavior still works. |
| Checklist                | Add a regression test for no matches. Then, on a new line: Verify clearing the query restores results.                   |
| Agent context (optional) | Use the existing components and test runner. Do not add dependencies.                                                    |

Use **Save draft** whenever you want to keep partial instructions. It saves the whole form, including
planning fields, without making the task available to agents. Pressing Enter in a single-line field
also saves; it does not move a backlog task to Ready.

Choose **Move to ready** when the instructions are complete. Readiness requires the title, expected outcome, acceptance criteria,
and at least one checklist item. Description and agent context are optional.

Open **Planning and agent instructions** for priority, dates, tags, capabilities, and agent context.
On ready tasks, **Save changes** saves content and planning together. Cancellation is a separate
**Cancel task…** action below the task; it asks for a reason before changing anything.

### Navigate without losing your work

Every task has its own `/<projectId>/tasks/<taskId>` URL. Open tasks from the queue,
Search, or a saved view; copy the browser address to return directly to that task. Browser Back
restores the previous page. On a narrow screen, **Back to tasks** returns to the queue.

Project pages use concrete file-based routes:

| Page       | Path                          |
| ---------- | ----------------------------- |
| Tasks      | `/<projectId>/tasks`          |
| Dashboard  | `/<projectId>/dashboard`      |
| Activity   | `/<projectId>/activity`       |
| Settings   | `/<projectId>/settings`       |
| Search     | `/<projectId>/search`         |
| Saved view | `/<projectId>/views/<viewId>` |

Project and page identity never come from query parameters. Search adds only actual filter values
(for example, `/<projectId>/search?q=review`); empty/default values are omitted. `/` is the app entry:
it opens the selected project's task queue, or setup when no project is selected. Old URLs are not
supported or redirected for compatibility.

Unfinished edits are kept in the current browser tab across navigation and reloads, but they are
not shared with agents until you save. If browser storage is unavailable, Helm warns you and keeps
edits in memory while the app remains open. Save before closing the tab.

If an agent or another window changes the task while you are editing, Helm keeps your text and
pauses saving. **Keep my edited fields** applies only your changed fields to the latest version;
**Use latest saved task** discards your local edits after confirmation. An active or completed task
stays read-only; retaining a draft does not bypass its lifecycle.

**Switch project** opens a compact menu. Close it with Escape, the close button, or a click outside.
Dashboard, Tasks, Activity, Settings, and Search use the same navigation throughout the app.

Leave required capabilities empty for this first task. For later work, capability requirements
must match capabilities advertised by the agent. Priority, manual position, due date, and age
determine ordering; a future start date or unresolved blocker can keep ready work unclaimable.

In **Settings**, leave **Agent completion** set to **Require human review**. This is the default.
Task and tag overrides can change the effective policy, which is shown in the task detail.

## 3. Connect your coding agent through MCP

MCP lets your coding agent use Helm's tools. It does not give Helm permission to launch the agent
or give the agent filesystem access by itself. Open your coding agent with access to the same
repository and add a server in that client's MCP settings:

| Setting        | Value                           |
| -------------- | ------------------------------- |
| Name           | `helm`                          |
| Transport      | Streamable HTTP                 |
| URL            | `http://127.0.0.1:3000/api/mcp` |
| Authentication | None                            |

Use an HTTP server entry, not a stdio command or a legacy SSE endpoint. Configuration-file
keys vary between clients; enter these values in your client's supported HTTP configuration.
If Helm uses a different port, use that port in the URL. Reload or reconnect the client after saving.

The client must run on the same machine and be able to reach Helm's loopback address.
A cloud-only connector cannot reach your laptop's `127.0.0.1`. Do not expose this unauthenticated
server to the internet or add a public tunnel to work around that limitation.

Check the connection with this prompt:

> Use Helm's `list_projects` tool. Show me the project names and repository paths without changing anything.

You should see the repository you connected. If Helm's tools do not appear, check that the server
is still running, the URL ends in `/api/mcp`, and the client supports Streamable HTTP.
Opening the MCP URL as a normal web page is not a connection test.

Helm supplies a short workflow guide when the client connects. An agent with no prior Helm context
can also call `get_helm_guide` without registering; clients with resource browsing can read the same
guide at `helm://guide`. It includes request examples, project selection, claims, renewal, version
conflicts, retry safety, and the human-review handoff.

## 4. Give the agent one task

Start with a supervised handoff. Replace the repository path in this prompt:

> Use Helm for `/home/me/projects/my-app`. Register this session as an agent run with profile key
> `local-worker` and display name `Local worker`. List candidate work with `find_work`, explain
> the order, and read the full context of “Show a helpful empty search result”. Claim that task
> before editing files. Follow its acceptance criteria and repository instructions. Keep the lease
> renewed while working, report meaningful progress, run the relevant checks, and submit a completion
> report with evidence. Stop after this one task; do not publish or release anything.

The task moves to **In progress** only after a successful claim. Its active attempt identifies
the agent run and lease expiry. Keep the browser open: task changes and activity arrive live.

Most users can continue to [review the result](#5-review-the-result-as-a-human).
Expand the reference below when configuring an agent's instructions or troubleshooting a tool call.

<details>
<summary>Tool argument reference: register, discover, claim, renew, report, complete</summary>

These examples are tool argument objects, not shell commands.

First call `list_projects` with `{}` and take the project's actual `id`. Then call
`register_agent_run` once for this MCP session:

```json
{
  "profileKey": "local-worker",
  "displayName": "Local worker",
  "capabilities": ["typescript"],
  "idempotencyKey": "tutorial-register-001"
}
```

Keep the returned `registration.run.id` for reconnect recovery. Capabilities describe what this
worker can handle; they do not automatically equip it with languages, tools, or permissions.

Call `find_work`:

```json
{
  "projectId": "PROJECT_ID",
  "limit": 5
}
```

Replace `PROJECT_ID` with the returned opaque ID, not the display name or sequence number.
Discovery is read-only: another worker may claim a candidate before you do.
Read `get_task_context` with `{"projectId":"PROJECT_ID","taskId":"TASK_ID"}` for instructions,
acceptance criteria, repository paths, prior attempts, and the current `context.task.version`.

For an approved candidate, call `claim_task` with its current version:

```json
{
  "projectId": "PROJECT_ID",
  "taskId": "TASK_ID",
  "expectedVersion": 2,
  "leaseDurationSeconds": 900,
  "idempotencyKey": "tutorial-claim-001"
}
```

Here and below, numeric versions are examples: use the actual current version, never a guessed
increment. A successful result includes `grant.task.version`, `grant.leaseToken`, the attempt,
and `grant.claim.expiresAt`. Keep the lease token private in the agent's working state; do not
paste it into task comments, reports, or repository files.

An autonomous worker can use `claim_next` instead, with `projectId`, `leaseDurationSeconds`,
and `idempotencyKey`. Helm atomically chooses and claims the highest-ranked eligible task;
the worker must read its full context before starting implementation.

For longer work, call `renew_lease` well before expiry:

```json
{
  "leaseToken": "LEASE_TOKEN",
  "expectedVersion": 3,
  "leaseDurationSeconds": 900,
  "idempotencyKey": "tutorial-renew-001"
}
```

Use the returned current task version and expiry for subsequent work. Lease durations range
from 30 to 3,600 seconds; the default is 900 seconds. Progress messages do not renew leases.

To call `report_progress`, use versioned rich-text content:

```json
{
  "entryId": "tutorial-progress-001",
  "projectId": "PROJECT_ID",
  "taskId": "TASK_ID",
  "leaseToken": "LEASE_TOKEN",
  "expectedTaskVersion": 3,
  "idempotencyKey": "tutorial-progress-command-001",
  "content": {
    "version": 1,
    "doc": {
      "type": "doc",
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "The empty state is implemented; regression checks are running."
            }
          ]
        }
      ]
    }
  }
}
```

After implementation and verification, call `complete_task`. Report only checks actually run;
the following is an example report, not evidence that your task has passed:

```json
{
  "projectId": "PROJECT_ID",
  "taskId": "TASK_ID",
  "leaseToken": "LEASE_TOKEN",
  "expectedVersion": 3,
  "idempotencyKey": "tutorial-complete-001",
  "report": {
    "resultSummary": "Added the empty search state and clear-search action.",
    "changedAreas": ["Search results component", "Search regression tests"],
    "verificationResults": [
      {
        "name": "Search regression tests",
        "status": "passed",
        "details": "No-match and clear-query cases passed."
      }
    ],
    "references": [],
    "risks": [],
    "followUpWork": []
  }
}
```

Each new mutation needs a fresh idempotency key; an exact retry after an uncertain network result
must reuse the original key and arguments. Do not reuse these sample keys for different operations.
If Helm reports a version conflict, reread context and reconcile the change before issuing a new
command. If it reports an expired or invalid lease, stop acting as the owner; changing the version
does not restore authority.

</details>

## 5. Review the result as a human

With human review required, completion moves the task to **Review**, not **Done**.
Select it and inspect the report, changed code, and verification evidence.

- Satisfied? Enter an **Approval summary** and choose **Approve**.
- Need corrections? Enter a **Change request summary** and **Requested changes** (one per line),
  then choose **Request changes**. The task returns to ready for another attempt.
- Found a problem after approval? Use **Reopen**, choose ready or backlog, and record why.

Earlier attempts and reports remain available under **Previous attempts**. Reopening does not
resume an old lease: the next successful claim creates a new attempt. **Activity** records who
changed what, and **Open collaboration** on a task shows its discussion and manual blockers.

## More workflows

### Several agents, without duplicate tasks

Prepare small, independently testable tasks. Run each worker in its own MCP session with a distinct
profile key, for example `ui-worker` and `test-worker`, and relevant capabilities. Give each this prompt:

> Register this session with my worker identity and capabilities. For the specified Helm project,
> use `claim_next`, read the claimed task's full context, implement it, renew the lease, and submit
> evidence. Work on only one task at a time. If no eligible work remains, stop and report that.

Atomic claims prevent two agents owning the same task. They do not prevent different tasks editing
the same files: use separate Git worktrees or another deliberate source-control workflow, and review
integration yourself. Helm neither creates worktrees nor merges branches.

### A dependency must finish before another task starts

Create and prepare “Add the search API” and “Connect the search UI”. Select the API task, set its
relation type to **Blocks**, choose the UI task as the target, then choose **Add relation**.
The direction is “this task blocks that task”.

The UI task stays unclaimable until the API task is done. With human review required, submitting the
API report is not enough: approve it first. A related-task link or a parent/subtask relationship
alone is not a blocking dependency.

### Work needs a human decision, or a worker disappears

An agent with an active lease can use `report_blocker` to record the decision it needs, then
`release_lease` if it cannot continue. A failed attempt can instead be reported through `fail_task`,
with a classification, reason, and evidence; failure returns the task to ready, so add an explicit
blocker when retrying must wait for a human.

In the browser, open the task's **Open collaboration** section. Add a **Manual blocker reason**
and choose **Report blocker**, or choose **Resolve** on an existing blocker and record its resolution.
Choose **Save resolution** to finish. Only the local human can resolve manual blockers.
A blocker does not itself cancel an existing
lease; coordinate stopping the worker or use the task's claim controls when ownership must end.

If a worker disappears, its expired claim is recovered and the abandoned attempt remains in history.
For a disconnected MCP client, reconnect and register again. To resume a known run, supply its
`resumeRunId`; do not use `takeoverActiveRun` unless intentionally replacing that active session.
Recheck context and lease validity before continuing, and never submit a late result with a stale token.

### Find, organize, and inspect the queue

Use **Search** for text and structured filters, then save a recurring queue as a saved view.
Use the dashboard for claimable, active, blocked, failed, and review work; use **Activity** for the
attributed timeline. Before applying bulk changes, preview the affected tasks and confirm that
selection matches your intent.

For backup, restore, and import/export instructions, continue to [Operations](operations.md).
For the short product overview, return to the [README](../README.md).
