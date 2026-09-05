import { useEffect, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { AlertTriangle, Bell, CircleAlert, X } from "lucide-react";

import type { ProjectEvent } from "../../domain/activity";
import { tokens } from "../../styles/tokens.stylex";
import {
  formatProjectTimestamp,
  projectEventDetail,
  projectEventTaskId,
  projectEventTitle,
} from "./project-event-presentation";

const WATERMARK_PREFIX = "helm.notification-watermark.";

export function selectImportantNotifications(events: readonly ProjectEvent[]) {
  return events
    .filter((event) => event.importance !== "routine")
    .toSorted((left, right) => right.cursor - left.cursor);
}

function readWatermark(projectId: string) {
  if (typeof localStorage === "undefined") return 0;
  try {
    const value = Number(localStorage.getItem(`${WATERMARK_PREFIX}${projectId}`));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeWatermark(projectId: string, cursor: number) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`${WATERMARK_PREFIX}${projectId}`, String(cursor));
  } catch {
    // A disabled storage backend must not make the notification center unusable.
  }
}

export function NotificationCenter({
  projectId,
  events,
  tasks,
  onSelectTask,
  defaultOpen = false,
}: {
  projectId: string;
  events: readonly ProjectEvent[];
  tasks: readonly { readonly id: string; readonly sequence: number; readonly title: string }[];
  onSelectTask?: (taskId: string) => void;
  defaultOpen?: boolean;
}) {
  return (
    <ProjectNotificationCenter
      key={projectId}
      projectId={projectId}
      events={events}
      tasks={tasks}
      onSelectTask={onSelectTask}
      defaultOpen={defaultOpen}
    />
  );
}

