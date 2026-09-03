import { useMemo, useState, type FormEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { Archive, CheckCircle2, Inbox, Plus, ShipWheel } from "lucide-react";

import { Button } from "../../components/ui/button";
import { themeSchema, type Project, type Theme } from "../../domain/projects";
import {
  emptyRichTextDocument,
  type ArchiveTaskInput,
  type CreateTaskInput,
  type PrepareTaskInput,
  type RichTextDocument,
  type Task,
} from "../../domain/tasks";
import type { TaskCommandResponse } from "../../server/task-adapter";
import { tokens } from "../../styles/tokens.stylex";
import { RichTextEditor } from "./rich-text-editor";

type TaskWorkspaceProps = {
  project: Project;
  theme: Theme;
  tasks: readonly Task[];
  onCreateTask: (input: CreateTaskInput) => Promise<TaskCommandResponse>;
  onPrepareTask: (input: PrepareTaskInput) => Promise<TaskCommandResponse>;
  onArchiveTask: (input: ArchiveTaskInput) => Promise<TaskCommandResponse>;
  onChangeTheme: (theme: Theme) => Promise<void>;
};

export function TaskWorkspace({
  project,
  theme,
  tasks,
  onCreateTask,
  onPrepareTask,
  onArchiveTask,
  onChangeTheme,
}: TaskWorkspaceProps) {
  const [captureTitle, setCaptureTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(tasks[0]?.id ?? null);
  const [pendingCapture, setPendingCapture] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const selectedTask = tasks.find((task) => task.id === selectedId) ?? tasks[0] ?? null;
  const counts = useMemo(
    () => ({
      backlog: tasks.filter((task) => task.lifecycle === "backlog").length,
      ready: tasks.filter((task) => task.lifecycle === "ready").length,
    }),
    [tasks],
  );

  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingCapture(true);
    setCaptureError(null);
    try {
      const response = await onCreateTask({
        projectId: project.id,
        lifecycle: "backlog",
        title: captureTitle,
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        expectedVersion: 0,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) {
        setCaptureTitle("");
        setSelectedId(response.task.id);
      } else {
        setCaptureError(response.error.message);
      }
    } catch {
      setCaptureError("Helm could not capture the task.");
    } finally {
      setPendingCapture(false);
    }
  }

  return (
    <main {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.brand)}>
          <span {...stylex.props(styles.mark)} aria-hidden="true">
            <ShipWheel size={16} />
          </span>
          <div>
            <strong>Helm</strong>
            <span {...stylex.props(styles.projectName)}>{project.name}</span>
          </div>
        </div>
        <label {...stylex.props(styles.appearance)}>
          <span>Appearance</span>
          <select
            aria-label="Appearance"
            value={theme}
            onChange={(event) => void onChangeTheme(themeSchema.parse(event.target.value))}
            {...stylex.props(styles.select)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </header>

      <div {...stylex.props(styles.workspace)}>
        <aside {...stylex.props(styles.sidebar)}>
          <div {...stylex.props(styles.queueHeader)}>
            <div>
              <p {...stylex.props(styles.eyebrow)}>Work queue</p>
              <h1 {...stylex.props(styles.heading)}>Tasks</h1>
            </div>
            <span {...stylex.props(styles.total)}>{tasks.length}</span>
          </div>
          <div {...stylex.props(styles.counts)}>
            <span>
              <Inbox size={14} aria-hidden="true" /> {counts.backlog} backlog
            </span>
            <span>
              <CheckCircle2 size={14} aria-hidden="true" /> {counts.ready} ready
            </span>
          </div>
          <form onSubmit={capture} {...stylex.props(styles.capture)} aria-label="Quick capture">
            <label htmlFor="capture-title" {...stylex.props(styles.srOnly)}>
              Task title
            </label>
            <input
              id="capture-title"
              value={captureTitle}
              onChange={(event) => setCaptureTitle(event.target.value)}
              placeholder="Capture a task…"
              maxLength={300}
              required
              {...stylex.props(styles.input)}
            />
            <Button
              type="submit"
              aria-label="Add backlog task"
              disabled={pendingCapture || captureTitle.trim().length === 0}
            >
              <Plus size={17} aria-hidden="true" />
            </Button>
          </form>
          {captureError ? (
            <p role="alert" {...stylex.props(styles.error)}>
              {captureError}
            </p>
          ) : null}
          <nav aria-label="Tasks" {...stylex.props(styles.taskList)}>
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => setSelectedId(task.id)}
                aria-current={task.id === selectedTask?.id ? "true" : undefined}
                {...stylex.props(
                  styles.taskRow,
                  task.id === selectedTask?.id && styles.taskRowSelected,
                )}
              >
                <span {...stylex.props(styles.taskReference)}>#{task.sequence}</span>
                <span {...stylex.props(styles.taskTitle)}>{task.title}</span>
                <span {...stylex.props(styles[task.lifecycle])}>{task.lifecycle}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section {...stylex.props(styles.detail)}>
          {selectedTask ? (
            <PreparationPanel
              key={`${selectedTask.id}:${selectedTask.version}`}
              task={selectedTask}
              onPrepare={onPrepareTask}
              onArchive={onArchiveTask}
            />
          ) : (
            <div {...stylex.props(styles.empty)}>
              <Inbox size={32} aria-hidden="true" />
              <h2>Capture the first task</h2>
              <p>A title is enough. Preparation can happen when the work is understood.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function PreparationPanel({
  task,
  onPrepare,
  onArchive,
}: {
  task: Task;
  onPrepare: TaskWorkspaceProps["onPrepareTask"];
  onArchive: TaskWorkspaceProps["onArchiveTask"];
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState<RichTextDocument>(task.description);
  const [expectedOutcome, setExpectedOutcome] = useState(task.expectedOutcome);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(task.acceptanceCriteria);
  const [agentContext, setAgentContext] = useState(task.agentContext);
  const [checklist, setChecklist] = useState(task.checklist.map((item) => item.text).join("\n"));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await onPrepare({
        taskId: task.id,
        title,
        description,
        expectedOutcome,
        acceptanceCriteria,
        agentContext,
        checklist: checklist
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((text, index) => ({ id: `item-${index + 1}`, text, checked: false })),
        expectedVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not prepare the task.");
    } finally {
      setPending(false);
    }
  }

  async function archive() {
    setPending(true);
    setError(null);
    try {
      const response = await onArchive({
        taskId: task.id,
        expectedVersion: task.version,
        reason: "Archived from the task workspace",
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not archive the task.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={prepare} {...stylex.props(styles.form)} aria-label="Prepare task">
      <div {...stylex.props(styles.detailHeader)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Task #{task.sequence}</p>
          <p {...stylex.props(styles.version)}>Version {task.version}</p>
        </div>
        <Button type="button" variant="quiet" disabled={pending} onClick={() => void archive()}>
          <Archive size={15} aria-hidden="true" /> Archive
        </Button>
      </div>
      <Field label="Title" required>
        <input
          aria-label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={300}
          required
          {...stylex.props(styles.input)}
        />
      </Field>
      <Field label="Description" hint="Rich text is saved as a versioned TipTap document.">
        <RichTextEditor value={description} onChange={setDescription} />
      </Field>
      <Field label="Expected outcome" required>
        <textarea
          aria-label="Expected outcome"
          value={expectedOutcome}
          onChange={(event) => setExpectedOutcome(event.target.value)}
          rows={3}
          required
          {...stylex.props(styles.textarea)}
        />
      </Field>
      <Field label="Acceptance criteria" required>
        <textarea
          aria-label="Acceptance criteria"
          value={acceptanceCriteria}
          onChange={(event) => setAcceptanceCriteria(event.target.value)}
          rows={4}
          required
          {...stylex.props(styles.textarea)}
        />
      </Field>
      <Field label="Agent context" hint="Paths, constraints, and execution-specific guidance.">
        <textarea
          aria-label="Agent context"
          value={agentContext}
          onChange={(event) => setAgentContext(event.target.value)}
          rows={3}
          {...stylex.props(styles.textarea)}
        />
      </Field>
      <Field label="Checklist" hint="One required verification step per line." required>
        <textarea
          aria-label="Checklist"
          value={checklist}
          onChange={(event) => setChecklist(event.target.value)}
          rows={4}
          required
          {...stylex.props(styles.textarea)}
        />
      </Field>
      {error ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      ) : null}
      <div {...stylex.props(styles.formFooter)}>
        <p>Ready requires an outcome, acceptance criteria, and at least one checklist item.</p>
        <Button type="submit" disabled={pending}>
          <CheckCircle2 size={16} aria-hidden="true" />
          {pending ? "Saving…" : task.lifecycle === "ready" ? "Save preparation" : "Move to ready"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  required = false,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.fieldLabel)}>
        {label} {required ? <span {...stylex.props(styles.required)}>Required</span> : null}
      </span>
      {children}
      {hint ? <span {...stylex.props(styles.hint)}>{hint}</span> : null}
    </div>
  );
}

const styles = stylex.create({
  page: { minHeight: "100vh" },
  header: {
    alignItems: "center",
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "flex",
    justifyContent: "space-between",
    minHeight: 64,
    paddingInline: tokens.space6,
  },
  brand: { alignItems: "center", display: "flex", gap: tokens.space3 },
  mark: {
    alignItems: "center",
    backgroundColor: tokens.foreground,
    borderRadius: 7,
    color: tokens.background,
    display: "inline-flex",
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  projectName: { color: tokens.foregroundMuted, fontSize: 12, marginInlineStart: tokens.space2 },
  appearance: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 12,
    gap: tokens.space2,
  },
  select: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    color: tokens.foreground,
    minHeight: 32,
  },
  workspace: {
    display: "grid",
    gridTemplateColumns: "minmax(300px, 380px) minmax(0, 1fr)",
    minHeight: "calc(100vh - 65px)",
    "@media (max-width: 760px)": { gridTemplateColumns: "1fr" },
  },
  sidebar: {
    borderInlineEndColor: tokens.border,
    borderInlineEndStyle: "solid",
    borderInlineEndWidth: 1,
    padding: tokens.space5,
  },
  queueHeader: { alignItems: "end", display: "flex", justifyContent: "space-between" },
  eyebrow: {
    color: tokens.accent,
    fontSize: 11,
    fontWeight: 750,
    letterSpacing: "0.09em",
    margin: 0,
    textTransform: "uppercase",
  },
  heading: { fontSize: 28, letterSpacing: "-0.04em", marginBlock: tokens.space1 },
  total: { color: tokens.foregroundMuted, fontSize: 13 },
  counts: {
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 12,
    gap: tokens.space4,
    marginBlock: tokens.space4,
  },
  capture: { display: "flex", gap: tokens.space2 },
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
    ":focus": { borderColor: tokens.accent, outline: "none" },
  },
  taskList: { display: "grid", gap: tokens.space1, marginBlockStart: tokens.space5 },
  taskRow: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "32px minmax(0, 1fr) auto",
    minHeight: 48,
    paddingInline: tokens.space2,
    textAlign: "start",
    ":hover": { backgroundColor: tokens.surfaceMuted },
  },
  taskRowSelected: { backgroundColor: tokens.surface, borderColor: tokens.border },
  taskReference: { color: tokens.foregroundMuted, fontSize: 11 },
  taskTitle: {
    fontSize: 13,
    fontWeight: 650,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  backlog: { color: tokens.foregroundMuted, fontSize: 10, textTransform: "uppercase" },
  ready: { color: tokens.accent, fontSize: 10, fontWeight: 750, textTransform: "uppercase" },
  detail: { backgroundColor: tokens.surface, padding: "clamp(24px, 5vw, 64px)" },
  empty: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    minHeight: 420,
    textAlign: "center",
  },
  form: { display: "grid", gap: tokens.space5, margin: "0 auto", maxWidth: 760 },
  detailHeader: {
    alignItems: "center",
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "flex",
    justifyContent: "space-between",
    paddingBlockEnd: tokens.space4,
  },
  version: { color: tokens.foregroundMuted, fontSize: 12, marginBlock: tokens.space1 },
  field: { display: "grid", gap: tokens.space2 },
  fieldLabel: { fontSize: 13, fontWeight: 700 },
  required: {
    color: tokens.foregroundMuted,
    fontSize: 10,
    fontWeight: 600,
    marginInlineStart: tokens.space2,
    textTransform: "uppercase",
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
    ":focus": { borderColor: tokens.accent, outline: "none" },
  },
  hint: { color: tokens.foregroundMuted, fontSize: 11 },
  error: { color: tokens.danger, fontSize: 13, margin: 0 },
  formFooter: {
    alignItems: "center",
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 12,
    justifyContent: "space-between",
    paddingBlockStart: tokens.space4,
  },
  srOnly: { height: 1, margin: -1, overflow: "hidden", position: "absolute", width: 1 },
});
