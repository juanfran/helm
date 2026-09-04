import { useMemo, useState } from "react";

import type {
  SavedViewGrouping,
  SavedViewPresentation,
  SavedViewVisibleField,
} from "../../domain/saved-views";
import type { TaskSearchItem } from "../../domain/task-filters";
import { TaskBulkControls } from "./task-bulk-controls";
import { TaskSearchResults } from "./task-search-results";
import { useVisibleTaskSelection } from "./visible-task-selection";

export type TaskRouteResultsProps = {
  readonly projectId: string;
  readonly items: readonly TaskSearchItem[];
  readonly visibleFields: readonly SavedViewVisibleField[];
  readonly presentation?: SavedViewPresentation;
  readonly grouping?: SavedViewGrouping;
  readonly onExecuted: () => Promise<void>;
};

export function TaskRouteResults({
  projectId,
  items,
  visibleFields,
  presentation,
  grouping,
  onExecuted,
}: TaskRouteResultsProps) {
  const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const visibleTaskIds = useMemo(() => items.map(({ task }) => task.id), [items]);
  const selection = useVisibleTaskSelection({
    visibleTaskIds,
    selectedTaskIds,
    onSelectedTaskIdsChange: setSelectedTaskIds,
  });

  return (
    <>
      <TaskBulkControls projectId={projectId} selection={selection} onExecuted={onExecuted} />
      <TaskSearchResults
        items={items}
        visibleFields={visibleFields}
        presentation={presentation}
        grouping={grouping}
        selectedTaskIds={selection.selectedTaskIds}
        onTaskSelected={selection.setTaskSelected}
      />
    </>
  );
}
