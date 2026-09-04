import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectEvent } from "../domain/activity";
import {
  createProjectEventsRequestHandler,
  createProjectEventStream,
  parseProjectEventStreamRequest,
  type ProjectEventReadInput,
  type ProjectEventReader,
} from "./project-event-stream.server";

type TestEvent = ProjectEvent;

const decoder = new TextDecoder();

function testEvent(cursor: number, projectId = "project-1"): TestEvent {
  return {
    id: String(cursor),
    cursor,
    projectId,
    kind: "task.progress.reported",
    importance: cursor % 2 === 0 ? "attention" : "routine",
    actor: { type: "agent", id: "run-1" },
    entity: { type: "task", id: `task-${cursor}` },
    payload: { message: `Progress ${cursor}` },
    changes: {
      projectIds: projectId ? [projectId] : [],
      taskIds: [`task-${cursor}`],
      activityEntryIds: [`entry-${cursor}`],
      agentRunIds: ["run-1"],
      scopes: ["tasks", "activity"],
    },
    occurredAt: `2026-09-04T10:00:${String(cursor).padStart(2, "0")}.000Z`,
  };
}

function mutableEventReader(initialEvents: readonly TestEvent[] = []) {
  const events = [...initialEvents];
  const calls: ProjectEventReadInput[] = [];
  const signals: AbortSignal[] = [];
  const reader: ProjectEventReader<TestEvent> = {
    async readEvents(input, options) {
      calls.push(input);
      signals.push(options.signal);
      const matching = events
        .filter(
          (event) =>
            event.cursor > input.afterCursor &&
            (input.projectId === null || event.projectId === input.projectId),
        )
        .toSorted((left, right) => left.cursor - right.cursor);
      return {
        events: matching.slice(0, input.limit),
        hasMore: matching.length > input.limit,
      };
    },
  };
  return { calls, events, reader, signals };
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  if (result.done) throw new Error("Expected another SSE frame.");
  return decoder.decode(result.value);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("project event SSE stream", () => {
  it("sorts and de-duplicates a bounded reader page before delivery", async () => {
    const calls: ProjectEventReadInput[] = [];
    const reader = createProjectEventStream<TestEvent>(
      {
        async readEvents(input) {
          calls.push(input);
          return { events: [testEvent(2), testEvent(1), testEvent(2)] };
        },
      },
      { projectId: "project-1", afterCursor: 0 },
      { pageSize: 3 },
    ).getReader();

    await readFrame(reader);
    expect(await readFrame(reader)).toContain("id: 1\n");
    expect(await readFrame(reader)).toContain("id: 2\n");
    expect(calls).toEqual([{ projectId: "project-1", afterCursor: 0, limit: 3 }]);
    await reader.cancel();
  });

  it("frames bounded durable replay in strict cursor order and preserves event hints", async () => {
    const source = mutableEventReader([testEvent(2), testEvent(1), testEvent(3, "project-2")]);
    const stream = createProjectEventStream(
      source.reader,
      { projectId: "project-1", afterCursor: 0 },
      { pageSize: 2, retryIntervalMs: 1_500 },
    );
    const reader = stream.getReader();

    expect(await readFrame(reader)).toBe("retry: 1500\n\n");
    const first = await readFrame(reader);
    const second = await readFrame(reader);

    expect(first).toBe(`id: 1\nevent: helm\ndata: ${JSON.stringify(testEvent(1))}\n\n`);
    expect(second).toBe(`id: 2\nevent: helm\ndata: ${JSON.stringify(testEvent(2))}\n\n`);
    expect(source.calls).toEqual([{ projectId: "project-1", afterCursor: 0, limit: 2 }]);
    await reader.cancel();
  });

  it("continues from replay into newly committed events without gaps or duplicates", async () => {
    vi.useFakeTimers();
    const source = mutableEventReader([testEvent(1)]);
    const reader = createProjectEventStream(
      source.reader,
      { projectId: "project-1", afterCursor: 0 },
      { pollIntervalMs: 10, heartbeatIntervalMs: 100 },
    ).getReader();

    await readFrame(reader);
    expect(await readFrame(reader)).toContain("id: 1\n");

    const liveFrame = readFrame(reader);
    await Promise.resolve();
    expect(source.calls.at(-1)?.afterCursor).toBe(1);
    source.events.push(testEvent(2));
    await vi.advanceTimersByTimeAsync(10);

    expect(await liveFrame).toContain("id: 2\n");
    expect(source.calls.at(-1)).toEqual({ projectId: "project-1", afterCursor: 1, limit: 50 });
    await reader.cancel();
  });

  it("does not fetch or buffer another page while a consumer is slow", async () => {
    vi.useFakeTimers();
    const source = mutableEventReader([
      testEvent(1),
      testEvent(2),
      testEvent(3),
      testEvent(4),
      testEvent(5),
    ]);
    const reader = createProjectEventStream(
      source.reader,
      { projectId: null, afterCursor: 0 },
      { pageSize: 2, pollIntervalMs: 10 },
    ).getReader();

    await readFrame(reader);
    expect(await readFrame(reader)).toContain("id: 1\n");
    expect(source.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.calls).toHaveLength(1);

    expect(await readFrame(reader)).toContain("id: 2\n");
    expect(source.calls).toHaveLength(1);
    expect(await readFrame(reader)).toContain("id: 3\n");
    expect(source.calls).toEqual([
      { projectId: null, afterCursor: 0, limit: 2 },
      { projectId: null, afterCursor: 2, limit: 2 },
    ]);
    await reader.cancel();
  });

  it("emits heartbeat comments while idle and closes promptly on abort", async () => {
    vi.useFakeTimers();
    const source = mutableEventReader();
    const abort = new AbortController();
    const reader = createProjectEventStream(
      source.reader,
      { projectId: "project-1", afterCursor: 4 },
      {
        pollIntervalMs: 10,
        heartbeatIntervalMs: 30,
        signal: abort.signal,
      },
    ).getReader();

    await readFrame(reader);
    const heartbeat = readFrame(reader);
    await vi.advanceTimersByTimeAsync(30);
    expect(await heartbeat).toBe(": heartbeat\n\n");

    const pending = reader.read();
    await Promise.resolve();
    const callsAtAbort = source.calls.length;
    abort.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(source.signals.every((signal) => signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.calls).toHaveLength(callsAtAbort);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interrupts an in-flight event read when its request is aborted", async () => {
    const abort = new AbortController();
    let readStarted = false;
    let readInterrupted = false;
    const reader = createProjectEventStream<TestEvent>(
      {
        readEvents(_input, options) {
          readStarted = true;
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => {
                readInterrupted = true;
                reject(options.signal.reason);
              },
              { once: true },
            );
          });
        },
      },
      { projectId: "project-1", afterCursor: 0 },
      { signal: abort.signal },
    ).getReader();

    await readFrame(reader);
    const pending = reader.read();
    await vi.waitFor(() => expect(readStarted).toBe(true));
    abort.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(readInterrupted).toBe(true);
  });
});

