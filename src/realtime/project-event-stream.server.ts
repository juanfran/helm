import { z } from "zod";

const textEncoder = new TextEncoder();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const SSE_EVENT_NAME = "helm";

const streamProjectSchema = z.compile(z.string().trim().min(1).max(200).nullable());
const streamCursorSchema = z.compile(
  z.string().regex(/^(0|[1-9]\d*)$/, "Use a non-negative integer cursor."),
);

export type ProjectEventStreamItem = {
  readonly cursor: number;
  readonly projectId: string | null;
  readonly kind: string;
};

export type ProjectEventReadInput = {
  readonly projectId: string | null;
  readonly afterCursor: number;
  readonly limit: number;
};

export type ProjectEventReadPage<TEvent extends ProjectEventStreamItem> = {
  readonly events: readonly TEvent[];
  readonly hasMore?: boolean;
};

export interface ProjectEventReader<TEvent extends ProjectEventStreamItem> {
  readEvents(
    input: ProjectEventReadInput,
    options: { readonly signal: AbortSignal },
  ): Promise<ProjectEventReadPage<TEvent>>;
}

export type ProjectEventStreamOptions = {
  readonly pageSize?: number;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly retryIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
};

export type ProjectEventStreamRequest = {
  readonly projectId: string | null;
  readonly afterCursor: number;
};

export type EventStreamRequestError = {
  readonly type: "InvalidEventStreamRequest";
  readonly field: "after" | "last-event-id" | "projectId";
  readonly message: string;
};

type ParsedEventStreamRequest =
  | { readonly ok: true; readonly value: ProjectEventStreamRequest }
  | { readonly ok: false; readonly error: EventStreamRequestError };

