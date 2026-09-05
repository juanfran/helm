export type WorkspaceView = "tasks" | "dashboard" | "activity" | "settings";
export type WorkspaceFilter = "backlog" | "ready" | "in_progress" | "review" | "done" | "claimable";
export type WorkspaceSearch = { project?: string; view?: WorkspaceView; filter?: WorkspaceFilter };
function member<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return choices.find((choice) => choice === value);
}
export const workspaceSearchSchema = {
  parse(search: Record<string, unknown>): WorkspaceSearch {
    return {
      project:
        typeof search.project === "string" && search.project.length <= 200
          ? search.project
          : undefined,
      view: member(search.view, ["tasks", "dashboard", "activity", "settings"]),
      filter: member(search.filter, [
        "backlog",
        "ready",
        "in_progress",
        "review",
        "done",
        "claimable",
      ]),
    };
  },
};
