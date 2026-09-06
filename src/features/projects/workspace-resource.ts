import type { ProjectSyncCoordinator } from "../activity/project-sync-coordinator";

/** A snapshot may load independently, but must catch up before joining live projections. */
export function createWorkspaceResource(
  snapshot: () => Promise<unknown>,
  coordinator: ProjectSyncCoordinator,
  isAvailable: () => boolean = () => true,
) {
  let pending: Promise<void> | undefined;
  let ready = false;
  let changedDuringLoad = false;
  let failure: unknown;
  return {
    get ready() {
      return ready && isAvailable();
    },
    ensure(): Promise<void> {
      if (pending && !failure && (!ready || isAvailable())) return pending;
      ready = false;
      failure = undefined;
      pending = snapshot()
        .then(() =>
          coordinator.run(async () => {
            // Events skipped while the snapshot was loading must not disappear in the gap.
            if (changedDuringLoad) await snapshot();
            changedDuringLoad = false;
            ready = true;
          }),
        )
        .catch((error: unknown) => {
          failure = error;
          throw error;
        });
      // Deferred snapshots have an error boundary, not an unhandled rejection.
      void pending.catch(() => undefined);
      return pending;
    },
    markChanged() {
      if (pending && !ready) changedDuringLoad = true;
    },
    read() {
      if (failure) throw failure;
      if (!ready || !isAvailable()) throw this.ensure();
    },
    retry() {
      if (!ready) {
        pending = undefined;
        failure = undefined;
      }
    },
  };
}
