export type ProjectSyncCoordinator = {
  run<T>(operation: () => Promise<T> | T): Promise<T>;
};

class SerialProjectSyncCoordinator implements ProjectSyncCoordinator {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T> | T) {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const coordinators = new WeakMap<object, Map<string, ProjectSyncCoordinator>>();

export function getProjectSyncCoordinator(owner: object, projectId: string) {
  let byProject = coordinators.get(owner);
  if (!byProject) {
    byProject = new Map();
    coordinators.set(owner, byProject);
  }
  let coordinator = byProject.get(projectId);
  if (!coordinator) {
    coordinator = new SerialProjectSyncCoordinator();
    byProject.set(projectId, coordinator);
  }
  return coordinator;
}

export async function waitForAllProjectSync(operations: readonly Promise<unknown>[]) {
  const results = await Promise.allSettled(operations);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Multiple project refreshes failed.");
}
