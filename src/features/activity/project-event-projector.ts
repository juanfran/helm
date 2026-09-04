import type { ActivityEntry, ManualBlocker, ProjectEvent } from "../../domain/activity";
import type { Task, TaskAttemptSummary } from "../../domain/tasks";
import { markAuthoritativeRows } from "./optimistic-reconciliation";

export type ProjectionCollection<T extends { id: string }> = {
  has(key: string): boolean;
  utils: {
    writeBatch(callback: () => void): void;
    writeDelete(keys: string | string[]): void;
    writeUpsert(rows: Partial<T> | Array<Partial<T>>): void;
  };
};

export type ProjectionDelta<T> = {
  upserts: readonly T[];
  deleteIds: readonly string[];
};

export type ProjectEventProjector = {
  taskCollection: ProjectionCollection<Task>;
  attemptCollection?: ProjectionCollection<TaskAttemptSummary>;
  activityCollection: ProjectionCollection<ActivityEntry>;
  blockerCollection?: ProjectionCollection<ManualBlocker>;
  eventCollection?: ProjectionCollection<ProjectEvent>;
  importantEventCollection?: ProjectionCollection<ProjectEvent>;
  readTaskDelta: (taskIds: readonly string[]) => Promise<ProjectionDelta<Task>>;
  readAttemptDelta?: (taskIds: readonly string[]) => Promise<ProjectionDelta<TaskAttemptSummary>>;
  readActivityDelta: (entryIds: readonly string[]) => Promise<ProjectionDelta<ActivityEntry>>;
  readBlockerDelta?: (taskIds: readonly string[]) => Promise<ProjectionDelta<ManualBlocker>>;
};

export function applyProjectionDelta<T extends { id: string }>(
  collection: ProjectionCollection<T>,
  delta: ProjectionDelta<T>,
) {
  const presentDeleteIds = delta.deleteIds.filter((key) => collection.has(key));
  markAuthoritativeRows(collection, [...delta.deleteIds, ...delta.upserts.map((row) => row.id)]);
  collection.utils.writeBatch(() => {
    if (presentDeleteIds.length > 0) collection.utils.writeDelete(presentDeleteIds);
    if (delta.upserts.length > 0) collection.utils.writeUpsert([...delta.upserts]);
  });
}

export function projectImportantEvent(
  event: ProjectEvent,
  collection?: ProjectionCollection<ProjectEvent>,
) {
  if (!collection || event.importance === "routine") return false;
  collection.utils.writeUpsert(event);
  return true;
}

export async function projectEvent(event: ProjectEvent, projector: ProjectEventProjector) {
  const taskIds = [...new Set(event.changes.taskIds)];
  const activityEntryIds = [...new Set(event.changes.activityEntryIds)];
  const readAttemptDelta = projector.readAttemptDelta;
  const readBlockerDelta = projector.readBlockerDelta;
  const shouldReadBlockers =
    Boolean(projector.blockerCollection && readBlockerDelta) &&
    taskIds.length > 0 &&
    event.kind.startsWith("task.blocker.");

  const [taskDelta, attemptDelta, activityDelta, blockerDelta] = await Promise.all([
    taskIds.length > 0
      ? projector.readTaskDelta(taskIds)
      : Promise.resolve<ProjectionDelta<Task>>({ upserts: [], deleteIds: [] }),
    taskIds.length > 0 && projector.attemptCollection && readAttemptDelta
      ? readAttemptDelta(taskIds)
      : Promise.resolve<ProjectionDelta<TaskAttemptSummary>>({ upserts: [], deleteIds: [] }),
    activityEntryIds.length > 0
      ? projector.readActivityDelta(activityEntryIds)
      : Promise.resolve<ProjectionDelta<ActivityEntry>>({ upserts: [], deleteIds: [] }),
    shouldReadBlockers && readBlockerDelta
      ? readBlockerDelta(taskIds)
      : Promise.resolve<ProjectionDelta<ManualBlocker>>({ upserts: [], deleteIds: [] }),
  ]);

  applyProjectionDelta(projector.taskCollection, taskDelta);
  if (projector.attemptCollection) {
    applyProjectionDelta(projector.attemptCollection, attemptDelta);
  }
  applyProjectionDelta(projector.activityCollection, activityDelta);
  if (projector.blockerCollection && blockerDelta) {
    applyProjectionDelta(projector.blockerCollection, blockerDelta);
  }
  projector.eventCollection?.utils.writeUpsert(event);
  projectImportantEvent(event, projector.importantEventCollection);
}
