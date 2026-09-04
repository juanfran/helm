import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import {
  createDatabaseBackup,
  exportProject,
  exportProjectMarkdown,
} from "../../application/portability";
import { canonicalHelmProjectExportJson } from "../../domain/portability";
import { createPortabilityDownloadRequestHandler } from "../../server/portability-download-handler";
import { portabilityServices } from "../../server/project-runtime.server";

function dateStamp(timestamp = new Date().toISOString()) {
  return timestamp.slice(0, 10);
}

const handlePortabilityDownload = createPortabilityDownloadRequestHandler(async (request) => {
  if (request.format === "sqlite") {
    return {
      body: await Effect.runPromise(createDatabaseBackup(portabilityServices, request.signal), {
        signal: request.signal,
      }),
      fileName: `helm-backup-${dateStamp()}.sqlite`,
      mediaType: "application/vnd.sqlite3",
    };
  }

  if (request.format === "json") {
    const artifact = await Effect.runPromise(
      exportProject({ projectId: request.projectId }, portabilityServices),
      { signal: request.signal },
    );
    return {
      body: `${canonicalHelmProjectExportJson(artifact)}\n`,
      fileName: `${artifact.project.name}-${dateStamp(artifact.exportedAt)}.helm.json`,
      mediaType: "application/vnd.helm.project+json; charset=utf-8",
    };
  }

  const document = await Effect.runPromise(
    exportProjectMarkdown(
      { projectId: request.projectId, savedViewId: request.savedViewId },
      portabilityServices,
    ),
    { signal: request.signal },
  );
  return {
    body: document.markdown,
    fileName: `${document.projectName}${document.viewName ? `-${document.viewName}` : ""}-${dateStamp()}.md`,
    mediaType: "text/markdown; charset=utf-8",
  };
});

export const Route = createFileRoute("/api/portability")({
  server: {
    handlers: {
      GET: ({ request }) => handlePortabilityDownload(request),
    },
  },
});
