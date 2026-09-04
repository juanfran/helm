import { defineConfig } from "drizzle-kit";

import {
  databaseUrlFromEnvironment,
  ensureDatabaseParent,
  HELM_PROJECT_ROOT,
  loadHelmEnvironment,
} from "./scripts/environment.mjs";

loadHelmEnvironment();
const databaseUrl = databaseUrlFromEnvironment();
ensureDatabaseParent(databaseUrl, HELM_PROJECT_ROOT);

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: databaseUrl,
  },
});
