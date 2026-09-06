import type { EventDelivery } from "./project-event-hub";
import type { EventSourceLike } from "./project-event-subscription";

/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort.postMessage has no targetOrigin argument. */

let fallback:
  | Promise<ReturnType<typeof import("./project-event-hub").createProjectEventHub>>
  | undefined;

/** SharedWorker keeps all Helm tabs below the browser's per-origin HTTP connection limit. */
export function sharedProjectEventSource(url: string): EventSourceLike {
  const target = new EventTarget();
  let closed = false;
  let generation = 0;
  let stop: (() => void) | undefined;
  let worker: SharedWorker | undefined;
  const emit = (message: EventDelivery) => {
    if (!closed)
      target.dispatchEvent(
        message.type === "helm"
          ? new MessageEvent("helm", { data: message.data })
          : new Event(message.type),
      );
  };
  function useFallback() {
    if (closed) return;
    const request = ++generation;
    stop?.();
    stop = undefined;
    worker?.port.postMessage(null);
    worker?.port.close();
    worker = undefined;
    fallback ??= import("./project-event-hub").then(({ createProjectEventHub }) =>
      createProjectEventHub((address) => new EventSource(address)),
    );
    void fallback
      .then((hub) => {
        if (!closed && request === generation) stop = hub.subscribe(url, emit);
      })
      .catch(() => emit({ type: "error" }));
  }
  try {
    worker = new SharedWorker(new URL("./project-events.worker.ts", import.meta.url), {
      type: "module",
      name: "helm-project-events",
    });
    worker.port.addEventListener("message", ({ data }: MessageEvent<EventDelivery>) => emit(data));
    worker.port.start();
    worker.addEventListener("error", useFallback, { once: true });
    worker.port.postMessage(url);
  } catch {
    useFallback();
  }

  const pause = () => {
    generation += 1;
    worker?.port.postMessage(false);
    stop?.();
    stop = undefined;
  };
  const resume = () => {
    if (worker) worker.port.postMessage(url);
    else useFallback();
  };
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", resume);
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    close() {
      closed = true;
      generation += 1;
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", resume);
      worker?.port.postMessage(null);
      worker?.port.close();
      stop?.();
    },
  };
}
