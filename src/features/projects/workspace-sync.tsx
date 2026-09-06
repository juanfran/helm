import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { subscribeToProjectEvents } from "../activity/project-event-subscription";
import { getWorkspaceSyncState } from "./workspace-sync-state";
import { refreshProjectCustomization } from "./project-customization-query";
import type { ProjectConnectionStatus } from "./project-shell-context";

export function WorkspaceSync({
  projectId,
  reportConnection,
}: {
  projectId: string;
  reportConnection: (status: ProjectConnectionStatus) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  useEffect(() => {
    const data = getWorkspaceSyncState(queryClient, projectId);
    let stopped = false;
    let disconnect: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    function connect() {
      void data
        .captureCursor()
        .then((cursor) => {
          if (stopped) return;
          disconnect = subscribeToProjectEvents({
            projectId,
            afterCursor: cursor,
            onCursor: (next) => data.advanceCursor(next),
            onOpen: () => reportConnection("live"),
            onError: () => reportConnection("retrying"),
            onEvent: async (event) => {
              await data.coordinator.run(() => data.projectReady?.(event));
              if (event.changes.scopes.includes("projects")) {
                await refreshProjectCustomization(queryClient, projectId);
                await router.invalidate({ sync: true });
              }
              reportConnection("live");
            },
          });
        })
        .catch(() => {
          if (stopped) return;
          reportConnection("retrying");
          retry = setTimeout(connect, 1_000);
        });
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      disconnect?.();
    };
  }, [projectId, queryClient, router, reportConnection]);
  return null;
}
