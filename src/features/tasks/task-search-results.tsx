import { useId } from "react";
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
  selectedTaskId?: string | null;
  onSelect?: (taskId: string) => void;
};

type ResolvedTaskSearchResultsProps = {
  items: readonly TaskSearchItem[];
  visibleFields: readonly SavedViewVisibleField[];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
};

export function TaskSearchResults({
  items,
  presentation = "list",
  grouping,
  visibleFields,
  selectedTaskId = null,
  onSelect = ignoreSelection,
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
          selectedTaskId={selectedTaskId}
          onSelect={onSelect}
        />
      ) : (
        <TaskGroupedList
          items={items}
          grouping={resolvedGrouping}
          visibleFields={visibleFields}
          selectedTaskId={selectedTaskId}
          onSelect={onSelect}
        />
      )}
    </section>
  );
}

function TaskList({
  items,
  visibleFields,
  selectedTaskId,
  onSelect,
  ariaLabel = "Tasks",
}: ResolvedTaskSearchResultsProps & { ariaLabel?: string }) {
  return (
    <ul aria-label={ariaLabel} {...stylex.props(styles.list)}>
      {items.map((item) => (
        <li key={item.task.id}>
          <TaskResultButton
            item={item}
            visibleFields={visibleFields}
            selected={selectedTaskId === item.task.id}
            onSelect={onSelect}
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
  selectedTaskId,
  onSelect,
}: ResolvedTaskSearchResultsProps & { grouping: SavedViewGrouping }) {
  const headingPrefix = useId();
  if (grouping.type === "none") {
    return (
      <TaskList
        items={items}
        visibleFields={visibleFields}
        selectedTaskId={selectedTaskId}
        onSelect={onSelect}
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
              selectedTaskId={selectedTaskId}
              onSelect={onSelect}
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
  selectedTaskId,
  onSelect,
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
                  <TaskResultButton
                    item={item}
                    visibleFields={visibleFields}
                    selected={selectedTaskId === item.task.id}
                    onSelect={onSelect}
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

function TaskResultButton({
  item,
  visibleFields,
  selected,
  onSelect,
  layout,
}: {
  item: TaskSearchItem;
  visibleFields: readonly SavedViewVisibleField[];
  selected: boolean;
  onSelect: (taskId: string) => void;
  layout: SavedViewPresentation;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      aria-label={`Select task #${item.task.sequence}: ${item.task.title}`}
      onClick={() => onSelect(item.task.id)}
      {...stylex.props(
        styles.taskButton,
        layout === "list" ? styles.listButton : styles.boardButton,
        selected && styles.selected,
      )}
    >
      <span {...stylex.props(styles.reference)}>#{item.task.sequence}</span>
      <span {...stylex.props(styles.fields)}>
        {visibleFields.map((field) => (
          <TaskResultField key={field} item={item} field={field} />
        ))}
      </span>
    </button>
  );
}

function TaskResultField({ item, field }: { item: TaskSearchItem; field: SavedViewVisibleField }) {
  const value = taskFieldValue(item, field);
  return (
    <span {...stylex.props(styles.field, field === "title" && styles.title)}>
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

function ignoreSelection() {}

const styles = stylex.create({
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
  taskButton: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    font: "inherit",
    textAlign: "start",
    width: "100%",
    ":hover": {
      borderColor: tokens.accent,
    },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  listButton: {
    alignItems: "center",
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "42px minmax(0, 1fr)",
    minHeight: 50,
    paddingBlock: tokens.space2,
    paddingInline: tokens.space3,
  },
  boardButton: {
    display: "grid",
    gap: tokens.space2,
    minHeight: 92,
    padding: tokens.space3,
  },
  selected: {
    borderColor: tokens.accent,
    backgroundColor: tokens.surfaceMuted,
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
