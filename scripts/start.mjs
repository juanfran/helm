import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { ensureProductionBuild } from "./build-state.mjs";
import {
  ensureDatabaseParent,
  HELM_PROJECT_ROOT,
  loadHelmEnvironment,
  resolveHelmEnvironment,
} from "./environment.mjs";

process.chdir(HELM_PROJECT_ROOT);
loadHelmEnvironment();
const environment = resolveHelmEnvironment();
ensureDatabaseParent(environment.databaseUrl, HELM_PROJECT_ROOT);
process.env.DATABASE_URL = environment.databaseUrl;
process.env.HOST = environment.host;

await ensureProductionBuild();
await import(pathToFileURL(join(HELM_PROJECT_ROOT, ".output/server/index.mjs")).href);
