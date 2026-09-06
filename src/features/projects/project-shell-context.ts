import { createContext, useContext, useEffect } from "react";

export type ProjectConnectionStatus = "connecting" | "live" | "retrying";

export const ProjectShellContext = createContext<{
  reportConnection: (status: ProjectConnectionStatus) => void;
} | null>(null);

export function useProjectShellConnection(status: ProjectConnectionStatus) {
  const shell = useContext(ProjectShellContext);
  useEffect(() => {
    // A page's initial state is not a new connection failure. Keep the last known
    // project status while its replacement subscription catches up from its cursor.
    if (status !== "connecting") shell?.reportConnection(status);
  }, [shell, status]);
  return shell !== null;
}
