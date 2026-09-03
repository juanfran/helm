import { createSqliteProjectStore } from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";

const projectStore = createSqliteProjectStore();

export const projectServices = {
  inspector: localRepositoryInspector,
  store: projectStore,
};

export const taskServices = { store: createSqliteTaskStore(projectStore.database) };
