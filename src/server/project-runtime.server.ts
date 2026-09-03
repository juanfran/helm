import { createSqliteProjectStore } from "../infrastructure/sqlite-project-store.server";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";

const store = createSqliteProjectStore();

export const projectServices = {
  inspector: localRepositoryInspector,
  store,
};