function positiveIntegerOption(name: string, value: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function normalizeOptions(options: ProjectEventStreamOptions) {
  return {
    pageSize: positiveIntegerOption(
      "pageSize",
      options.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    ),
    pollIntervalMs: positiveIntegerOption(
      "pollIntervalMs",
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    ),
    heartbeatIntervalMs: positiveIntegerOption(
      "heartbeatIntervalMs",
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
    retryIntervalMs: positiveIntegerOption(
      "retryIntervalMs",
      options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
    ),
    now: options.now ?? Date.now,
  };
}

function encodeFrame(frame: string) {
  return textEncoder.encode(frame);
}

function assertEvent(event: ProjectEventStreamItem) {
  if (!Number.isSafeInteger(event.cursor) || event.cursor <= 0) {
    throw new TypeError("Project events must have a positive safe-integer cursor.");
  }
  if (!event.kind || /[\r\n\0]/.test(event.kind)) {
    throw new TypeError("Project event kinds must be non-empty single-line values.");
  }
}

function eventFrame(event: ProjectEventStreamItem) {
  assertEvent(event);
  return encodeFrame(
    `id: ${event.cursor}\nevent: ${SSE_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function uniqueAscendingEvents<TEvent extends ProjectEventStreamItem>(
  events: readonly TEvent[],
  afterCursor: number,
  pageSize: number,
  projectId: string | null,
) {
  if (events.length > pageSize) {
    throw new RangeError(`The event reader returned more than the requested ${pageSize} events.`);
  }
  const byCursor = new Map<number, TEvent>();
  for (const event of events) {
    assertEvent(event);
    if (projectId !== null && event.projectId !== projectId) {
      throw new Error("The event reader returned an event from a different project.");
    }
    if (event.cursor > afterCursor && !byCursor.has(event.cursor)) {
      byCursor.set(event.cursor, event);
    }
  }
  return [...byCursor.values()].toSorted((left, right) => left.cursor - right.cursor);
}

export function createProjectEventStream<TEvent extends ProjectEventStreamItem>(
  reader: ProjectEventReader<TEvent>,
  request: ProjectEventStreamRequest,
  options: ProjectEventStreamOptions = {},
) {
  if (!Number.isSafeInteger(request.afterCursor) || request.afterCursor < 0) {
    throw new RangeError("afterCursor must be a non-negative safe integer.");
  }

  const configuration = normalizeOptions(options);
  const lifecycle = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cursor = request.afterCursor;
  let heartbeatAt = configuration.now() + configuration.heartbeatIntervalMs;
  let retrySent = false;
  let stopped = false;
  let pendingEvents: TEvent[] = [];
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakePull: (() => void) | null = null;

  const wake = () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
    const settle = wakePull;
    settle?.();
  };

  const detachExternalAbort = () => options.signal?.removeEventListener("abort", externalAbort);

  const stop = (closeController: boolean) => {
    if (stopped) return;
    stopped = true;
    wake();
    detachExternalAbort();
    lifecycle.signal.removeEventListener("abort", lifecycleAbort);
    if (!lifecycle.signal.aborted) lifecycle.abort();
    if (closeController && controller) controller.close();
  };

  const lifecycleAbort = () => stop(true);
  const externalAbort = () => lifecycle.abort();

  const waitUntilNextRead = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      const settle = () => {
        if (wakePull !== settle) return;
        wakeTimer = null;
        wakePull = null;
        resolve();
      };
      wakePull = settle;
      wakeTimer = setTimeout(settle, milliseconds);
    });

  const nextPendingEventFrame = () => {
    const event = pendingEvents.shift();
    if (!event) return null;
    cursor = event.cursor;
    return eventFrame(event);
  };

  const readNextFrame = async (): Promise<Uint8Array | null> => {
    // Polls must remain sequential: each read advances the cursor used by the next read.
    // `stopped` is changed by abort/cancel callbacks while an iteration is suspended.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (!stopped) {
      // oxlint-disable-next-line no-await-in-loop
      const page = await reader.readEvents(
        {
          projectId: request.projectId,
          afterCursor: cursor,
          limit: configuration.pageSize,
        },
        { signal: lifecycle.signal },
      );
      if (stopped) return null;

      pendingEvents = uniqueAscendingEvents(
        page.events,
        cursor,
        configuration.pageSize,
        request.projectId,
      );
      const event = nextPendingEventFrame();
      if (event) return event;
      if (page.hasMore) {
        throw new Error(
          "The event reader reported more events without advancing the stream cursor.",
        );
      }

      const now = configuration.now();
      if (now >= heartbeatAt) {
        heartbeatAt = now + configuration.heartbeatIntervalMs;
        return encodeFrame(": heartbeat\n\n");
      }

      const waitFor = Math.min(configuration.pollIntervalMs, Math.max(1, heartbeatAt - now));
      // oxlint-disable-next-line no-await-in-loop
      await waitUntilNextRead(waitFor);
    }
    return null;
  };

  return new ReadableStream<Uint8Array>(
    {
      start(target) {
        controller = target;
        lifecycle.signal.addEventListener("abort", lifecycleAbort, { once: true });
        options.signal?.addEventListener("abort", externalAbort, { once: true });
        if (options.signal?.aborted) lifecycle.abort();
      },
      async pull(target) {
        if (stopped) return;
        try {
          if (!retrySent) {
            retrySent = true;
            target.enqueue(encodeFrame(`retry: ${configuration.retryIntervalMs}\n\n`));
            return;
          }
          const pending = nextPendingEventFrame();
          if (pending) {
            target.enqueue(pending);
            return;
          }

          const next = await readNextFrame();
          if (next && !stopped) target.enqueue(next);
        } catch (error) {
          if (stopped) return;
          stop(false);
          target.error(error);
        }
      },
      cancel() {
        stop(false);
      },
    },
    { highWaterMark: 0 },
  );
}

function invalidRequest(
  field: EventStreamRequestError["field"],
  message: string,
): { readonly ok: false; readonly error: EventStreamRequestError } {
  return { ok: false, error: { type: "InvalidEventStreamRequest", field, message } };
}

function parseCursor(
  value: string,
  field: "after" | "last-event-id",
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: EventStreamRequestError } {
  const parsed = streamCursorSchema.safeParse(value);
  const cursor = parsed.success ? Number(parsed.data) : Number.NaN;
  return parsed.success && Number.isSafeInteger(cursor)
    ? { ok: true, value: cursor }
    : invalidRequest(field, "Use a non-negative safe-integer event cursor.");
}

export function parseProjectEventStreamRequest(request: Request): ParsedEventStreamRequest {
  const url = new URL(request.url);
  const projectValues = url.searchParams.getAll("projectId");
  if (projectValues.length > 1) {
    return invalidRequest("projectId", "Provide projectId at most once.");
  }
  const afterValues = url.searchParams.getAll("after");
  if (afterValues.length > 1) {
    return invalidRequest("after", "Provide after at most once.");
  }

  const parsedProject = streamProjectSchema.safeParse(projectValues[0] ?? null);
  if (!parsedProject.success) {
    return invalidRequest(
      "projectId",
      parsedProject.error.issues[0]?.message ?? "Invalid projectId.",
    );
  }

  const queryCursor = afterValues[0] === undefined ? null : parseCursor(afterValues[0], "after");
  if (queryCursor && !queryCursor.ok) return queryCursor;
  const lastEventIdValue = request.headers.get("last-event-id");
  const lastEventCursor =
    lastEventIdValue === null ? null : parseCursor(lastEventIdValue.trim(), "last-event-id");
  if (lastEventCursor && !lastEventCursor.ok) return lastEventCursor;
  const afterCursor = Math.max(queryCursor?.value ?? 0, lastEventCursor?.value ?? 0);
  return {
    ok: true,
    value: { projectId: parsedProject.data, afterCursor },
  };
}

function errorResponse(error: EventStreamRequestError) {
  return Response.json(
    { ok: false, error },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export function createProjectEventsRequestHandler<TEvent extends ProjectEventStreamItem>(
  reader: ProjectEventReader<TEvent>,
  options: Omit<ProjectEventStreamOptions, "signal"> = {},
) {
  return (request: Request) => {
    if (request.method !== "GET") {
      return Response.json(
        {
          ok: false,
          error: { type: "MethodNotAllowed", message: "The event stream only supports GET." },
        },
        { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } },
      );
    }
    const parsed = parseProjectEventStreamRequest(request);
    if (!parsed.ok) return errorResponse(parsed.error);

    const body = createProjectEventStream(reader, parsed.value, {
      ...options,
      signal: request.signal,
    });
    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