describe("project event stream HTTP contract", () => {
  it("uses the greatest query or Last-Event-ID cursor and replays only later events", async () => {
    const source = mutableEventReader([testEvent(1), testEvent(2), testEvent(3), testEvent(4)]);
    const handler = createProjectEventsRequestHandler(source.reader, { retryIntervalMs: 2_000 });
    const response = handler(
      new Request("http://helm.local/api/events?projectId=project-1&after=2", {
        headers: { "Last-Event-ID": "3" },
      }),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body.");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await readFrame(reader)).toBe("retry: 2000\n\n");
    expect(await readFrame(reader)).toContain("id: 4\n");
    expect(source.calls[0]).toMatchObject({ projectId: "project-1", afterCursor: 3 });
    await reader.cancel();
  });

  it("resumes from Last-Event-ID when the query cursor is absent", () => {
    const parsed = parseProjectEventStreamRequest(
      new Request("http://helm.local/api/events?projectId=project-1", {
        headers: { "Last-Event-ID": "41" },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: { projectId: "project-1", afterCursor: 41 },
    });
  });

  it("rejects unsupported methods without opening the reader", async () => {
    const source = mutableEventReader();
    const response = createProjectEventsRequestHandler(source.reader)(
      new Request("http://helm.local/api/events", { method: "POST" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { type: "MethodNotAllowed" },
    });
    expect(source.calls).toHaveLength(0);
  });

  it.each([
    ["http://helm.local/api/events?after=-1", {}, "after"],
    ["http://helm.local/api/events?after=1.5", {}, "after"],
    ["http://helm.local/api/events?after=9007199254740992", {}, "after"],
    ["http://helm.local/api/events", { "Last-Event-ID": "event-3" }, "last-event-id"],
    ["http://helm.local/api/events?projectId=", {}, "projectId"],
    ["http://helm.local/api/events?projectId=one&projectId=two", {}, "projectId"],
    ["http://helm.local/api/events?after=1&after=2", {}, "after"],
  ])("returns a typed 400 response for invalid input", async (url, headers, field) => {
    const source = mutableEventReader();
    const response = createProjectEventsRequestHandler(source.reader)(
      new Request(url, { headers }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { type: "InvalidEventStreamRequest", field },
    });
    expect(source.calls).toHaveLength(0);
  });
});
