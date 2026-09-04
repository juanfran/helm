import { buildProduction } from "./build-state.mjs";
import { loadHelmEnvironment } from "./environment.mjs";

loadHelmEnvironment();
await buildProduction();
