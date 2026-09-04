export function importantProjectEventQueryKey(projectId: string) {
  return ["important-project-events", projectId] as const;
}
