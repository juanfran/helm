import { randomUUID } from "node:crypto";

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

export type PortabilityDownloadFormat = "sqlite" | "json" | "markdown";

export type PortabilityDownloadRequest = {
  readonly format: PortabilityDownloadFormat;
  readonly projectId: string | null;
  readonly savedViewId: string | null;
  readonly signal: AbortSignal;
};

export type PortabilityDownload = {
  readonly body: string | Uint8Array | ReadableStream<Uint8Array>;
  readonly fileName: string;
  readonly mediaType: string;
};

export interface PortabilityDownloadLoader {
  (request: PortabilityDownloadRequest): Promise<PortabilityDownload>;
}

type InvalidRequestField = "format" | "projectId" | "savedViewId" | "query";

type ParsedDownloadRequest =
  | {
      readonly ok: true;
      readonly value: Omit<PortabilityDownloadRequest, "signal">;
    }
  | {
      readonly ok: false;
      readonly field: InvalidRequestField;
      readonly message: string;
    };

const formats = new Set<PortabilityDownloadFormat>(["sqlite", "json", "markdown"]);
const queryParameters = ["format", "projectId", "savedViewId"] as const;

function isQueryParameter(value: string): value is (typeof queryParameters)[number] {
  return value === "format" || value === "projectId" || value === "savedViewId";
}

function isDownloadFormat(value: string): value is PortabilityDownloadFormat {
  return value === "sqlite" || value === "json" || value === "markdown";
}

function parseDownloadRequest(request: Request): ParsedDownloadRequest {
  const searchParams = new URL(request.url).searchParams;

  for (const parameter of queryParameters) {
    if (searchParams.getAll(parameter).length > 1) {
      return {
        ok: false,
        field: parameter,
        message: `Provide ${parameter} at most once.`,
      };
    }
  }

  const unknownParameters = [...new Set(searchParams.keys())]
    .filter((parameter) => !isQueryParameter(parameter))
    .toSorted();
  if (unknownParameters.length > 0) {
    return {
      ok: false,
      field: "query",
      message: `Unsupported query parameter: ${unknownParameters.join(", ")}.`,
    };
  }

  const formatValue = searchParams.get("format");
  if (formatValue === null || !isDownloadFormat(formatValue) || !formats.has(formatValue)) {
    return {
      ok: false,
      field: "format",
      message: "format must be one of sqlite, json, or markdown.",
    };
  }
  const format = formatValue;

  const parsedProjectId = parseOptionalIdentifier(searchParams.get("projectId"), "projectId");
  if (!parsedProjectId.ok) return parsedProjectId;

  const parsedSavedViewId = parseOptionalIdentifier(searchParams.get("savedViewId"), "savedViewId");
  if (!parsedSavedViewId.ok) return parsedSavedViewId;

  if ((format === "json" || format === "markdown") && parsedProjectId.value === null) {
    return {
      ok: false,
      field: "projectId",
      message: `projectId is required for ${format} downloads.`,
    };
  }

  if (format === "sqlite" && parsedProjectId.value !== null) {
    return {
      ok: false,
      field: "projectId",
      message: "projectId is not supported for whole-instance SQLite backups.",
    };
  }

  if (format !== "markdown" && parsedSavedViewId.value !== null) {
    return {
      ok: false,
      field: "savedViewId",
      message: "savedViewId is only supported for markdown downloads.",
    };
  }

  return {
    ok: true,
    value: {
      format,
      projectId: parsedProjectId.value,
      savedViewId: parsedSavedViewId.value,
    },
  };
}

function parseOptionalIdentifier(
  value: string | null,
  field: "projectId" | "savedViewId",
):
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly field: typeof field; readonly message: string } {
  if (value === null) return { ok: true, value: null };

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return { ok: false, field, message: `${field} must not be empty.` };
  }
  return { ok: true, value: trimmedValue };
}

