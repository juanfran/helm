import { createRetryableLazyModuleLoader } from "../../components/retryable-lazy-module";
export const projectLandingModule = createRetryableLazyModuleLoader(() =>
  import("./project-landing").then(({ ProjectLanding }) => ({ default: ProjectLanding })),
);
