import type { ProjectEvent } from "../../domain/activity";
import { parseProjectEventWire } from "./project-event-wire";
import { sharedProjectEventSource } from "./shared-project-event-source";

export type EventSourceLike = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
};

export type ProjectEventSubscriptionOptions = {
  projectId: string | null;
  afterCursor: number;
  onEvent: (event: ProjectEvent) => void | Promise<void>;
  onCursor?: (cursor: number) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  createEventSource?: (url: string) => EventSourceLike;
};

type ActiveConnection = {
  source: EventSourceLike;
  generation: number;
  handleEvent: EventListener;
  handleOpen: EventListener;
  handleConnectionError: EventListener;
};

function asError(error: unknown) {
  return error instanceof Error ? error : new Error("Project event projection failed.");
}

export function projectEventStreamUrl(projectId: string | null, afterCursor: number) {
  const query = new URLSearchParams();
  if (projectId !== null) query.set("projectId", projectId);
  query.set("after", String(afterCursor));
  return `/api/events?${query.toString()}`;
}

export function subscribeToProjectEvents({
  projectId,
  afterCursor,
  onEvent,
  onCursor,
  onOpen,
  onError,
  createEventSource = sharedProjectEventSource,
}: ProjectEventSubscriptionOptions) {
  let appliedCursor = afterCursor;
  let stopped = false;
  let projection = Promise.resolve();
  let connectionGeneration = 0;
  let activeConnection: ActiveConnection | undefined;
  const queuedCursors = new Map<number, number>();

  const reportError = (error: Error) => {
    try {
      onError?.(error);
    } catch {
      // Error observers must not interrupt durable event recovery.
    }
  };

  const isActiveConnection = (generation: number, source: EventSourceLike) =>
    !stopped && activeConnection?.generation === generation && activeConnection.source === source;

  const disconnect = (connection: ActiveConnection) => {
    connection.source.removeEventListener("helm", connection.handleEvent);
    connection.source.removeEventListener("open", connection.handleOpen);
    connection.source.removeEventListener("error", connection.handleConnectionError);
    connection.source.close();
    if (activeConnection === connection) activeConnection = undefined;
  };

  const discardQueuedGeneration = (generation: number) => {
    for (const [cursor, queuedGeneration] of queuedCursors) {
      if (queuedGeneration === generation) queuedCursors.delete(cursor);
    }
  };

  const connect = () => {
    connectionGeneration += 1;
    const generation = connectionGeneration;
    const source = createEventSource(projectEventStreamUrl(projectId, appliedCursor));

    const handleEvent: EventListener = (rawEvent) => {
      if (!isActiveConnection(generation, source) || !(rawEvent instanceof MessageEvent)) return;
      let candidate: unknown;
      try {
        candidate = JSON.parse(String(rawEvent.data));
      } catch {
        reportError(new Error("Helm received a malformed project event."));
        return;
      }
      const event = parseProjectEventWire(candidate);
      if (!event) {
        reportError(new Error("Helm received an invalid project event."));
        return;
      }
      if (projectId !== null && event.projectId !== projectId) {
        reportError(new Error("Helm received a project event for the wrong project."));
        return;
      }
      if (event.cursor <= appliedCursor || queuedCursors.has(event.cursor)) return;

      queuedCursors.set(event.cursor, generation);
      projection = projection
        .then(async () => {
          if (!isActiveConnection(generation, source) || event.cursor <= appliedCursor) return;
          try {
            await onEvent(event);
          } catch (error) {
            if (!isActiveConnection(generation, source)) return;

            const failedConnection = activeConnection;
            if (!failedConnection) return;
            // The browser may already have advanced this EventSource's Last-Event-ID past the
            // failed projection. A new instance resets that hidden cursor so SQLite can replay
            // from the last event the application actually committed.
            disconnect(failedConnection);
            discardQueuedGeneration(generation);
            reportError(asError(error));

            if (stopped) return;
            try {
              connect();
            } catch (connectionError) {
              reportError(asError(connectionError));
            }
            return;
          }

          if (!isActiveConnection(generation, source)) return;
          appliedCursor = event.cursor;
          try {
            onCursor?.(appliedCursor);
          } catch (error) {
            reportError(asError(error));
          }
        })
        .finally(() => {
          if (queuedCursors.get(event.cursor) === generation) {
            queuedCursors.delete(event.cursor);
          }
        });
    };

    const handleConnectionError: EventListener = () => {
      if (isActiveConnection(generation, source)) {
        reportError(new Error("Helm's live event connection is retrying."));
      }
    };

    const handleOpen: EventListener = () => {
      if (isActiveConnection(generation, source)) onOpen?.();
    };

    activeConnection = {
      source,
      generation,
      handleEvent,
      handleOpen,
      handleConnectionError,
    };
    source.addEventListener("helm", handleEvent);
    source.addEventListener("open", handleOpen);
    source.addEventListener("error", handleConnectionError);
  };

  connect();

  return () => {
    if (stopped) return;
    stopped = true;
    queuedCursors.clear();
    const connection = activeConnection;
    if (connection) disconnect(connection);
  };
}
