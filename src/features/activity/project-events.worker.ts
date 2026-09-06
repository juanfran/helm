/// <reference lib="webworker" />
import { createProjectEventHub } from "./project-event-hub";

declare const self: SharedWorkerGlobalScope;
const hub = createProjectEventHub((url) => new EventSource(url));

self.addEventListener("connect", (event) => {
  const port = event.ports[0];
  if (!port) return;
  let stop: (() => void) | undefined;
  port.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
    stop?.();
    stop = undefined;
    if (typeof data === "string")
      stop = hub.subscribe(data, (message) => port.postMessage(message));
    else if (data === null) port.close();
  });
  port.start();
});
