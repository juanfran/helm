type ProjectChangeResponse = { ok: true } | { ok: false; error: { type: string; message: string } };

export type ProjectChangeNavigation = {
  navigateToWorkspace(): Promise<unknown>;
  refreshRoutes(): Promise<unknown>;
};

export async function resetProjectNavigation(navigation: ProjectChangeNavigation) {
  await navigation.navigateToWorkspace();
  await navigation.refreshRoutes();
}

/**
 * Completes a project selection or create-and-select transition. Successful transitions always
 * leave project-specific URLs and then refresh loaders. A stale selection means another caller has
 * already changed the global selection, so it follows the same navigation reset before refreshing.
 */
export async function executeProjectChange<TResponse extends ProjectChangeResponse>(
  execute: () => Promise<TResponse>,
  navigation: ProjectChangeNavigation,
): Promise<TResponse> {
  const response = await execute();
  if (response.ok || response.error.type === "ActiveProjectVersionConflictError") {
    await resetProjectNavigation(navigation);
  }
  return response;
}
