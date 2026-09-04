import { createSqliteProjectStore } from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";
import { createSqliteAgentStore } from "../infrastructure/sqlite-agent-store.server";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import { systemTaskClock } from "../application/tasks";
import { reconcileActiveAgentRuns } from "../application/agents";
import { Effect } from "effect";

const projectStore = createSqliteProjectStore();

export const projectServices = {
  inspector: localRepositoryInspector,
  store: projectStore,
};

export const taskServices = {
  store: createSqliteTaskStore(projectStore.database),
  clock: systemTaskClock,
};
export const agentServices = { store: createSqliteAgentStore(projectStore.database) };
Effect.runSync(reconcileActiveAgentRuns(agentServices));
