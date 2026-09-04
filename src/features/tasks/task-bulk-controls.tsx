import { useSuspenseQuery } from "@tanstack/react-query";

import { executeHumanBulkTasks, previewHumanBulkTasks } from "../../server/task-functions";
import { BulkTaskControls, type BulkTaskControlsProps } from "./bulk-task-controls";
import { taskTagsQueryOptions } from "./task-tags-query";

export type TaskBulkControlsProps = Pick<BulkTaskControlsProps, "projectId" | "selection"> & {
  readonly onExecuted: () => Promise<void>;
};

export function TaskBulkControls({ projectId, selection, onExecuted }: TaskBulkControlsProps) {
  const { data: tags } = useSuspenseQuery(taskTagsQueryOptions(projectId));
  return (
    <BulkTaskControls
      projectId={projectId}
      selection={selection}
      tagDefinitions={tags}
      onPreview={(intent) => previewHumanBulkTasks({ data: intent })}
      onExecute={async (command) => {
        const response = await executeHumanBulkTasks({ data: command });
        if (response.ok) await onExecuted();
        return response;
      }}
    />
  );
}
