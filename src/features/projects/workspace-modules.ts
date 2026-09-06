import { createRetryableLazyModuleLoader } from "../../components/retryable-lazy-module";

export const workspaceModules = {
  taskDetail: createRetryableLazyModuleLoader(() =>
    import("../tasks/task-detail-panel").then(({ TaskDetailPanel }) => ({
      default: TaskDetailPanel,
    })),
  ),
  dashboard: createRetryableLazyModuleLoader(() =>
    import("../dashboard/operational-dashboard").then(({ OperationalDashboard }) => ({
      default: OperationalDashboard,
    })),
  ),
  activity: createRetryableLazyModuleLoader(() =>
    import("../activity/project-activity-feed").then(({ ProjectActivityFeed }) => ({
      default: ProjectActivityFeed,
    })),
  ),
  settings: createRetryableLazyModuleLoader(() =>
    import("./project-review-mode-control").then(({ ProjectReviewModeControl }) => ({
      default: ProjectReviewModeControl,
    })),
  ),
};
