import { Effect } from "effect";

import { reconcileActiveAgentRuns } from "../application/agents";
import { reconcileTaskLeases, systemTaskClock } from "../application/tasks";
import { createSqliteAgentStore } from "../infrastructure/sqlite-agent-store.server";
import { createSqliteProjectStore } from "../infrastructure/sqlite-project-store.server";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";

function createProjectRuntime() {
  const projectStore = createSqliteProjectStore();
  const projectServices = {
    inspector: localRepositoryInspector,
    store: projectStore,
  };
  const taskServices = {
    store: createSqliteTaskStore(projectStore.database),
    clock: systemTaskClock,
  };
  const agentServices = { store: createSqliteAgentStore(projectStore.database) };

  Effect.runSync(reconcileActiveAgentRuns(agentServices));
  Effect.runSync(reconcileTaskLeases(taskServices));

  const leaseReconciliationTimer = setInterval(() => {
    void Effect.runPromise(reconcileTaskLeases(taskServices)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown error";
      process.stderr.write(`[helm] lease reconciliation failed: ${message}\n`);
    });
  }, 5_000);
  leaseReconciliationTimer.unref();

  return { agentServices, leaseReconciliationTimer, projectServices, projectStore, taskServices };
}

type ProjectRuntime = ReturnType<typeof createProjectRuntime>;
const projectRuntimeKey = Symbol.for("helm.project-runtime");
const legacyLeaseReconciliationTimerKey = Symbol.for("helm.lease-reconciliation-timer");
const runtimeGlobal = globalThis as typeof globalThis & {
  [projectRuntimeKey]?: ProjectRuntime;
  [legacyLeaseReconciliationTimerKey]?: ReturnType<typeof setInterval>;
};

if (runtimeGlobal[legacyLeaseReconciliationTimerKey]) {
  clearInterval(runtimeGlobal[legacyLeaseReconciliationTimerKey]);
  delete runtimeGlobal[legacyLeaseReconciliationTimerKey];
}

const runtime = (runtimeGlobal[projectRuntimeKey] ??= createProjectRuntime());

export const { agentServices, projectServices, taskServices } = runtime;
