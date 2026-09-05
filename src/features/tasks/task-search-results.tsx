import { useId } from "react";
import { Link } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";

import type {
  SavedViewGrouping,
  SavedViewPresentation,
  SavedViewVisibleField,
} from "../../domain/saved-views";
import type { TaskSearchItem } from "../../domain/task-filters";
import type { TaskLifecycle } from "../../domain/tasks";
import { tokens } from "../../styles/tokens.stylex";

const lifecycleOrder = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "cancelled",
] as const satisfies readonly TaskLifecycle[];

const lifecycleLabels: Record<TaskLifecycle, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

const fieldLabels: Record<SavedViewVisibleField, string> = {
  title: "Title",
  lifecycle: "Lifecycle",
  eligibility: "Eligibility",
  priority: "Priority",
  tags: "Tags",
  capabilities: "Capabilities",
  assignee: "Assignee",
  not_before: "Start date",
  due_at: "Due date",
  updated_at: "Updated",
};

export type TaskSearchResultsProps = {
  items: readonly TaskSearchItem[];
  presentation?: SavedViewPresentation;
  grouping?: SavedViewGrouping;
  visibleFields: readonly SavedViewVisibleField[];
  selectedTaskIds?: ReadonlySet<string>;
  onTaskSelected?: (taskId: string, selected: boolean) => void;
};

type ResolvedTaskSearchResultsProps = {
  items: readonly TaskSearchItem[];
  visibleFields: readonly SavedViewVisibleField[];
  selectedTaskIds?: ReadonlySet<string>;
  onTaskSelected?: (taskId: string, selected: boolean) => void;
};

export function TaskSearchResults({
  items,
  presentation = "list",
  grouping,
  visibleFields,
  selectedTaskIds,
  onTaskSelected,
}: TaskSearchResultsProps) {
  const resolvedGrouping =
    grouping ?? (presentation === "board" ? { type: "lifecycle" } : { type: "none" });
  return (
    <section
      aria-label={presentation === "board" ? "Task board" : "Task search results"}
      {...stylex.props(styles.root)}
    >
      {items.length === 0 ? (
        <output {...stylex.props(styles.empty)}>No tasks match this view.</output>
      ) : null}
      {presentation === "board" ? (
        <TaskBoard
          items={items}
          grouping={resolvedGrouping}
          visibleFields={visibleFields}
          selectedTaskIds={selectedTaskIds}
          onTaskSelected={onTaskSelected}
        />
      ) : (
        <TaskGroupedList
          items={items}
          grouping={resolvedGrouping}
          visibleFields={visibleFields}
          selectedTaskIds={selectedTaskIds}
          onTaskSelected={onTaskSelected}
        />
      )}
    </section>
  );
}

function TaskList({
  items,
  visibleFields,
  selectedTaskIds,
  onTaskSelected,
  ariaLabel = "Tasks",
}: ResolvedTaskSearchResultsProps & { ariaLabel?: string }) {
  return (
    <ul aria-label={ariaLabel} {...stylex.props(styles.list)}>
      {items.map((item) => (
        <li key={item.task.id}>
          <TaskResultRow
            item={item}
            visibleFields={visibleFields}
            selected={selectedTaskIds?.has(item.task.id) ?? false}
            onSelectedChange={onTaskSelected}
            layout="list"
          />
        </li>
      ))}
    </ul>
  );
}

function TaskGroupedList({
  items,
  grouping,
  visibleFields,
  selectedTaskIds,
  onTaskSelected,
}: ResolvedTaskSearchResultsProps & { grouping: SavedViewGrouping }) {
  const headingPrefix = useId();
  if (grouping.type === "none") {
    return (
      <TaskList
        items={items}
        visibleFields={visibleFields}
        selectedTaskIds={selectedTaskIds}
        onTaskSelected={onTaskSelected}
      />
    );
  }
  return (
    <div {...stylex.props(styles.groupedList)}>
      {taskGroups(items, grouping, false).map((group) => {
        const headingId = `${headingPrefix}-${group.key}`;
        return (
          <section key={group.key} aria-labelledby={headingId} {...stylex.props(styles.listGroup)}>
            <header {...stylex.props(styles.groupHeader)}>
              <h2 id={headingId} {...stylex.props(styles.groupHeading)}>
                {group.label}
              </h2>
              <span aria-label={`${group.items.length} tasks`} {...stylex.props(styles.laneCount)}>
                {group.items.length}
              </span>
            </header>
            <TaskList
              items={group.items}
              visibleFields={visibleFields}
              selectedTaskIds={selectedTaskIds}
              onTaskSelected={onTaskSelected}
              ariaLabel={`${group.label} tasks`}
            />
          </section>
        );
      })}
    </div>
  );
}