function ProjectNotificationCenter({
  projectId,
  events,
  tasks,
  onSelectTask,
  defaultOpen = false,
}: {
  projectId: string;
  events: readonly ProjectEvent[];
  tasks: readonly { readonly id: string; readonly sequence: number; readonly title: string }[];
  onSelectTask?: (taskId: string) => void;
  defaultOpen?: boolean;
}) {
  const notifications = useMemo(() => selectImportantNotifications(events), [events]);
  const [watermark, setWatermark] = useState(() =>
    defaultOpen
      ? Math.max(readWatermark(projectId), notifications[0]?.cursor ?? 0)
      : readWatermark(projectId),
  );
  useEffect(() => {
    writeWatermark(projectId, watermark);
  }, [projectId, watermark]);
  const taskNames = useMemo(
    () => new Map(tasks.map((task) => [task.id, `#${task.sequence} ${task.title}`])),
    [tasks],
  );
  const unreadCount = notifications.filter((event) => event.cursor > watermark).length;
  const newestCursor = notifications[0]?.cursor ?? watermark;

  function setOpen(open: boolean) {
    if (!open || newestCursor <= watermark) return;
    setWatermark(newestCursor);
    writeWatermark(projectId, newestCursor);
  }

  return (
    <Popover.Root defaultOpen={defaultOpen} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={
          unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications, none unread"
        }
        {...stylex.props(styles.trigger)}
      >
        <Bell size={17} aria-hidden="true" />
        {unreadCount > 0 ? (
          <span {...stylex.props(styles.badge)}>{unreadCount > 99 ? "99+" : unreadCount}</span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="end"
          sideOffset={8}
          {...stylex.props(styles.positioner)}
        >
          <Popover.Popup {...stylex.props(styles.popup)}>
            <div {...stylex.props(styles.header)}>
              <div>
                <Popover.Title {...stylex.props(styles.title)}>Notifications</Popover.Title>
                <Popover.Description {...stylex.props(styles.description)}>
                  Failures, blockers, expired leases, and review requests.
                </Popover.Description>
              </div>
              <Popover.Close aria-label="Close notifications" {...stylex.props(styles.close)}>
                <X size={16} aria-hidden="true" />
              </Popover.Close>
            </div>
            <ul aria-label="Important project events" {...stylex.props(styles.list)}>
              {notifications.length === 0 ? (
                <li>
                  <p {...stylex.props(styles.empty)}>Nothing needs attention.</p>
                </li>
              ) : (
                notifications.map((event) => {
                  const taskId = projectEventTaskId(event);
                  const taskName = taskId ? taskNames.get(taskId) : null;
                  const detail = projectEventDetail(event);
                  const content = (
                    <>
                      <span {...stylex.props(styles.eventIcon)} aria-hidden="true">
                        {event.importance === "critical" ? (
                          <CircleAlert size={17} />
                        ) : (
                          <AlertTriangle size={17} />
                        )}
                      </span>
                      <span {...stylex.props(styles.eventBody)}>
                        <strong {...stylex.props(styles.eventTitle)}>
                          {projectEventTitle(event.kind)}
                        </strong>
                        {taskName ? <span {...stylex.props(styles.task)}>{taskName}</span> : null}
                        {detail ? <span {...stylex.props(styles.detail)}>{detail}</span> : null}
                        <time dateTime={event.occurredAt} {...stylex.props(styles.time)}>
                          {formatProjectTimestamp(event.occurredAt)}
                        </time>
                      </span>
                    </>
                  );
                  return (
                    <li key={event.id}>
                      {taskId && onSelectTask ? (
                        <Popover.Close
                          type="button"
                          onClick={() => onSelectTask(taskId)}
                          {...stylex.props(
                            styles.event,
                            styles.eventButton,
                            event.importance === "critical" && styles.critical,
                          )}
                        >
                          {content}
                        </Popover.Close>
                      ) : (
                        <article
                          {...stylex.props(
                            styles.event,
                            event.importance === "critical" && styles.critical,
                          )}
                        >
                          {content}
                        </article>
                      )}
                    </li>
                  );
                })
              )}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const styles = stylex.create({
  trigger: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "inline-flex",
    height: 36,
    justifyContent: "center",
    position: "relative",
    width: 36,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  badge: {
    alignItems: "center",
    backgroundColor: tokens.danger,
    borderColor: tokens.background,
    borderRadius: "999px",
    borderStyle: "solid",
    borderWidth: 2,
    color: tokens.background,
    display: "inline-flex",
    fontSize: 9,
    fontWeight: 800,
    height: 18,
    justifyContent: "center",
    minWidth: 18,
    paddingInline: 3,
    position: "absolute",
    right: -7,
    top: -7,
  },
  positioner: { zIndex: 50 },
  popup: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    color: tokens.foreground,
    display: "grid",
    maxHeight: "min(620px, calc(100vh - 88px))",
    maxWidth: "calc(100vw - 24px)",
    overflow: "hidden",
    width: 420,
  },
  header: {
    alignItems: "start",
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "flex",
    gap: tokens.space4,
    justifyContent: "space-between",
    padding: tokens.space4,
  },
  title: { fontSize: 17, fontWeight: 750 },
  description: { color: tokens.foregroundMuted, fontSize: 12, marginBlockStart: tokens.space1 },
  close: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: 6,
    color: tokens.foregroundMuted,
    cursor: "pointer",
    display: "inline-flex",
    height: 30,
    justifyContent: "center",
    width: 30,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  list: {
    display: "grid",
    listStyle: "none",
    margin: 0,
    overflowY: "auto",
    padding: 0,
  },
  empty: { color: tokens.foregroundMuted, margin: 0, padding: tokens.space6 },
  event: {
    backgroundColor: "transparent",
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    borderInlineEndWidth: 0,
    borderInlineStartColor: tokens.accent,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 3,
    borderBlockStartWidth: 0,
    color: tokens.foreground,
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "20px minmax(0, 1fr)",
    padding: tokens.space4,
    textAlign: "start",
    width: "100%",
  },
  eventButton: {
    cursor: "pointer",
    font: "inherit",
    ":hover": { backgroundColor: tokens.surfaceMuted },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: -3,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  critical: { borderInlineStartColor: tokens.danger },
  eventIcon: { color: tokens.foregroundMuted, paddingBlockStart: 2 },
  eventBody: { display: "grid", gap: 3, minWidth: 0 },
  eventTitle: { fontSize: 13, textTransform: "capitalize" },
  task: { color: tokens.accent, fontSize: 12, fontWeight: 650 },
  detail: {
    color: tokens.foregroundMuted,
    display: "-webkit-box",
    fontSize: 12,
    lineClamp: 2,
    overflow: "hidden",
    overflowWrap: "anywhere",
  },
  time: { color: tokens.foregroundMuted, fontSize: 11 },
});
