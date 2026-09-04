import { useCallback, useEffect, useMemo, useReducer } from "react";

export type VisibleTaskSelectionOptions = {
  visibleTaskIds: readonly string[];
  selectedTaskIds: ReadonlySet<string>;
  onSelectedTaskIdsChange: (selectedTaskIds: ReadonlySet<string>) => void;
};

export type VisibleTaskSelection = {
  selectedTaskIds: ReadonlySet<string>;
  revision: number;
  selectedCount: number;
  visibleCount: number;
  checked: boolean;
  indeterminate: boolean;
  isTaskSelected: (taskId: string) => boolean;
  setTaskSelected: (taskId: string, selected: boolean) => void;
  setAllVisibleSelected: (selected: boolean) => void;
  clear: () => void;
};

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false;
  return [...left].every((id) => right.has(id));
}

function uniqueIds(ids: readonly string[]) {
  return [...new Set(ids)];
}

export function pruneSelectionToVisibleTaskIds(
  selectedTaskIds: ReadonlySet<string>,
  visibleTaskIds: readonly string[],
): ReadonlySet<string> {
  return new Set(uniqueIds(visibleTaskIds).filter((taskId) => selectedTaskIds.has(taskId)));
}

export function useVisibleTaskSelection({
  visibleTaskIds,
  selectedTaskIds,
  onSelectedTaskIdsChange,
}: VisibleTaskSelectionOptions): VisibleTaskSelection {
  const [revision, incrementRevision] = useReducer((value: number) => value + 1, 0);
  const visibleIds = useMemo(() => uniqueIds(visibleTaskIds), [visibleTaskIds]);
  const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds]);
  const prunedSelectedTaskIds = useMemo(
    () => pruneSelectionToVisibleTaskIds(selectedTaskIds, visibleIds),
    [selectedTaskIds, visibleIds],
  );
  const needsPruning = !sameIds(selectedTaskIds, prunedSelectedTaskIds);

  useEffect(() => {
    if (needsPruning) onSelectedTaskIdsChange(prunedSelectedTaskIds);
  }, [needsPruning, onSelectedTaskIdsChange, prunedSelectedTaskIds]);

  const commit = useCallback(
    (nextTaskIds: ReadonlySet<string>) => {
      const nextVisibleTaskIds = pruneSelectionToVisibleTaskIds(nextTaskIds, visibleIds);
      if (!sameIds(prunedSelectedTaskIds, nextVisibleTaskIds)) {
        incrementRevision();
        onSelectedTaskIdsChange(nextVisibleTaskIds);
      }
    },
    [onSelectedTaskIdsChange, prunedSelectedTaskIds, visibleIds],
  );

  const isTaskSelected = useCallback(
    (taskId: string) => prunedSelectedTaskIds.has(taskId),
    [prunedSelectedTaskIds],
  );

  const setTaskSelected = useCallback(
    (taskId: string, selected: boolean) => {
      if (!visibleIdSet.has(taskId)) return;
      const nextTaskIds = new Set(prunedSelectedTaskIds);
      if (selected) nextTaskIds.add(taskId);
      else nextTaskIds.delete(taskId);
      commit(nextTaskIds);
    },
    [commit, prunedSelectedTaskIds, visibleIdSet],
  );

  const setAllVisibleSelected = useCallback(
    (selected: boolean) => commit(new Set(selected ? visibleIds : [])),
    [commit, visibleIds],
  );

  const clear = useCallback(() => commit(new Set()), [commit]);
  const selectedCount = prunedSelectedTaskIds.size;
  const visibleCount = visibleIds.length;
  const checked = visibleCount > 0 && selectedCount === visibleCount;

  return {
    selectedTaskIds: prunedSelectedTaskIds,
    revision,
    selectedCount,
    visibleCount,
    checked,
    indeterminate: selectedCount > 0 && !checked,
    isTaskSelected,
    setTaskSelected,
    setAllVisibleSelected,
    clear,
  };
}