function TaskBoard({
  items,
  grouping,
  visibleFields,
  selectedTaskIds,
  onTaskSelected,
}: ResolvedTaskSearchResultsProps & { grouping: SavedViewGrouping }) {
  const boardId = useId();
  return (
    <div {...stylex.props(styles.board)}>
      {taskGroups(items, grouping, true).map((group) => {
        const headingId = `${boardId}-${group.key}`;
        return (
          <section key={group.key} aria-labelledby={headingId} {...stylex.props(styles.lane)}>
            <header {...stylex.props(styles.laneHeader)}>
              <h2 id={headingId} {...stylex.props(styles.laneHeading)}>
                {group.label}
              </h2>
              <span aria-label={`${group.items.length} tasks`} {...stylex.props(styles.laneCount)}>
                {group.items.length}
              </span>
            </header>
            <ul aria-label={`${group.label} tasks`} {...stylex.props(styles.laneList)}>
              {group.items.map((item) => (
                <li key={item.task.id}>
                  <TaskResultRow
                    item={item}
                    visibleFields={visibleFields}
                    selected={selectedTaskIds?.has(item.task.id) ?? false}
                    onSelectedChange={onTaskSelected}
                    layout="board"
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const priorityOrder = ["urgent", "high", "normal", "low"] as const;
const priorityLabels = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" } as const;
const eligibilityOrder = [
  "claimable",
  "claimed",
  "scheduled",
  "blocked",
  "capability_mismatch",
  "not_ready",
  "complete",
  "archived",
  "not_evaluated",
] as const;

function taskGroups(
  items: readonly TaskSearchItem[],
  grouping: SavedViewGrouping,
  includeEmpty: boolean,
) {
  let groups: Array<{ key: string; label: string; items: readonly TaskSearchItem[] }>;
  if (grouping.type === "none") {
    groups = [{ key: "all", label: "Tasks", items }];
  } else if (grouping.type === "lifecycle") {
    groups = lifecycleOrder.map((lifecycle) => ({
      key: lifecycle,
      label: lifecycleLabels[lifecycle],
      items: items.filter((item) => item.task.lifecycle === lifecycle),
    }));
  } else if (grouping.type === "priority") {
    groups = priorityOrder.map((priority) => ({
      key: priority,
      label: priorityLabels[priority],
      items: items.filter((item) => item.task.priority === priority),
    }));
  } else if (grouping.type === "eligibility") {
    groups = eligibilityOrder.map((eligibility) => ({
      key: eligibility,
      label: eligibility.replaceAll("_", " "),
      items: items.filter(
        (item) => (item.task.eligibility?.status ?? "not_evaluated") === eligibility,
      ),
    }));
  } else {
    const tagName =
      items.flatMap(({ task }) => task.tags).find(({ id }) => id === grouping.tagId)?.name ??
      grouping.tagId;
    groups = [
      {
        key: "with-tag",
        label: tagName,
        items: items.filter(({ task }) => task.tags.some(({ id }) => id === grouping.tagId)),
      },
      {
        key: "without-tag",
        label: `Without ${tagName}`,
        items: items.filter(({ task }) => task.tags.every(({ id }) => id !== grouping.tagId)),
      },
    ];
  }
  return includeEmpty ? groups : groups.filter((group) => group.items.length > 0);
}

function TaskResultRow({
  item,
  visibleFields,
  selected,
  onSelectedChange,
  layout,
}: {
  item: TaskSearchItem;
  visibleFields: readonly SavedViewVisibleField[];
  selected: boolean;
  onSelectedChange?: (taskId: string, selected: boolean) => void;
  layout: SavedViewPresentation;
}) {
  const checkboxId = useId();
  const selectable = Boolean(onSelectedChange);
  const fields = (
    <>
      <Link
        to="/projects/$projectId/tasks/$taskId"
        params={{ projectId: item.task.projectId, taskId: item.task.id }}
        aria-label={`Task #${item.task.sequence}`}
        {...stylex.props(styles.reference, styles.taskLink)}
      >
        #{item.task.sequence}
      </Link>
      <span {...stylex.props(styles.fields)}>
        {visibleFields.map((field) => (
          <TaskResultField key={field} item={item} field={field} />
        ))}
      </span>
    </>
  );
  return (
    <div
      {...stylex.props(
        styles.taskRow,
        selectable && styles.selectableRow,
        layout === "list" ? styles.listRow : styles.boardRow,
        selected && styles.selected,
      )}
    >
      {onSelectedChange ? (
        <>
          <input
            id={checkboxId}
            type="checkbox"
            aria-label={`Select task #${item.task.sequence}: ${item.task.title}`}
            aria-checked={selected}
            checked={selected}
            onChange={(event) => onSelectedChange(item.task.id, event.currentTarget.checked)}
            {...stylex.props(styles.checkbox)}
          />
          <div
            {...stylex.props(
              styles.taskLabel,
              styles.selectableLabel,
              layout === "list" ? styles.listLabel : styles.boardLabel,
            )}
          >
            <span {...stylex.props(styles.srOnly)}>
              Select task #{item.task.sequence}: {item.task.title}
            </span>
            {fields}
          </div>
        </>
      ) : (
        <div
          {...stylex.props(
            styles.taskLabel,
            layout === "list" ? styles.listLabel : styles.boardLabel,
          )}
        >
          {fields}
        </div>
      )}
    </div>
  );
}

function TaskResultField({ item, field }: { item: TaskSearchItem; field: SavedViewVisibleField }) {
  const value = taskFieldValue(item, field);
  if (field === "title")
    return (
      <Link
        to="/projects/$projectId/tasks/$taskId"
        params={{ projectId: item.task.projectId, taskId: item.task.id }}
        aria-label={`Open task #${item.task.sequence}: ${item.task.title}`}
        {...stylex.props(styles.field, styles.title, styles.taskLink)}
      >
        {value}
      </Link>
    );
  return (
    <span {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.srOnly)}>{fieldLabels[field]}: </span>
      {value}
    </span>
  );
}

function taskFieldValue(item: TaskSearchItem, field: SavedViewVisibleField) {
  const { task } = item;
  switch (field) {
    case "title":
      return task.title;
    case "lifecycle":
      return lifecycleLabels[task.lifecycle];
    case "eligibility":
      return task.eligibility?.status.replaceAll("_", " ") ?? "Not evaluated";
    case "priority":
      return task.priority;
    case "tags":
      return task.tags.map((tag) => tag.name).join(", ") || "No tags";
    case "capabilities":
      return task.requiredCapabilities.join(", ") || "No capabilities";
    case "assignee":
      return task.claim?.agentDisplayName ?? "Unassigned";
    case "not_before":
      return task.notBefore ?? "Not scheduled";
    case "due_at":
      return task.dueAt ?? "No due date";
    case "updated_at":
      return task.updatedAt;
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

const styles = stylex.create({
  taskLink: {
    color: tokens.foreground,
    textDecoration: "none",
    ":hover": { color: tokens.accent, textDecoration: "underline" },
    ":focus-visible": { outline: `2px solid ${tokens.accent}`, outlineOffset: 2 },
  },
  root: {
    display: "grid",
    gap: tokens.space3,
    minWidth: 0,
  },
  empty: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    margin: 0,
    padding: tokens.space5,
    textAlign: "center",
  },
  list: {
    display: "grid",
    gap: tokens.space1,
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  groupedList: { display: "grid", gap: tokens.space5 },
  listGroup: { display: "grid", gap: tokens.space2 },
  groupHeader: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
    paddingInline: tokens.space2,
  },
  groupHeading: { fontSize: 13, margin: 0, textTransform: "capitalize" },
  taskRow: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "minmax(0, 1fr)",
    width: "100%",
    ":hover": {
      borderColor: tokens.accent,
    },
  },
  selectableRow: { gridTemplateColumns: "18px minmax(0, 1fr)" },
  listRow: {
    minHeight: 50,
    paddingInlineStart: tokens.space3,
  },
  boardRow: {
    alignItems: "start",
    minHeight: 92,
    padding: tokens.space3,
  },
  selected: {
    borderColor: tokens.accent,
    backgroundColor: tokens.surfaceMuted,
  },
  taskLabel: {
    font: "inherit",
    minWidth: 0,
    textAlign: "start",
  },
  selectableLabel: { cursor: "pointer" },
  checkbox: {
    accentColor: tokens.accent,
    height: 16,
    margin: 0,
    width: 16,
  },
  listLabel: {
    alignItems: "center",
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "42px minmax(0, 1fr)",
    minHeight: 48,
    paddingBlock: tokens.space2,
    paddingInlineEnd: tokens.space3,
  },
  boardLabel: {
    display: "grid",
    gap: tokens.space2,
  },
  reference: {
    color: tokens.foregroundMuted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
  },
  fields: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.space2,
    minWidth: 0,
  },
  field: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    lineHeight: 1.35,
    overflowWrap: "anywhere",
  },
  title: {
    color: tokens.foreground,
    flexBasis: "100%",
    fontSize: 13,
    fontWeight: 650,
  },
  board: {
    display: "grid",
    gap: tokens.space3,
    gridAutoColumns: "minmax(220px, 1fr)",
    gridAutoFlow: "column",
    overflowX: "auto",
    paddingBlockEnd: tokens.space2,
  },
  lane: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space2,
    gridTemplateRows: "auto 1fr",
    minHeight: 180,
    padding: tokens.space2,
  },
  laneHeader: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
    padding: tokens.space2,
  },
  laneHeading: {
    fontSize: 12,
    letterSpacing: "0.04em",
    margin: 0,
    textTransform: "uppercase",
  },
  laneCount: {
    color: tokens.foregroundMuted,
    fontSize: 11,
  },
  laneList: {
    alignContent: "start",
    display: "grid",
    gap: tokens.space2,
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  srOnly: {
    clip: "rect(0, 0, 0, 0)",
    clipPath: "inset(50%)",
    height: 1,
    overflow: "hidden",
    position: "absolute",
    whiteSpace: "nowrap",
    width: 1,
  },
});