function baseHeaders() {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function errorResponse(
  status: number,
  type: string,
  message: string,
  options: {
    readonly field?: InvalidRequestField;
    readonly allow?: string;
    readonly correlationId?: string;
  } = {},
) {
  const error = {
    type,
    ...(options.field === undefined ? {} : { field: options.field }),
    message,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
  };
  return Response.json(
    { ok: false, error },
    {
      status,
      headers: {
        ...baseHeaders(),
        ...(options.allow === undefined ? {} : { Allow: options.allow }),
      },
    },
  );
}

function portabilityErrorResponse(error: unknown) {
  if (error instanceof PortabilityNotFoundError) {
    const subject = error.entityType === "project" ? "project" : "saved view";
    return errorResponse(
      404,
      "PortabilityNotFoundError",
      `The requested ${subject} was not found.`,
    );
  }
  if (error instanceof InvalidPortabilityInputError) {
    return errorResponse(
      400,
      "InvalidPortabilityInputError",
      "The portability request is invalid.",
    );
  }
  if (error instanceof UnsupportedPortabilityVersionError) {
    return errorResponse(
      400,
      "UnsupportedPortabilityVersionError",
      "The portability data version is not supported.",
    );
  }
  if (error instanceof PortabilityAuthorizationError) {
    return errorResponse(
      403,
      "PortabilityAuthorizationError",
      "You are not authorized to perform this portability operation.",
    );
  }
  if (error instanceof PortabilityConflictError) {
    return errorResponse(
      409,
      "PortabilityConflictError",
      "The portability operation conflicts with current data.",
    );
  }
  if (error instanceof PortabilityPreviewStaleError) {
    return errorResponse(
      409,
      "PortabilityPreviewStaleError",
      "The portability preview is stale. Generate a new preview and try again.",
    );
  }
  if (error instanceof PortabilityIdempotencyConflictError) {
    return errorResponse(
      409,
      "PortabilityIdempotencyConflictError",
      "The idempotency key was already used for a different portability operation.",
    );
  }
  if (error instanceof PortabilityPersistenceError) {
    return errorResponse(
      500,
      "PortabilityPersistenceError",
      "Helm could not prepare the download.",
    );
  }
  const correlationId = randomUUID();
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[helm] portability download failure ${correlationId}: ${detail}\n`);
  return errorResponse(500, "UnexpectedPortabilityError", "Helm could not prepare the download.", {
    correlationId,
  });
}

function sanitizeUnicodeFileName(fileName: string) {
  let headerSafeFileName = "";
  for (const character of fileName.normalize("NFC")) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControlCharacter = codePoint <= 0x1f || codePoint === 0x7f;
    const isUnpairedSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
    headerSafeFileName +=
      isControlCharacter || isUnpairedSurrogate || character === "/" || character === "\\"
        ? "_"
        : character;
  }

  const normalized = headerSafeFileName
    .replace(/\.{2,}/g, ".")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  const bounded = Array.from(normalized).slice(0, 180).join("");
  return bounded.length > 0 ? bounded : "helm-download";
}

function sanitizeAsciiFileName(fileName: string) {
  const ascii = fileName
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[^A-Za-z0-9 ._()+-]/g, "_")
    .replace(/_+/g, "_")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 120);
  return ascii.length > 0 ? ascii : "helm-download";
}

function encodeExtendedFileName(fileName: string) {
  return encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function contentDisposition(fileName: string) {
  const unicodeFileName = sanitizeUnicodeFileName(fileName);
  const asciiFileName = sanitizeAsciiFileName(unicodeFileName);
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeExtendedFileName(unicodeFileName)}`;
}

function responseBody(
  body: string | Uint8Array | ReadableStream<Uint8Array>,
): string | ArrayBuffer | ReadableStream<Uint8Array> {
  if (typeof body === "string" || body instanceof ReadableStream) return body;

  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy.buffer;
}

export function createPortabilityDownloadRequestHandler(loader: PortabilityDownloadLoader) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") {
      return errorResponse(405, "MethodNotAllowed", "Portability downloads only support GET.", {
        allow: "GET",
      });
    }

    const parsed = parseDownloadRequest(request);
    if (!parsed.ok) {
      return errorResponse(400, "InvalidPortabilityDownloadRequest", parsed.message, {
        field: parsed.field,
      });
    }

    try {
      const download = await loader({ ...parsed.value, signal: request.signal });
      return new Response(responseBody(download.body), {
        headers: {
          ...baseHeaders(),
          "Content-Disposition": contentDisposition(download.fileName),
          "Content-Type": download.mediaType,
        },
      });
    } catch (error) {
      return portabilityErrorResponse(error);
    }
  };
}
