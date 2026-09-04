import type { ActivityEntry, ManualBlocker, ProjectEvent } from "../../domain/activity";
import type { Task } from "../../domain/tasks";
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
  activityCollection: ProjectionCollection<ActivityEntry>;
  blockerCollection?: ProjectionCollection<ManualBlocker>;
  eventCollection?: ProjectionCollection<ProjectEvent>;
  readTaskDelta: (taskIds: readonly string[]) => Promise<ProjectionDelta<Task>>;
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

export async function projectEvent(event: ProjectEvent, projector: ProjectEventProjector) {
  const taskIds = [...new Set(event.changes.taskIds)];
  const activityEntryIds = [...new Set(event.changes.activityEntryIds)];
  const readBlockerDelta = projector.readBlockerDelta;
  const shouldReadBlockers =
    Boolean(projector.blockerCollection && readBlockerDelta) &&
    taskIds.length > 0 &&
    event.kind.startsWith("task.blocker.");

  const [taskDelta, activityDelta, blockerDelta] = await Promise.all([
    taskIds.length > 0
      ? projector.readTaskDelta(taskIds)
      : Promise.resolve<ProjectionDelta<Task>>({ upserts: [], deleteIds: [] }),
    activityEntryIds.length > 0
      ? projector.readActivityDelta(activityEntryIds)
      : Promise.resolve<ProjectionDelta<ActivityEntry>>({ upserts: [], deleteIds: [] }),
    shouldReadBlockers && readBlockerDelta
      ? readBlockerDelta(taskIds)
      : Promise.resolve<ProjectionDelta<ManualBlocker>>({ upserts: [], deleteIds: [] }),
  ]);

  applyProjectionDelta(projector.taskCollection, taskDelta);
  applyProjectionDelta(projector.activityCollection, activityDelta);
  if (projector.blockerCollection && blockerDelta) {
    applyProjectionDelta(projector.blockerCollection, blockerDelta);
  }
  projector.eventCollection?.utils.writeUpsert(event);
}
