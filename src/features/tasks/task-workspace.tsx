import { useMemo, useState, type FormEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  Archive,
  CheckCircle2,
  GitBranch,
  Inbox,
  Link2,
  Plus,
  RotateCcw,
  ShipWheel,
  SlidersHorizontal,
} from "lucide-react";

import { Button } from "../../components/ui/button";
import { themeSchema, type Project, type Theme } from "../../domain/projects";
import {
  emptyRichTextDocument,
  taskPrioritySchema,
  taskRelationTypeSchema,
  taskSizeSchema,
  type ArchiveTaskInput,
  type CompleteTaskInput,
  type CreateTaskInput,
  type CreateTaskRelationInput,
  type PrepareTaskInput,
  type ReopenTaskInput,
  type RichTextDocument,
  type Task,
  type UpdateTaskPlanningInput,
} from "../../domain/tasks";
import type { TaskCommandResponse, TaskRelationCommandResponse } from "../../server/task-adapter";
import { tokens } from "../../styles/tokens.stylex";
import { RichTextEditor } from "./rich-text-editor";

type TaskWorkspaceProps = {
  project: Project;
  theme: Theme;
  tasks: readonly Task[];
  onCreateTask: (input: CreateTaskInput) => Promise<TaskCommandResponse>;
  onPrepareTask: (input: PrepareTaskInput) => Promise<TaskCommandResponse>;
  onUpdateTaskPlanning: (input: UpdateTaskPlanningInput) => Promise<TaskCommandResponse>;
  onCompleteTask: (input: CompleteTaskInput) => Promise<TaskCommandResponse>;
  onReopenTask: (input: ReopenTaskInput) => Promise<TaskCommandResponse>;
  onCreateTaskRelation: (input: CreateTaskRelationInput) => Promise<TaskRelationCommandResponse>;
  onArchiveTask: (input: ArchiveTaskInput) => Promise<TaskCommandResponse>;
  onChangeTheme: (theme: Theme) => Promise<void>;
};

