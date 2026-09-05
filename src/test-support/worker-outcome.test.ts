import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

import { workerOutcome } from "./worker-outcome";

function startWorker(source: string) {
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    execArgv: [],
  });
}

it("waits for normal exit after a result while async module cleanup is pending", async () => {
  const worker = startWorker(`
    import { parentPort } from "node:worker_threads";
    await Promise.resolve();
    const released = new Promise(resolve => parentPort.once("message", resolve));
    parentPort.postMessage("done");
    await released;
    parentPort.close();
  `);
  const outcome = workerOutcome<string>(worker);
  let settled = false;
  void outcome.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  try {
    await once(worker, "message");
    await setImmediate();
    expect(settled).toBe(false);
    worker.postMessage("release", []);
    await expect(outcome).resolves.toBe("done");
    expect(worker.threadId).toBe(-1);
  } finally {
    worker.postMessage("release", []);
    await worker.terminate();
  }
});

it("does not hide a worker error after its result message", async () => {
  const worker = startWorker(`
    import { parentPort } from "node:worker_threads";
    await Promise.resolve();
    parentPort.postMessage("done");
    throw new Error("Cleanup failed");
  `);
  try {
    await expect(workerOutcome(worker)).rejects.toThrow("Cleanup failed");
  } finally {
    await worker.terminate();
  }
});

it("rejects a normal exit without a result instead of waiting indefinitely", async () => {
  const worker = startWorker("await Promise.resolve();");
  try {
    await expect(workerOutcome(worker)).rejects.toThrow("without posting a result");
  } finally {
    await worker.terminate();
  }
});

it("rejects a nonzero exit even when a result was posted", async () => {
  const worker = startWorker(`
    import { parentPort } from "node:worker_threads";
    parentPort.postMessage("done");
    process.exitCode = 2;
    parentPort.close();
  `);
  try {
    await expect(workerOutcome(worker)).rejects.toThrow("exited with code 2");
  } finally {
    await worker.terminate();
  }
});

it("bounds shutdown when a worker posts a result but retains a live handle", async () => {
  const worker = startWorker(`
    import { parentPort } from "node:worker_threads";
    setInterval(() => {}, 1000);
    parentPort.postMessage("done");
  `);
  try {
    await expect(workerOutcome(worker, 50)).rejects.toThrow("did not exit after posting");
  } finally {
    await worker.terminate();
  }
});
