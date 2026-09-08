// MCP-only documentation: shared domain parsers and browser bundles remain unchanged.
export const inputDescriptions: Readonly<Record<string, string>> = {
  projectId:
    "Opaque project ID from list_projects. Match repositoryRoot to the user's intended repository; the active browser project is only a preference.",
  taskId:
    "Opaque task ID returned by discovery, search, creation, or context; not the human task sequence number.",
  sourceRef:
    "External tracker reference or URL identifying the source task. Required for each explicit reconciliation; recorded in audit history, never fetched by Helm.",
  taskIds: "Opaque task IDs from the same project, not task sequence numbers.",
  profileKey:
    "Stable identifier for your agent profile, e.g. local-typescript-agent. Reuse your own profile, not another agent's identity.",
  displayName: "Human-readable name shown in task history and the active-agent dashboard.",
  capabilities:
    "Capabilities you can actually provide (registration), or explicit add/remove capability changes (bulk patch). Names match case-insensitively; omitting registration capabilities means none.",
  resumeRunId:
    "Your previously returned registration.run.id when reconnecting. Omit for a new run; resuming does not restore invalidated leases.",
  takeoverActiveRun:
    "Only for an intentional handover of your own still-active run. Displaces its old MCP session; not a way to take another agent's work.",
  idempotencyKey:
    "Generate a unique key for each logical mutation (e.g. UUID). Retry the identical request with the same key after a lost response. Changed arguments or a new renewal require a new key.",
  expectedVersion:
    "Use 0 when creating a new task. Otherwise use the latest task.version from a result/context. Refresh and reconcile a version conflict before submitting a new request.",
  expectedTaskVersion:
    "Latest task.version for the task receiving this entry or blocker; use the returned task version for subsequent writes.",
  expectedSourceVersion: "Latest version of sourceTaskId from its task context.",
  expectedTargetVersion: "Latest version of targetTaskId from its task context.",
  leaseToken:
    "Opaque grant.leaseToken from claim_task, claim_next, or renew_lease. Keep it private to this run; never place it in task text, reports, or logs.",
  leaseDurationSeconds:
    "Requested lease duration in seconds (30–3600; default 900). Renew before grant.claim.expiresAt; progress reports do not renew it.",
  cursor:
    "Opaque nextCursor from the previous page of the same query. Omit/null for the first page; restart without it after a stale-cursor error.",
  afterCursor:
    "Last processed numeric event cursor; omit or use 0 to read from the beginning. Continue with payload.nextCursor.",
  limit:
    "Maximum results in this page; use the advertised default and bounds. Follow nextCursor for additional results.",
  savedViewId: "Opaque saved-view ID from list_saved_views.",
  filter:
    "Versioned structured task filter. Its projectId must match the requested project; omitted clauses impose no restriction.",
  fields:
    "Optional field groups to include beyond compact search results. Use get_task_context for a complete execution package.",
  order: "Ordered sort clauses; keep them unchanged while following a search cursor.",
  field: "Task field selected by this sort or filter clause.",
  direction: "Sort direction: asc or desc.",
  search: "Full-text query and matching mode; searches task content and history.",
  text: "Plain text content or search terms, as indicated by the containing field.",
  mode: "Text matching: all words, any word, or exact phrase.",
  archiveState: "exclude hides archived tasks, include includes them, only selects archived tasks.",
  includeArchived: "Whether archived records are included; false by default.",
  lifecycles:
    "Filter by persisted task states; claimable/blocked/scheduled belong in eligibility instead.",
  lifecycle:
    "backlog stores an incomplete idea. ready requires expectedOutcome, acceptanceCriteria, and a nonempty checklist; it can still be blocked or scheduled.",
  eligibility:
    "Derived execution eligibility, separate from lifecycle; search can explain blocked or scheduled work that find_work omits.",
  priorities: "Filter by explicit priority lanes.",
  priority:
    "Explicit priority lane: urgent, high, normal, or low. Due dates do not automatically raise priority.",
  position: "Manual ordering value within a priority lane; lower positions rank first.",
  title: "Short human-readable task title. A title alone can be captured in backlog.",
  description:
    "Task description as versioned rich text, or plain-text tag explanation when nested in a tag.",
  expectedOutcome: "Plain-text description of the observable result; required for ready work.",
  acceptanceCriteria: "Plain-text conditions the result must satisfy; required for ready work.",
  agentContext:
    "Additional plain-text execution context, constraints, and relevant background for agents.",
  checklist: "Stable-ID checklist items; at least one item is required for ready work.",
  checked: "Whether this checklist item is complete.",
  parentTaskId: "Optional parent task ID in this project. Only one level of subtasks is supported.",
  requiredCapabilities:
    "Capability names needed to claim this task; all must match the registered profile.",
  notBefore: "Earliest eligible start date, YYYY-MM-DD, or null for no scheduling restriction.",
  dueAt: "Optional due date, YYYY-MM-DD, or null. Does not bypass eligibility or change priority.",
  size: "Optional rough estimate: xs, s, m, l, or xl; not a duration commitment.",
  referencedPaths:
    "Normalized existing paths relative to the project's repositoryRoot. Absolute paths, traversal, and escaping symlinks are rejected.",
  tags: "Task tag definitions, tag filters, or tag-ID add/remove changes, according to the enclosing operation.",
  name: "Human-readable tag or verification-check name.",
  color: "Tag color as a six-digit hex value, e.g. #287a56.",
  exclusiveGroup:
    "Optional tag group name. A task cannot have multiple tags from the same exclusive group.",
  customFields:
    "Typed custom-field values/changes. Obtain field IDs, types, and options from get_task_context; do not invent definitions.",
  fieldId: "Opaque custom-field definition ID from project customization in task context.",
  value:
    "Value matching the advertised variant and custom-field definition; null clears an assignment where allowed.",
  values: "Values to match for this filter operator.",
  operator: "Comparison operator for the containing typed filter clause.",
  dates: "Date filter clauses; omitted fields are unrestricted.",
  from: "Inclusive range start: YYYY-MM-DD for not_before/due_at, ISO timestamp for created_at/updated_at.",
  to: "Inclusive range end: YYYY-MM-DD for not_before/due_at, ISO timestamp for created_at/updated_at.",
  actors: "Filter by attributed activity, attempt, or event actors.",
  actor:
    "Actor reference used for filtering only. Mutation attribution always comes from the registered MCP session.",
  sources: "History sources in which to match an actor.",
  relations: "Filter by typed relations. Only blocks affects claimability.",
  sourceTaskId:
    "Relation source. For blocks, source is the prerequisite and target is blocked; for discovered_from, source is the new work and target its origin.",
  targetTaskId:
    "Relation target in the same project. For blocks, this task waits for sourceTaskId.",
  types: "Relation types to match.",
  type: "Variant discriminator; select one of the advertised values for this object.",
  entryId:
    "Generate a stable unique ID for this activity entry. Reuse it only when retrying that same entry.",
  blockerId:
    "Generate a stable unique ID for this blocker. Reuse it only when retrying that same blocker.",
  content:
    "Versioned rich-text message, or child nodes inside its doc. See get_helm_guide for a minimal paragraph example.",
  doc: "TipTap document with type doc and a content array of nodes.",
  attrs: "Optional structured attributes on a rich-text document, node, or mark.",
  marks: "Optional formatting marks on rich-text nodes.",
  version: "Rich-text document format version; currently 1.",
  id: "Stable identifier for the containing checklist item or filter reference; do not substitute a human sequence number.",
  reason:
    "Concise explanation of why this operation or blocker is necessary; recorded in the audit history.",
  report:
    "Structured execution evidence. Include what changed, actual verification results, risks, and follow-up work; never fabricate a passed check.",
  resultSummary:
    "Concise statement of what was accomplished and how it meets the task's acceptance criteria.",
  changedAreas: "Repository paths or areas actually changed during this attempt.",
  verificationResults:
    "Checks actually performed with passed, failed, or not_run status and supporting details.",
  status: "Verification outcome: passed, failed, or not_run, as applicable to this report.",
  details: "Observed verification output or why the check could not run.",
  references:
    "Relevant evidence references such as commits, files, or user-authorized external links; never lease tokens.",
  risks: "Known limitations or remaining risks; an empty array means none identified.",
  followUpWork:
    "Remaining or newly discovered work; reporting it does not create tasks automatically.",
  classification:
    "Failure category: implementation, verification, environment, requirements, or unknown.",
  destination: "State to reopen into: ready for a new attempt or backlog for further preparation.",
  importance: "Event importance levels to include in a cursor read.",
  schemaVersion: "Bulk intent or structured-filter format version; currently 1.",
  kind: "Bulk operation discriminator: create, update, or reconcile.",
  intent:
    "Exact bulk create/update/reconcile intent used in preview_bulk_tasks, unchanged for execution.",
  selection: "Explicit task IDs or a structured filter selecting tasks within this project.",
  patch:
    "Supported content, lifecycle, and planning/metadata fields to change; omitted fields are preserved.",
  items:
    "Create entries use unique clientId and task fields. Reconcile entries use unique taskId, expectedVersion, sourceRef, and an individual patch.",
  clientId: "Caller-chosen unique identifier to correlate a bulk-created task with its result.",
  task: "Task fields for one bulk-created item; project and mutation identity come from the enclosing intent.",
  previewToken:
    "Exact preview.previewToken returned for this intent. Changed targets/versions require a fresh preview; preview alone never changes tasks.",
  add: "Identifiers or capability names to add without replacing existing values.",
  remove: "Identifiers or capability names to remove; cannot also be added in the same patch.",
  set: "Custom-field assignments to set to explicit typed values.",
  clear: "Custom-field IDs whose explicit values should be cleared.",
};
