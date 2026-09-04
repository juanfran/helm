import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { X } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  MAX_BULK_UPDATE_TARGETS,
  bulkTaskUpdatePatchSchema,
  type BulkTaskIntent,
  type BulkTaskPreview,
  type BulkTaskProjectedChange,
  type ExecuteBulkTasksInput,
} from "../../domain/bulk-tasks";
import type { JsonValue } from "../../domain/rich-text";
import type { TaskTag } from "../../domain/tasks";
import type {
  BulkTaskExecutionCommandResponse,
  BulkTaskPreviewCommandResponse,
} from "../../server/task-adapter";
import { tokens } from "../../styles/tokens.stylex";
import type { VisibleTaskSelection } from "./visible-task-selection";

type BulkUpdateIntent = Extract<BulkTaskIntent, { kind: "update" }>;
type BulkCommandError = Extract<BulkTaskPreviewCommandResponse, { ok: false }>["error"];

type BulkOperation =
  | "lifecycle"
  | "priority"
  | "set_not_before"
  | "clear_not_before"
  | "set_due_at"
  | "clear_due_at"
  | "add_tag"
  | "remove_tag"
  | "add_capability"
  | "remove_capability";

type ErrorNotice = { message: string; details: readonly string[] };

const bulkOperations = [
  "lifecycle",
  "priority",
  "set_not_before",
  "clear_not_before",
  "set_due_at",
  "clear_due_at",
  "add_tag",
  "remove_tag",
  "add_capability",
  "remove_capability",
] as const satisfies readonly BulkOperation[];

export type BulkTaskControlsProps = {
  projectId: string;
  tagDefinitions: readonly TaskTag[];
  selection: VisibleTaskSelection;
  onPreview: (intent: BulkTaskIntent) => Promise<BulkTaskPreviewCommandResponse>;
  onExecute: (input: ExecuteBulkTasksInput) => Promise<BulkTaskExecutionCommandResponse>;
};

const fieldLabels: Record<BulkTaskProjectedChange["field"], string> = {
  task: "Task",
  lifecycle: "Lifecycle",
  priority: "Priority",
  notBefore: "Start date",
  dueAt: "Due date",
  tags: "Tags",
  requiredCapabilities: "Required capabilities",
};

function defaultValue(operation: BulkOperation, tags: readonly TaskTag[]) {
  switch (operation) {
    case "lifecycle":
      return "ready";
    case "priority":
      return "high";
    case "add_tag":
    case "remove_tag":
      return tags[0]?.id ?? "";
    default:
      return "";
  }
}

