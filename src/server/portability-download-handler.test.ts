import { describe, expect, it, vi } from "vitest";

import {
  InvalidPortabilityInputError,
  PortabilityAuthorizationError,
  PortabilityConflictError,
  PortabilityIdempotencyConflictError,
  PortabilityNotFoundError,
  PortabilityPersistenceError,
  PortabilityPreviewStaleError,
  UnsupportedPortabilityVersionError,
} from "../application/portability-errors";
import {
  createPortabilityDownloadRequestHandler,
  type PortabilityDownloadLoader,
} from "./portability-download-handler";

describe("portability download HTTP contract", () => {
  it("returns byte-for-byte SQLite content with safe attachment headers", async () => {
    const body = Uint8Array.from([0, 1, 2, 255]);
    const loader = vi.fn<PortabilityDownloadLoader>().mockResolvedValue({
      body,
      fileName: 'Hélm "backup"/2026.sqlite',
      mediaType: "application/vnd.sqlite3",
    });
    const request = new Request("http://helm.local/api/portability/download?format=sqlite");

    const response = await createPortabilityDownloadRequestHandler(loader)(request);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(response.headers.get("content-type")).toBe("application/vnd.sqlite3");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Helm _backup_2026.sqlite\"; filename*=UTF-8''H%C3%A9lm%20%22backup%22_2026.sqlite",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(loader).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledWith({
      format: "sqlite",
      projectId: null,
      savedViewId: null,
      signal: request.signal,
    });
  });

  it("passes a streamed SQLite backup through without buffering it in the handler", async () => {
    const chunks = [Uint8Array.from([0, 1]), Uint8Array.from([2, 255])];
    let nextChunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[nextChunk++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const loader = vi.fn<PortabilityDownloadLoader>().mockResolvedValue({
      body,
      fileName: "helm.sqlite",
      mediaType: "application/vnd.sqlite3",
    });

    const response = await createPortabilityDownloadRequestHandler(loader)(
      new Request("http://helm.local/api/portability/download?format=sqlite"),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe(body);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0, 1, 2, 255]));
  });

  it("passes project and saved-view scope through and preserves serialized text", async () => {
    const loader = vi.fn<PortabilityDownloadLoader>().mockResolvedValue({
      body: "# Project\n\nExported exactly.\n",
      fileName: "project.md",
      mediaType: "text/markdown; charset=utf-8",
    });
    const request = new Request(
      "http://helm.local/api/portability/download?format=markdown&projectId=project-1&savedViewId=view-1",
    );

    const response = await createPortabilityDownloadRequestHandler(loader)(request);

    expect(await response.text()).toBe("# Project\n\nExported exactly.\n");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(loader).toHaveBeenCalledWith({
      format: "markdown",
      projectId: "project-1",
      savedViewId: "view-1",
      signal: request.signal,
    });
  });

  it.each([
    ["?format=sqlite&format=json", "format", "Provide format at most once."],
    ["?format=json&projectId=one&projectId=two", "projectId", "Provide projectId at most once."],
    [
      "?format=markdown&projectId=project-1&savedViewId=one&savedViewId=two",
      "savedViewId",
      "Provide savedViewId at most once.",
    ],
    ["?format=xml", "format", "format must be one of sqlite, json, or markdown."],
    ["?format=json", "projectId", "projectId is required for json downloads."],
    ["?format=markdown", "projectId", "projectId is required for markdown downloads."],
    [
      "?format=sqlite&projectId=project-1",
      "projectId",
      "projectId is not supported for whole-instance SQLite backups.",
    ],
    [
      "?format=json&projectId=project-1&savedViewId=view-1",
      "savedViewId",
      "savedViewId is only supported for markdown downloads.",
    ],
    [
      "?format=sqlite&savedViewId=view-1",
      "savedViewId",
      "savedViewId is only supported for markdown downloads.",
    ],
    ["?format=sqlite&projectId=%20", "projectId", "projectId must not be empty."],
    ["?format=sqlite&extra=true", "query", "Unsupported query parameter: extra."],
  ])(
    "returns a deterministic 400 without invoking the loader for %s",
    async (query, field, message) => {
      const loader = vi.fn<PortabilityDownloadLoader>();

      const response = await createPortabilityDownloadRequestHandler(loader)(
        new Request(`http://helm.local/api/portability/download${query}`),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe(
        JSON.stringify({
          ok: false,
          error: { type: "InvalidPortabilityDownloadRequest", field, message },
        }),
      );
      expect(loader).not.toHaveBeenCalled();
    },
  );

  it("rejects non-GET requests without invoking the loader", async () => {
    const loader = vi.fn<PortabilityDownloadLoader>();

    const response = await createPortabilityDownloadRequestHandler(loader)(
      new Request("http://helm.local/api/portability/download?format=sqlite", { method: "POST" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await response.text()).toBe(
      JSON.stringify({
        ok: false,
        error: {
          type: "MethodNotAllowed",
          message: "Portability downloads only support GET.",
        },
      }),
    );
    expect(loader).not.toHaveBeenCalled();
  });

  it.each([
    [
      new PortabilityNotFoundError({
        entityType: "project",
        entityId: "secret-project",
        message: "secret-project was not found by an internal lookup",
      }),
      404,
      "PortabilityNotFoundError",
      "The requested project was not found.",
    ],
    [
      new InvalidPortabilityInputError({
        message: "Raw parser internals",
        issues: ["private issue"],
      }),
      400,
      "InvalidPortabilityInputError",
      "The portability request is invalid.",
    ],
    [
      new UnsupportedPortabilityVersionError({
        receivedVersion: { private: true },
        message: "Raw version internals",
      }),
      400,
      "UnsupportedPortabilityVersionError",
      "The portability data version is not supported.",
    ],
    [
      new PortabilityAuthorizationError({ message: "Private authorization detail" }),
      403,
      "PortabilityAuthorizationError",
      "You are not authorized to perform this portability operation.",
    ],
    [
      new PortabilityConflictError({
        conflicts: [
          {
            code: "repository_conflict",
            entityType: "task",
            sourceId: "private-task",
            message: "Private conflict detail",
          },
        ],
        message: "Raw conflict internals",
      }),
      409,
      "PortabilityConflictError",
      "The portability operation conflicts with current data.",
    ],
    [
      new PortabilityPreviewStaleError({ message: "Private preview detail" }),
      409,
      "PortabilityPreviewStaleError",
      "The portability preview is stale. Generate a new preview and try again.",
    ],
    [
      new PortabilityIdempotencyConflictError({
        key: "private-key",
        message: "Private idempotency detail",
      }),
      409,
      "PortabilityIdempotencyConflictError",
      "The idempotency key was already used for a different portability operation.",
    ],
    [
      new PortabilityPersistenceError({
        correlationId: "private-correlation-id",
        message: "SQLITE_IOERR: /private/path",
      }),
      500,
      "PortabilityPersistenceError",
      "Helm could not prepare the download.",
    ],
  ])("maps %s to a safe HTTP error", async (error, status, type, message) => {
    const loader = vi.fn<PortabilityDownloadLoader>().mockRejectedValue(error);

    const response = await createPortabilityDownloadRequestHandler(loader)(
      new Request("http://helm.local/api/portability/download?format=sqlite"),
    );
    const serialized = await response.text();

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(serialized).toBe(JSON.stringify({ ok: false, error: { type, message } }));
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("SQLITE_IOERR");
  });

  it("does not expose unexpected loader errors", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const loader = vi
      .fn<PortabilityDownloadLoader>()
      .mockRejectedValue(new Error("SQLITE_CORRUPT: /private/helm.db"));

    const response = await createPortabilityDownloadRequestHandler(loader)(
      new Request("http://helm.local/api/portability/download?format=sqlite"),
    );

    expect(response.status).toBe(500);
    const serialized = await response.text();
    const body: unknown = JSON.parse(serialized);
    expect(body).toEqual({
      ok: false,
      error: {
        type: "UnexpectedPortabilityError",
        message: "Helm could not prepare the download.",
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
    const correlationId = /"correlationId":"([0-9a-f-]{36})"/.exec(serialized)?.[1];
    expect(correlationId).toBeDefined();
    expect(serialized).not.toContain("SQLITE_CORRUPT");
    expect(serialized).not.toContain("/private/helm.db");
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr.mock.calls.join("\n")).toContain(`portability download failure ${correlationId}`);
    expect(stderr.mock.calls.join("\n")).toContain("SQLITE_CORRUPT: /private/helm.db");
  });
});
