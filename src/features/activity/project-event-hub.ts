import type { EventSourceLike } from "./project-event-subscription";

export type EventDelivery = { type: "helm"; data: string } | { type: "open" | "error" };

/** Multiplex logical cursors over one physical stream; SQLite remains the replay buffer. */
export function createProjectEventHub(createSource: (url: string) => EventSourceLike) {
  const listeners = new Set<{
    projectId: string | null;
    cursor: number;
    emit: (message: EventDelivery) => void;
  }>();
  let source: EventSourceLike | undefined;
  let cursor = 0;
  let open = false;

  function connect() {
    source?.close();
    open = false;
    cursor = Math.min(...[...listeners].map((listener) => listener.cursor));
    const connection = createSource(`/api/events?after=${cursor}`);
    source = connection;
    for (const type of ["open", "error"] as const) {
      connection.addEventListener(type, () => {
        if (source !== connection) return;
        open = type === "open";
        for (const listener of listeners) listener.emit({ type });
      });
    }
    connection.addEventListener("helm", (raw) => {
      if (source !== connection || !(raw instanceof MessageEvent)) return;
      let event: unknown;
      try {
        event = JSON.parse(String(raw.data));
      } catch {
        return;
      }
      if (
        !event ||
        typeof event !== "object" ||
        !("cursor" in event) ||
        typeof event.cursor !== "number" ||
        !Number.isSafeInteger(event.cursor) ||
        !("projectId" in event) ||
        (event.projectId !== null && typeof event.projectId !== "string")
      )
        return;
      cursor = Math.max(cursor, event.cursor);
      // oxlint-disable-next-line unicorn/no-useless-spread -- A listener may synchronously unsubscribe or join during delivery.
      for (const listener of [...listeners]) {
        if (!listeners.has(listener) || event.cursor <= listener.cursor) continue;
        listener.cursor = event.cursor;
        if (listener.projectId === null || listener.projectId === event.projectId)
          listener.emit({ type: "helm", data: String(raw.data) });
      }
    });
  }

  return {
    subscribe(url: string, emit: (message: EventDelivery) => void) {
      const params = new URL(url, "http://helm.invalid").searchParams;
      const after = Number(params.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid replay cursor.");
      const listener = { projectId: params.get("projectId"), cursor: after, emit };
      listeners.add(listener);
      if (!source || after < cursor) connect();
      else if (open)
        queueMicrotask(() => {
          if (listeners.has(listener)) emit({ type: "open" });
        });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          source?.close();
          source = undefined;
          open = false;
        }
      };
    },
  };
}