function patchForOperation(operation: BulkOperation, value: string) {
  switch (operation) {
    case "lifecycle":
      return bulkTaskUpdatePatchSchema.parse({ lifecycle: value });
    case "priority":
      return bulkTaskUpdatePatchSchema.parse({ priority: value });
    case "set_not_before":
      return bulkTaskUpdatePatchSchema.parse({ notBefore: value });
    case "clear_not_before":
      return bulkTaskUpdatePatchSchema.parse({ notBefore: null });
    case "set_due_at":
      return bulkTaskUpdatePatchSchema.parse({ dueAt: value });
    case "clear_due_at":
      return bulkTaskUpdatePatchSchema.parse({ dueAt: null });
    case "add_tag":
      return bulkTaskUpdatePatchSchema.parse({
        tags: { add: [value], remove: [] },
      });
    case "remove_tag":
      return bulkTaskUpdatePatchSchema.parse({
        tags: { add: [], remove: [value] },
      });
    case "add_capability":
      return bulkTaskUpdatePatchSchema.parse({
        capabilities: { add: [value], remove: [] },
      });
    case "remove_capability":
      return bulkTaskUpdatePatchSchema.parse({
        capabilities: { add: [], remove: [value] },
      });
    default:
      return assertNever(operation);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected bulk operation: ${String(value)}`);
}

function isBulkOperation(value: string): value is BulkOperation {
  return bulkOperations.some((operation) => operation === value);
}

function requiresValue(operation: BulkOperation) {
  return operation !== "clear_not_before" && operation !== "clear_due_at";
}

function noticeFromError(error: BulkCommandError): ErrorNotice {
  return {
    message: error.message,
    details: [
      ...new Set([
        ...(error.issues ?? []),
        ...(error.failures?.map((failure) => failure.message) ?? []),
      ]),
    ],
  };
}

function requiresFreshPreview(error: BulkCommandError) {
  return (
    error.type === "BulkTaskPreviewStaleError" ||
    error.type === "BulkTaskPreviewMismatchError" ||
    error.type === "BulkTaskIdempotencyConflictError"
  );
}

export function BulkTaskControls({
  projectId,
  tagDefinitions,
  selection,
  onPreview,
  onExecute,
}: BulkTaskControlsProps) {
  const operationRef = useRef<HTMLSelectElement>(null);
  const [open, setOpen] = useState(false);
  const [operation, setOperation] = useState<BulkOperation>("priority");
  const [value, setValue] = useState("high");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkTaskPreview | null>(null);
  const [previewIntent, setPreviewIntent] = useState<BulkUpdateIntent | null>(null);
  const [previewSelectionKey, setPreviewSelectionKey] = useState<string | null>(null);
  const [executionIdempotencyKey, setExecutionIdempotencyKey] = useState<string | null>(null);
  const [pending, setPending] = useState<"preview" | "execute" | null>(null);
  const [error, setError] = useState<ErrorNotice | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const selectionKey = JSON.stringify([selection.revision, ...selection.selectedTaskIds]);
  const overLimit = selection.selectedCount > MAX_BULK_UPDATE_TARGETS;
  const previewIsOutdated = preview !== null && previewSelectionKey !== selectionKey;
  const activePreview = previewIsOutdated ? null : preview;
  const activeError = previewIsOutdated
    ? {
        message: "The visible selection changed. Preview the update again before applying it.",
        details: [],
      }
    : error;

  function invalidatePreview() {
    setPreview(null);
    setPreviewIntent(null);
    setPreviewSelectionKey(null);
    setExecutionIdempotencyKey(null);
    setError(null);
  }

  function changeOperation(nextOperation: BulkOperation) {
    setOperation(nextOperation);
    setValue(defaultValue(nextOperation, tagDefinitions));
    invalidatePreview();
  }

  function changeValue(nextValue: string) {
    setValue(nextValue);
    invalidatePreview();
  }

  function changeReason(nextReason: string) {
    setReason(nextReason);
    invalidatePreview();
  }

  function changeOpen(nextOpen: boolean) {
    if (pending) return;
    setOpen(nextOpen);
    if (!nextOpen) invalidatePreview();
  }

  async function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("preview");
    setError(null);
    try {
      const intent: BulkUpdateIntent = {
        schemaVersion: 1,
        kind: "update",
        projectId,
        reason: reason.trim(),
        selection: { type: "ids", taskIds: [...selection.selectedTaskIds] },
        patch: patchForOperation(operation, value.trim()),
      };
      const response = await onPreview(intent);
      if (!response.ok) {
        setError(noticeFromError(response.error));
        return;
      }
      setPreview(response.preview);
      setPreviewIntent(intent);
      setPreviewSelectionKey(selectionKey);
      setExecutionIdempotencyKey(crypto.randomUUID());
    } catch {
      setError({
        message: "Helm could not preview this bulk update.",
        details: [],
      });
    } finally {
      setPending(null);
    }
  }

  async function executePreview() {
    if (
      !activePreview?.executable ||
      !previewIntent ||
      !executionIdempotencyKey ||
      previewSelectionKey !== selectionKey
    )
      return;
    setPending("execute");
    setError(null);
    try {
      const response = await onExecute({
        intent: previewIntent,
        previewToken: activePreview.previewToken,
        idempotencyKey: executionIdempotencyKey,
      });
      if (!response.ok) {
        setError(noticeFromError(response.error));
        if (requiresFreshPreview(response.error)) {
          setPreview(null);
          setPreviewIntent(null);
          setPreviewSelectionKey(null);
          setExecutionIdempotencyKey(null);
        }
        return;
      }
      const affectedCount = response.result.affectedCount;
      selection.clear();
      setOpen(false);
      setPreview(null);
      setPreviewIntent(null);
      setPreviewSelectionKey(null);
      setExecutionIdempotencyKey(null);
      setAnnouncement(
        `${affectedCount} task${affectedCount === 1 ? "" : "s"} updated successfully.`,
      );
    } catch {
      setError({
        message:
          "Helm could not confirm whether the update completed. Retry to safely use the same request.",
        details: [],
      });
    } finally {
      setPending(null);
    }
  }

  const draftComplete =
    selection.selectedCount > 0 &&
    !overLimit &&
    reason.trim().length > 0 &&
    (!requiresValue(operation) || value.trim().length > 0);
  const selectVisibleDisabled =
    selection.visibleCount === 0 || selection.visibleCount > MAX_BULK_UPDATE_TARGETS;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => changeOpen(nextOpen)}
      disablePointerDismissal={pending !== null}
    >
      <section aria-label="Bulk task selection" {...stylex.props(styles.selectionBar)}>
        <span {...stylex.props(styles.selectVisible)}>
          <Checkbox
            aria-label={`Select all ${selection.visibleCount} visible tasks`}
            checked={selection.checked}
            indeterminate={selection.indeterminate}
            disabled={selectVisibleDisabled}
            onCheckedChange={selection.setAllVisibleSelected}
          />
          <span aria-live="polite">
            {selection.selectedCount} of {selection.visibleCount} visible selected
          </span>
        </span>
        <span {...stylex.props(styles.selectionActions)}>
          <button
            type="button"
            disabled={selection.selectedCount === 0}
            onClick={selection.clear}
            {...stylex.props(styles.clearButton)}
          >
            Clear
          </button>
          <Dialog.Trigger
            disabled={selection.selectedCount === 0}
            {...stylex.props(styles.dialogTrigger)}
          >
            Bulk edit
          </Dialog.Trigger>
        </span>
        {selection.visibleCount > MAX_BULK_UPDATE_TARGETS ? (
          <p {...stylex.props(styles.limitHint)}>
            Select visible is unavailable above {MAX_BULK_UPDATE_TARGETS} tasks. Choose up to the
            limit individually.
          </p>
        ) : null}
        <output {...stylex.props(styles.announcement)}>{announcement}</output>
      </section>

      <Dialog.Portal>
        <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
        <Dialog.Popup
          initialFocus={operationRef}
          aria-busy={pending !== null}
          {...stylex.props(styles.dialog)}
        >
          <header {...stylex.props(styles.dialogHeader)}>
            <div>
              <Dialog.Title {...stylex.props(styles.dialogTitle)}>
                {activePreview ? "Review bulk update" : "Configure bulk update"}
              </Dialog.Title>
              <Dialog.Description {...stylex.props(styles.dialogDescription)}>
                {activePreview
                  ? "This is the authoritative preview. No tasks have been changed yet."
                  : `Choose one change for ${selection.selectedCount} selected task${selection.selectedCount === 1 ? "" : "s"}.`}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close bulk update"
              disabled={pending !== null}
              {...stylex.props(styles.closeButton)}
            >
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </header>

          {activeError ? <ErrorMessage notice={activeError} /> : null}
          {overLimit ? (
            <ErrorMessage
              notice={{
                message: `Bulk updates support at most ${MAX_BULK_UPDATE_TARGETS} tasks.`,
                details: ["Clear part of the selection before previewing."],
              }}
            />
          ) : null}

          {activePreview ? (
            <PreviewPanel
              preview={activePreview}
              pending={pending === "execute"}
              onEdit={invalidatePreview}
              onExecute={() => void executePreview()}
            />
          ) : (
            <form
              aria-label="Configure bulk task update"
              aria-busy={pending === "preview"}
              onSubmit={requestPreview}
              {...stylex.props(styles.form)}
            >
              <fieldset disabled={pending !== null} {...stylex.props(styles.fieldset)}>
                <Field label="Operation">
                  <select
                    ref={operationRef}
                    aria-label="Bulk operation"
                    value={operation}
                    onChange={(event) => {
                      if (isBulkOperation(event.target.value)) {
                        changeOperation(event.target.value);
                      }
                    }}
                    {...stylex.props(styles.input)}
                  >
                    <option value="lifecycle">Change lifecycle</option>
                    <option value="priority">Change priority</option>
                    <option value="set_not_before">Set start date</option>
                    <option value="clear_not_before">Clear start date</option>
                    <option value="set_due_at">Set due date</option>
                    <option value="clear_due_at">Clear due date</option>
                    <option value="add_tag" disabled={tagDefinitions.length === 0}>
                      Add tag
                    </option>
                    <option value="remove_tag" disabled={tagDefinitions.length === 0}>
                      Remove tag
                    </option>
                    <option value="add_capability">Add capability</option>
                    <option value="remove_capability">Remove capability</option>
                  </select>
                </Field>
                <OperationValue
                  operation={operation}
                  value={value}
                  tags={tagDefinitions}
                  onChange={changeValue}
                />
                <Field label="Reason" hint="Recorded on the parent audit event.">
                  <textarea
                    aria-label="Bulk update reason"
                    value={reason}
                    onChange={(event) => changeReason(event.target.value)}
                    rows={3}
                    maxLength={1_000}
                    required
                    {...stylex.props(styles.textarea)}
                  />
                </Field>
              </fieldset>
              <footer {...stylex.props(styles.dialogActions)}>
                <Dialog.Close disabled={pending !== null} {...stylex.props(styles.cancelButton)}>
                  Cancel
                </Dialog.Close>
                <Button type="submit" disabled={!draftComplete || pending !== null}>
                  {pending === "preview" ? "Previewing…" : "Preview changes"}
                </Button>
              </footer>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OperationValue({
  operation,
  value,
  tags,
  onChange,
}: {
  operation: BulkOperation;
  value: string;
  tags: readonly TaskTag[];
  onChange: (value: string) => void;
}) {
  switch (operation) {
    case "lifecycle":
      return (
        <Field label="Lifecycle">
          <select
            aria-label="Lifecycle value"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            {...stylex.props(styles.input)}
          >
            <option value="backlog">Backlog</option>
            <option value="ready">Ready</option>
          </select>
        </Field>
      );
    case "priority":
      return (
        <Field label="Priority">
          <select
            aria-label="Priority value"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            {...stylex.props(styles.input)}
          >
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </Field>
      );
    case "set_not_before":
      return (
        <Field label="Start date">
          <input
            type="date"
            aria-label="Start date value"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
            {...stylex.props(styles.input)}
          />
        </Field>
      );
    case "set_due_at":
      return (
        <Field label="Due date">
          <input
            type="date"
            aria-label="Due date value"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
            {...stylex.props(styles.input)}
          />
        </Field>
      );
    case "add_tag":
    case "remove_tag":
      return (
        <Field label="Tag">
          <select
            aria-label="Tag value"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
            {...stylex.props(styles.input)}
          >
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
                {tag.exclusiveGroup ? ` · ${tag.exclusiveGroup}` : ""}
              </option>
            ))}
          </select>
        </Field>
      );
    case "add_capability":
    case "remove_capability":
      return (
        <Field label="Capability">
          <input
            aria-label="Capability value"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            maxLength={80}
            required
            {...stylex.props(styles.input)}
          />
        </Field>
      );
    case "clear_not_before":
    case "clear_due_at":
      return (
        <p {...stylex.props(styles.clearExplanation)}>
          The selected date will be cleared from every editable target.
        </p>
      );
    default:
      return assertNever(operation);
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.fieldLabel)}>{label}</span>
      {children}
      {hint ? <span {...stylex.props(styles.hint)}>{hint}</span> : null}
    </label>
  );
}

function ErrorMessage({ notice }: { notice: ErrorNotice }) {
  return (
    <div role="alert" {...stylex.props(styles.error)}>
      <p>{notice.message}</p>
      {notice.details.length > 0 ? (
        <ul>
          {notice.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PreviewPanel({
  preview,
  pending,
  onEdit,
  onExecute,
}: {
  preview: BulkTaskPreview;
  pending: boolean;
  onEdit: () => void;
  onExecute: () => void;
}) {
  const globalFailures = preview.failures.filter((failure) => !failure.targetKey);
  return (
    <section aria-label="Bulk update preview" {...stylex.props(styles.preview)}>
      <div {...stylex.props(styles.previewSummary)}>
        <strong>
          {preview.affectedCount} of {preview.matchedCount} matched task
          {preview.matchedCount === 1 ? "" : "s"} will change
        </strong>
        <span>
          {preview.executable ? "Ready to apply atomically" : "Resolve every issue first"}
        </span>
      </div>
      {globalFailures.length > 0 ? (
        <ul aria-label="Preview issues" {...stylex.props(styles.failureList)}>
          {globalFailures.map((failure) => (
            <li key={`${failure.code}:${failure.message}`}>{failure.message}</li>
          ))}
        </ul>
      ) : null}
      <ul aria-label="Previewed tasks" {...stylex.props(styles.previewList)}>
        {preview.targets.map((target) => (
          <li key={target.targetKey} {...stylex.props(styles.previewTarget)}>
            <div {...stylex.props(styles.targetHeading)}>
              <strong>
                {target.sequence ? `#${target.sequence} ` : ""}
                {target.title}
              </strong>
              <span>
                {target.failures.length > 0
                  ? "Cannot change"
                  : target.changed
                    ? `v${target.expectedVersion} → v${target.projectedVersion}`
                    : "No change"}
              </span>
            </div>
            {target.changes.length > 0 ? (
              <ul {...stylex.props(styles.changeList)}>
                {target.changes.map((change) => (
                  <li key={change.field}>
                    <span>{fieldLabels[change.field]}</span>
                    <span>
                      {formatChangeValue(change.field, change.before)} →{" "}
                      <strong>{formatChangeValue(change.field, change.after)}</strong>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {target.failures.length > 0 ? (
              <ul {...stylex.props(styles.failureList)}>
                {target.failures.map((failure) => (
                  <li key={`${failure.code}:${failure.message}`}>{failure.message}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      <footer {...stylex.props(styles.dialogActions)}>
        <Button type="button" variant="quiet" disabled={pending} onClick={onEdit}>
          Edit change
        </Button>
        <Button type="button" disabled={!preview.executable || pending} onClick={onExecute}>
          {pending ? "Applying…" : `Apply to ${preview.affectedCount}`}
        </Button>
      </footer>
    </section>
  );
}

function formatChangeValue(field: BulkTaskProjectedChange["field"], value: JsonValue) {
  if (value === null) return "None";
  if (field === "tags" && Array.isArray(value)) {
    const names = value.flatMap((item) => {
      if (!item || Array.isArray(item) || typeof item !== "object") return [];
      const name = item.name;
      return typeof name === "string" ? [name] : [];
    });
    return names.join(", ") || "No tags";
  }
  if (field === "requiredCapabilities" && Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join(", ") || "None";
  }
  if (typeof value === "string") return value.replaceAll("_", " ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "Updated";
}

const styles = stylex.create({
  selectionBar: {
    alignItems: "center",
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.space3,
    justifyContent: "space-between",
    marginBlock: tokens.space3,
    padding: tokens.space2,
  },
  selectVisible: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 12,
    gap: tokens.space2,
  },
  selectionActions: {
    alignItems: "center",
    display: "flex",
    gap: tokens.space2,
  },
  clearButton: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    cursor: "pointer",
    font: "inherit",
    fontSize: 12,
    minHeight: 32,
    paddingInline: tokens.space2,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  dialogTrigger: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "inline-flex",
    font: "inherit",
    fontSize: 13,
    fontWeight: 650,
    justifyContent: "center",
    minHeight: 34,
    paddingInline: tokens.space3,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":hover": { borderColor: tokens.accent },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  limitHint: {
    color: tokens.danger,
    flexBasis: "100%",
    fontSize: 11,
    margin: 0,
  },
  announcement: {
    color: tokens.accent,
    flexBasis: "100%",
    fontSize: 11,
    minHeight: 0,
  },
  backdrop: {
    backgroundColor: tokens.overlay,
    inset: 0,
    minHeight: "100dvh",
    position: "fixed",
    zIndex: 50,
  },
  dialog: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    color: tokens.foreground,
    display: "grid",
    gap: tokens.space5,
    left: "50%",
    maxHeight: "calc(100dvh - 32px)",
    maxWidth: "calc(100vw - 32px)",
    overflowY: "auto",
    padding: tokens.space5,
    position: "fixed",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: 720,
    zIndex: 51,
    "@media (max-width: 600px)": {
      borderRadius: tokens.radius2,
      gap: tokens.space4,
      maxHeight: "calc(100dvh - 16px)",
      maxWidth: "calc(100vw - 16px)",
      padding: tokens.space4,
    },
  },
  dialogHeader: {
    alignItems: "start",
    display: "flex",
    gap: tokens.space4,
    justifyContent: "space-between",
  },
  dialogTitle: {
    fontSize: 20,
    fontWeight: 750,
    letterSpacing: "-0.02em",
    margin: 0,
  },
  dialogDescription: {
    color: tokens.foregroundMuted,
    fontSize: 13,
    lineHeight: 1.5,
    marginBlockEnd: 0,
    marginBlockStart: tokens.space1,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    cursor: "pointer",
    display: "inline-flex",
    height: 32,
    justifyContent: "center",
    padding: 0,
    width: 32,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    ":hover": {
      backgroundColor: tokens.surfaceMuted,
      color: tokens.foreground,
    },
  },
  form: { display: "grid", gap: tokens.space5 },
  fieldset: {
    borderWidth: 0,
    display: "grid",
    gap: tokens.space4,
    margin: 0,
    minWidth: 0,
    padding: 0,
  },
  field: { display: "grid", gap: tokens.space2 },
  fieldLabel: { fontSize: 13, fontWeight: 700 },
  hint: { color: tokens.foregroundMuted, fontSize: 11 },
  input: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    minHeight: 40,
    paddingInline: tokens.space3,
    width: "100%",
    ":focus-visible": {
      borderColor: tokens.accent,
      outlineColor: tokens.accent,
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  textarea: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    lineHeight: 1.5,
    padding: tokens.space3,
    resize: "vertical",
    width: "100%",
    ":focus-visible": {
      borderColor: tokens.accent,
      outlineColor: tokens.accent,
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  clearExplanation: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: tokens.radius2,
    color: tokens.foregroundMuted,
    fontSize: 12,
    margin: 0,
    padding: tokens.space3,
  },
  error: {
    backgroundColor: tokens.surfaceMuted,
    borderInlineStartColor: tokens.danger,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 3,
    color: tokens.danger,
    fontSize: 12,
    lineHeight: 1.5,
    padding: tokens.space3,
  },
  preview: { display: "grid", gap: tokens.space4, minWidth: 0 },
  previewSummary: {
    alignItems: "start",
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.space2,
    justifyContent: "space-between",
  },
  failureList: {
    color: tokens.danger,
    display: "grid",
    fontSize: 12,
    gap: tokens.space1,
    margin: 0,
    paddingInlineStart: tokens.space5,
  },
  previewList: {
    display: "grid",
    gap: tokens.space2,
    listStyle: "none",
    margin: 0,
    maxHeight: "min(52dvh, 520px)",
    overflowY: "auto",
    padding: 0,
  },
  previewTarget: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space2,
    padding: tokens.space3,
  },
  targetHeading: {
    alignItems: "start",
    display: "flex",
    flexWrap: "wrap",
    fontSize: 12,
    gap: tokens.space2,
    justifyContent: "space-between",
  },
  changeList: {
    display: "grid",
    fontSize: 12,
    gap: tokens.space1,
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  dialogActions: {
    alignItems: "center",
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.space2,
    justifyContent: "end",
    paddingBlockStart: tokens.space4,
    "@media (max-width: 520px)": {
      alignItems: "stretch",
      flexDirection: "column",
    },
  },
  cancelButton: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    font: "inherit",
    fontSize: 14,
    fontWeight: 650,
    minHeight: 36,
    paddingInline: tokens.space4,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
});
