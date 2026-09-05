import type { Worker } from "node:worker_threads";

// A result message can arrive before top-level await and resource cleanup finish.
// Resolving only after exit avoids terminating a still-evaluating ES module (a V8
// crash on Node 22.13.0) and preserves errors raised after the result was posted.
export function workerOutcome<T>(worker: Worker, exitTimeoutMs = 10_000): Promise<T> {
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((settle, reject) => {
    let outcome: { value: T } | undefined;
    worker.once("message", (value: T) => {
      outcome = { value };
      exitTimer = setTimeout(() => {
        reject(new Error("Task-command worker did not exit after posting its result."));
      }, exitTimeoutMs);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Task-command worker exited with code ${code}.`));
      } else if (!outcome) {
        reject(new Error("Task-command worker exited without posting a result."));
      } else {
        settle(outcome.value);
      }
    });
  }).finally(() => clearTimeout(exitTimer));
}