export function TaskWorkspace({
  project,
  theme,
  tasks,
  onCreateTask,
  onPrepareTask,
  onUpdateTaskPlanning,
  onCompleteTask,
  onReopenTask,
  onCreateTaskRelation,
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
      done: tasks.filter((task) => task.lifecycle === "done").length,
      claimable: tasks.filter((task) => task.eligibility?.claimable).length,
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
        parentTaskId: null,
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
            <span>
              <CheckCircle2 size={14} aria-hidden="true" /> {counts.done} done
            </span>
            <span>
              <SlidersHorizontal size={14} aria-hidden="true" /> {counts.claimable} claimable
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
                <span {...stylex.props(styles.taskTitleGroup)}>
                  <span {...stylex.props(styles.taskTitle)}>{task.title}</span>
                  <span {...stylex.props(styles.taskMeta)}>
                    {[
                      task.priority,
                      task.dueAt ? `due ${task.dueAt}` : null,
                      task.size ? `size ${task.size}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span {...stylex.props(styles[task.lifecycle])}>{task.lifecycle}</span>
                {task.eligibility ? (
                  <span {...stylex.props(styles.eligibility)}>{task.eligibility.status}</span>
                ) : null}
              </button>
            ))}
          </nav>
        </aside>

        <section {...stylex.props(styles.detail)}>
          {selectedTask ? (
            <PreparationPanel
              key={`${selectedTask.id}:${selectedTask.version}`}
              task={selectedTask}
              tasks={tasks}
              onCreateTask={onCreateTask}
              onPrepare={onPrepareTask}
              onUpdatePlanning={onUpdateTaskPlanning}
              onComplete={onCompleteTask}
              onReopen={onReopenTask}
              onCreateRelation={onCreateTaskRelation}
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
  tasks,
  onCreateTask,
  onPrepare,
  onUpdatePlanning,
  onComplete,
  onReopen,
  onCreateRelation,
  onArchive,
}: {
  task: Task;
  tasks: readonly Task[];
  onCreateTask: TaskWorkspaceProps["onCreateTask"];
  onPrepare: TaskWorkspaceProps["onPrepareTask"];
  onUpdatePlanning: TaskWorkspaceProps["onUpdateTaskPlanning"];
  onComplete: TaskWorkspaceProps["onCompleteTask"];
  onReopen: TaskWorkspaceProps["onReopenTask"];
  onCreateRelation: TaskWorkspaceProps["onCreateTaskRelation"];
  onArchive: TaskWorkspaceProps["onArchiveTask"];
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState<RichTextDocument>(task.description);
  const [expectedOutcome, setExpectedOutcome] = useState(task.expectedOutcome);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(task.acceptanceCriteria);
  const [agentContext, setAgentContext] = useState(task.agentContext);
  const [checklist, setChecklist] = useState(task.checklist.map((item) => item.text).join("\n"));
  const [priority, setPriority] = useState(task.priority);
  const [position, setPosition] = useState(String(task.position));
  const [notBefore, setNotBefore] = useState(task.notBefore ?? "");
  const [dueAt, setDueAt] = useState(task.dueAt ?? "");
  const [size, setSize] = useState(task.size ?? "");
  const [tags, setTags] = useState(task.tags.map((tag) => tag.name).join("\n"));
  const [requiredCapabilities, setRequiredCapabilities] = useState(
    task.requiredCapabilities.join("\n"),
  );
  const [childTitle, setChildTitle] = useState("");
  const [relationTargetId, setRelationTargetId] = useState(
    tasks.find((candidate) => candidate.id !== task.id)?.id ?? "",
  );
  const [relationType, setRelationType] = useState("blocks");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parentTask = task.parentTaskId
    ? tasks.find((candidate) => candidate.id === task.parentTaskId)
    : null;
  const childTasks = task.childTaskIds
    .map((childId) => tasks.find((candidate) => candidate.id === childId))
    .filter((child) => child !== undefined);
  const relationTarget = tasks.find((candidate) => candidate.id === relationTargetId);

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
        priority,
        position: Number(position),
        notBefore: notBefore || null,
        dueAt: dueAt || null,
        size: taskSizeSchema.nullable().parse(size || null),
        tags: parseTagInputs(tags),
        requiredCapabilities: parseLines(requiredCapabilities),
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

  async function updatePlanning() {
    setPending(true);
    setError(null);
    try {
      const response = await onUpdatePlanning({
        taskId: task.id,
        priority,
        position: Number(position),
        notBefore: notBefore || null,
        dueAt: dueAt || null,
        size: taskSizeSchema.nullable().parse(size || null),
        tags: parseTagInputs(tags),
        requiredCapabilities: parseLines(requiredCapabilities),
        expectedVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not update task planning.");
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

  async function complete() {
    setPending(true);
    setError(null);
    try {
      const response = await onComplete({
        taskId: task.id,
        expectedVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not complete the task.");
    } finally {
      setPending(false);
    }
  }

  async function reopen() {
    setPending(true);
    setError(null);
    try {
      const response = await onReopen({
        taskId: task.id,
        expectedVersion: task.version,
        reason: "Reopened from the task workspace",
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not reopen the task.");
    } finally {
      setPending(false);
    }
  }

  async function createChild() {
    setPending(true);
    setError(null);
    try {
      const response = await onCreateTask({
        projectId: task.projectId,
        parentTaskId: task.id,
        lifecycle: "backlog",
        title: childTitle,
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        expectedVersion: 0,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) setChildTitle("");
      else setError(response.error.message);
    } catch {
      setError("Helm could not create the child task.");
    } finally {
      setPending(false);
    }
  }

  async function createRelation() {
    if (!relationTarget) return;
    setPending(true);
    setError(null);
    try {
      const response = await onCreateRelation({
        projectId: task.projectId,
        sourceTaskId: task.id,
        targetTaskId: relationTarget.id,
        type: taskRelationTypeSchema.parse(relationType),
        expectedSourceVersion: task.version,
        expectedTargetVersion: relationTarget.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not create the task relation.");
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
        <span {...stylex.props(styles.headerActions)}>
          {task.lifecycle === "done" ? (
            <Button type="button" variant="quiet" disabled={pending} onClick={() => void reopen()}>
              <RotateCcw size={15} aria-hidden="true" /> Reopen
            </Button>
          ) : (
            <Button
              type="button"
              variant="quiet"
              disabled={pending}
              onClick={() => void complete()}
            >
              <CheckCircle2 size={15} aria-hidden="true" /> Done
            </Button>
          )}
          <Button type="button" variant="quiet" disabled={pending} onClick={() => void archive()}>
            <Archive size={15} aria-hidden="true" /> Archive
          </Button>
        </span>
      </div>
      <section {...stylex.props(styles.relations)} aria-label="Task relations">
        <div>
          <p {...stylex.props(styles.fieldLabel)}>Hierarchy</p>
          <p {...stylex.props(styles.hint)}>
            Parent: {parentTask ? `#${parentTask.sequence} ${parentTask.title}` : "None"}
          </p>
          <p {...stylex.props(styles.hint)}>
            Children:{" "}
            {childTasks.length > 0
              ? childTasks.map((child) => `#${child.sequence} ${child.title}`).join(", ")
              : "None"}
          </p>
        </div>
        <div>
          <p {...stylex.props(styles.fieldLabel)}>Upstream</p>
          <RelationList
            empty="No upstream relations"
            relations={task.upstreamRelations.map(
              (relation) =>
                `${relation.type} from #${relation.sourceSequence} ${relation.sourceTitle}`,
            )}
          />
        </div>
        <div>
          <p {...stylex.props(styles.fieldLabel)}>Downstream</p>
          <RelationList
            empty="No downstream relations"
            relations={task.downstreamRelations.map(
              (relation) =>
                `${relation.type} to #${relation.targetSequence} ${relation.targetTitle}`,
            )}
          />
        </div>
      </section>
      <div {...stylex.props(styles.inlineForm)} aria-label="Create child task">
        <input
          aria-label="Child task title"
          value={childTitle}
          onChange={(event) => setChildTitle(event.target.value)}
          placeholder="Child task title"
          maxLength={300}
          {...stylex.props(styles.input)}
        />
        <Button
          type="button"
          disabled={pending || childTitle.trim().length === 0}
          onClick={() => void createChild()}
        >
          <GitBranch size={16} aria-hidden="true" />
          Add child
        </Button>
      </div>
      <div {...stylex.props(styles.inlineForm)}>
        <select
          aria-label="Relation type"
          value={relationType}
          onChange={(event) => setRelationType(event.target.value)}
          {...stylex.props(styles.select, styles.fullWidth)}
        >
          <option value="blocks">Blocks</option>
          <option value="related_to">Related to</option>
          <option value="duplicates">Duplicates</option>
          <option value="discovered_from">Discovered from</option>
        </select>
        <select
          aria-label="Relation target"
          value={relationTargetId}
          onChange={(event) => setRelationTargetId(event.target.value)}
          {...stylex.props(styles.select, styles.fullWidth)}
        >
          <option value="">Select target</option>
          {tasks
            .filter((candidate) => candidate.id !== task.id)
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                #{candidate.sequence} {candidate.title}
              </option>
            ))}
        </select>
        <Button
          type="button"
          disabled={pending || !relationTargetId}
          onClick={() => void createRelation()}
        >
          <Link2 size={16} aria-hidden="true" />
          Add relation
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
      <div {...stylex.props(styles.planningGrid)}>
        <Field label="Priority">
          <select
            aria-label="Priority"
            value={priority}
            onChange={(event) => setPriority(taskPrioritySchema.parse(event.target.value))}
            {...stylex.props(styles.select, styles.fullWidth)}
          >
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </Field>
        <Field label="Position">
          <input
            aria-label="Position"
            type="number"
            min={0}
            value={position}
            onChange={(event) => setPosition(event.target.value)}
            {...stylex.props(styles.input)}
          />
        </Field>
        <Field label="Start date">
          <input
            aria-label="Start date"
            type="date"
            value={notBefore}
            onChange={(event) => setNotBefore(event.target.value)}
            {...stylex.props(styles.input)}
          />
        </Field>
        <Field label="Due date">
          <input
            aria-label="Due date"
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
            {...stylex.props(styles.input)}
          />
        </Field>
        <Field label="Size">
          <select
            aria-label="Size"
            value={size}
            onChange={(event) => setSize(event.target.value)}
            {...stylex.props(styles.select, styles.fullWidth)}
          >
            <option value="">Unestimated</option>
            <option value="xs">XS</option>
            <option value="s">S</option>
            <option value="m">M</option>
            <option value="l">L</option>
            <option value="xl">XL</option>
          </select>
        </Field>
      </div>
      <Field label="Tags">
        <textarea
          aria-label="Tags"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          rows={3}
          {...stylex.props(styles.textarea)}
        />
      </Field>
      <Field label="Required capabilities">
        <textarea
          aria-label="Required capabilities"
          value={requiredCapabilities}
          onChange={(event) => setRequiredCapabilities(event.target.value)}
          rows={3}
          {...stylex.props(styles.textarea)}
        />
      </Field>
      {task.eligibility ? (
        <p {...stylex.props(styles.hint)}>
          {task.eligibility.status}: {task.eligibility.reasons.join(" ")}{" "}
          {task.eligibility.orderingExplanation}
        </p>
      ) : null}
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
        <span {...stylex.props(styles.footerActions)}>
          <Button
            type="button"
            variant="quiet"
            disabled={pending}
            onClick={() => void updatePlanning()}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            Save planning
          </Button>
          <Button type="submit" disabled={pending}>
            <CheckCircle2 size={16} aria-hidden="true" />
            {pending
              ? "Saving…"
              : task.lifecycle === "ready"
                ? "Save preparation"
                : "Move to ready"}
          </Button>
        </span>
      </div>
    </form>
  );
}

function parseLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseTagInputs(value: string) {
  const colors = ["#2563eb", "#16a34a", "#c2410c", "#7c3aed", "#0f766e"];
  return parseLines(value).map((name, index) => ({
    name,
    description: "",
    color: colors[index % colors.length] ?? "#2563eb",
    exclusiveGroup: null,
  }));
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

function RelationList({ relations, empty }: { relations: readonly string[]; empty: string }) {
  return relations.length > 0 ? (
    <ul {...stylex.props(styles.relationList)}>
      {relations.map((relation) => (
        <li key={relation}>{relation}</li>
      ))}
    </ul>
  ) : (
    <p {...stylex.props(styles.hint)}>{empty}</p>
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
  fullWidth: { width: "100%" },
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
    minHeight: 58,
    paddingInline: tokens.space2,
    textAlign: "start",
    ":hover": { backgroundColor: tokens.surfaceMuted },
  },
  taskRowSelected: { backgroundColor: tokens.surface, borderColor: tokens.border },
  taskReference: { color: tokens.foregroundMuted, fontSize: 11 },
  taskTitleGroup: { display: "grid", gap: 2, minWidth: 0 },
  taskTitle: {
    fontSize: 13,
    fontWeight: 650,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  taskMeta: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  backlog: { color: tokens.foregroundMuted, fontSize: 10, textTransform: "uppercase" },
  ready: { color: tokens.accent, fontSize: 10, fontWeight: 750, textTransform: "uppercase" },
  done: { color: tokens.accent, fontSize: 10, fontWeight: 750, textTransform: "uppercase" },
  cancelled: { color: tokens.danger, fontSize: 10, fontWeight: 750, textTransform: "uppercase" },
  eligibility: {
    color: tokens.foregroundMuted,
    fontSize: 10,
    gridColumn: "2 / 4",
    textTransform: "uppercase",
  },
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
  headerActions: { display: "flex", flexWrap: "wrap", gap: tokens.space2, justifyContent: "end" },
  version: { color: tokens.foregroundMuted, fontSize: 12, marginBlock: tokens.space1 },
  relations: {
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    paddingBlockEnd: tokens.space4,
    "@media (max-width: 820px)": { gridTemplateColumns: "1fr" },
  },
  relationList: {
    color: tokens.foregroundMuted,
    display: "grid",
    fontSize: 12,
    gap: tokens.space1,
    margin: 0,
    paddingInlineStart: tokens.space4,
  },
  inlineForm: {
    alignItems: "center",
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "minmax(0, 1fr) auto",
    "@media (max-width: 640px)": { gridTemplateColumns: "1fr" },
  },
  field: { display: "grid", gap: tokens.space2 },
  fieldLabel: { fontSize: 13, fontWeight: 700 },
  planningGrid: {
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "repeat(5, minmax(112px, 1fr))",
    "@media (max-width: 980px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr" },
  },
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
  footerActions: { display: "flex", flexWrap: "wrap", gap: tokens.space2, justifyContent: "end" },
  srOnly: { height: 1, margin: -1, overflow: "hidden", position: "absolute", width: 1 },
});
