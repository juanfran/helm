import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as stylex from "@stylexjs/stylex";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FileJson,
  FileText,
  Upload,
} from "lucide-react";

import { Button } from "../../components/ui/button";
import {
  HELM_PROJECT_EXPORT_LIMITS,
  type ExecuteProjectImportInput,
  type PreviewProjectImportInput,
  type ProjectImportChange,
  type ProjectImportConflict,
  type ProjectImportExecutionResult,
  type ProjectImportPreview,
  type ProjectImportUnsupported,
} from "../../domain/portability";
import { PORTABLE_CSV_LIMITS } from "../../domain/portable-csv";
import type {
  ProjectImportExecutionResponse,
  ProjectImportPreviewResponse,
} from "../../server/portability-adapter";
import { tokens } from "../../styles/tokens.stylex";

type ImportSource = PreviewProjectImportInput["source"];
type ImportTarget = "current" | "new";
type PendingAction = "read" | "preview" | "execute" | null;
type ImportNotice = { readonly message: string; readonly details: readonly string[] };
type SavedViewOption = { readonly id: string; readonly name: string };
const noSavedViews: readonly SavedViewOption[] = [];
const previewDetailLimit = 100;
const importFileSizeLimits = {
  csv: { bytes: PORTABLE_CSV_LIMITS.maxBytes, label: "2 MiB" },
  json: { bytes: HELM_PROJECT_EXPORT_LIMITS.maxBytes, label: "64 MiB" },
} satisfies Record<ImportSource["format"], { readonly bytes: number; readonly label: string }>;

export type ProjectDataManagementControlProps = {
  project: { readonly id: string; readonly name: string } | null;
  savedViews?: readonly SavedViewOption[];
  onPreview: (input: PreviewProjectImportInput) => Promise<ProjectImportPreviewResponse>;
  onExecute: (input: ExecuteProjectImportInput) => Promise<ProjectImportExecutionResponse>;
  onComplete?: (result: ProjectImportExecutionResult) => Promise<void> | void;
};

function downloadHref(
  format: "sqlite" | "json" | "markdown",
  projectId?: string,
  savedViewId?: string,
) {
  const query = new URLSearchParams({ format });
  if (projectId) query.set("projectId", projectId);
  if (savedViewId) query.set("savedViewId", savedViewId);
  return `/api/portability?${query.toString()}`;
}

function sourceFormat(file: File): ImportSource["format"] | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json") || file.type === "application/json") return "json";
  if (name.endsWith(".csv") || file.type === "text/csv") return "csv";
  return null;
}

function isImportTarget(value: string): value is ImportTarget {
  return value === "current" || value === "new";
}

function noticeFromResponseError(
  error: Extract<
    ProjectImportPreviewResponse | ProjectImportExecutionResponse,
    { ok: false }
  >["error"],
): ImportNotice {
  return {
    message: error.message,
    details: [
      ...new Set([
        ...(error.issues ?? []),
        ...(error.conflicts?.map((conflict) => conflict.message) ?? []),
      ]),
    ],
  };
}

function requiresFreshPreview(
  error: Extract<ProjectImportExecutionResponse, { ok: false }>["error"],
) {
  return (
    error.type === "PortabilityPreviewStaleError" ||
    error.type === "PortabilityIdempotencyConflictError" ||
    error.type === "PortabilityConflictError"
  );
}

function itemCount(preview: ProjectImportPreview) {
  return preview.creates.length + preview.updates.length;
}

function responseFileName(response: Response, fallback: string) {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (extended) {
    try {
      return decodeURIComponent(extended);
    } catch {
      // Fall through to the bounded local fallback.
    }
  }
  const ascii = /filename="([^"]+)"/i.exec(disposition)?.[1];
  return ascii || fallback;
}

async function responseErrorMessage(response: Response) {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const error = Reflect.get(body, "error");
    if (typeof error !== "object" || error === null) return null;
    const message = Reflect.get(error, "message");
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

export function ProjectDataManagementControl({
  project,
  savedViews = noSavedViews,
  onPreview,
  onExecute,
  onComplete,
}: ProjectDataManagementControlProps) {
  const instanceId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const readSequence = useRef(0);
  const requestSequence = useRef(0);
  const downloadInFlight = useRef(false);
  const [source, setSource] = useState<ImportSource | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [target, setTarget] = useState<ImportTarget>(project ? "current" : "new");
  const [repositoryRoot, setRepositoryRoot] = useState("");
  const [reason, setReason] = useState("");
  const [markdownSavedViewId, setMarkdownSavedViewId] = useState("");
  const [preview, setPreview] = useState<ProjectImportPreview | null>(null);
  const [previewInput, setPreviewInput] = useState<PreviewProjectImportInput | null>(null);
  const [executionIdempotencyKey, setExecutionIdempotencyKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [pendingDownload, setPendingDownload] = useState<string | null>(null);
  const [error, setError] = useState<ImportNotice | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (preview) previewHeadingRef.current?.focus();
  }, [preview]);

  function invalidatePreview() {
    requestSequence.current += 1;
    if (preview) setAnnouncement("Import details changed. Preview the file again.");
    setPreview(null);
    setPreviewInput(null);
    setExecutionIdempotencyKey(null);
    setError(null);
  }

  function changeTarget(nextTarget: ImportTarget) {
    setTarget(nextTarget);
    invalidatePreview();
  }

  async function readImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const sequence = ++readSequence.current;
    invalidatePreview();
    setSource(null);
    setFileName(null);
    setAnnouncement("");
    if (!file) return;

    const format = sourceFormat(file);
    if (!format) {
      setError({
        message: "Choose a JSON project export or a CSV task file.",
        details: ["Supported file extensions are .json and .csv."],
      });
      event.target.value = "";
      return;
    }
    if (file.size === 0) {
      setError({ message: `${file.name} is empty.`, details: [] });
      event.target.value = "";
      return;
    }
    const sizeLimit = importFileSizeLimits[format];
    if (file.size > sizeLimit.bytes) {
      setError({
        message: `${file.name} is too large for a ${format.toUpperCase()} import.`,
        details: [`${format.toUpperCase()} imports may be at most ${sizeLimit.label}.`],
      });
      event.target.value = "";
      return;
    }

    setPending("read");
    setAnnouncement(`Reading ${file.name}…`);
    try {
      const content = await file.text();
      if (sequence !== readSequence.current) return;
      if (content.trim().length === 0) {
        setError({ message: `${file.name} contains no import data.`, details: [] });
        event.target.value = "";
        return;
      }
      setSource({ format, content });
      setFileName(file.name);
      if (format === "csv" && project) setTarget("current");
      setAnnouncement(`${file.name} is ready to preview.`);
    } catch {
      if (sequence !== readSequence.current) return;
      setError({
        message: `Helm could not read ${file.name}.`,
        details: ["Choose the file again or check its local permissions."],
      });
      event.target.value = "";
    } finally {
      if (sequence === readSequence.current) setPending(null);
    }
  }

  function buildPreviewInput(): PreviewProjectImportInput | null {
    if (!source) return null;
    const targetProjectId = target === "current" && project ? project.id : null;
    return {
      source,
      targetProjectId,
      ...(targetProjectId === null ? { repositoryRoot: repositoryRoot.trim() } : {}),
      reason: reason.trim(),
    };
  }

  async function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = buildPreviewInput();
    if (!input) return;
    if (source?.format === "csv" && !project) {
      setError({
        message: "CSV imports need an existing project.",
        details: ["Create a project or restore a complete JSON export first."],
      });
      return;
    }

    const sequence = ++requestSequence.current;
    setPending("preview");
    setError(null);
    setAnnouncement("");
    try {
      const response = await onPreview(input);
      if (sequence !== requestSequence.current) return;
      if (!response.ok) {
        setPreview(null);
        setPreviewInput(null);
        setExecutionIdempotencyKey(null);
        setError(noticeFromResponseError(response.error));
        return;
      }
      setPreview(response.preview);
      setPreviewInput(input);
      setExecutionIdempotencyKey(crypto.randomUUID());
      setAnnouncement(
        response.preview.executable
          ? `Preview ready. ${itemCount(response.preview)} change${itemCount(response.preview) === 1 ? "" : "s"} can be imported.`
          : "Preview ready. Resolve the listed conflicts or unsupported data before importing.",
      );
    } catch {
      if (sequence !== requestSequence.current) return;
      setError({
        message: "Helm could not preview this import.",
        details: ["The file was not changed. Check that the local server is running and retry."],
      });
    } finally {
      if (sequence === requestSequence.current) setPending(null);
    }
  }

  async function executePreview() {
    if (!preview?.executable || !previewInput || !executionIdempotencyKey) return;
    const sequence = ++requestSequence.current;
    setPending("execute");
    setError(null);
    setAnnouncement("");
    try {
      const response = await onExecute({
        ...previewInput,
        previewToken: preview.previewToken,
        idempotencyKey: executionIdempotencyKey,
      });
      if (sequence !== requestSequence.current) return;
      if (!response.ok) {
        setError(noticeFromResponseError(response.error));
        if (requiresFreshPreview(response.error)) {
          setPreview(null);
          setPreviewInput(null);
          setExecutionIdempotencyKey(null);
        }
        return;
      }
      if (!response.result.executed) {
        setError({
          message: "The import was not executed.",
          details: [
            ...response.result.conflicts.map((conflict) => conflict.message),
            ...response.result.unsupported.map((item) => item.message),
          ],
        });
        return;
      }

      const changed = response.result.creates.length + response.result.updates.length;
      setPreview(null);
      setPreviewInput(null);
      setExecutionIdempotencyKey(null);
      setSource(null);
      setFileName(null);
      setReason("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setAnnouncement(
        `Import complete. ${changed} record${changed === 1 ? "" : "s"} changed and ${response.result.noOps.length} remained unchanged.`,
      );
      try {
        await onComplete?.(response.result);
      } catch {
        setError({
          message: "The import completed, but the workspace could not refresh automatically.",
          details: ["Reload the page to see the imported data."],
        });
      }
    } catch {
      if (sequence !== requestSequence.current) return;
      setError({
        message: "Helm could not confirm whether the import completed.",
        details: ["Retry to safely use the same import request."],
      });
    } finally {
      if (sequence === requestSequence.current) setPending(null);
    }
  }

  async function downloadData(
    event: ReactMouseEvent<HTMLAnchorElement>,
    href: string,
    title: string,
    fallbackFileName: string,
  ) {
    event.preventDefault();
    if (downloadInFlight.current) return;
    downloadInFlight.current = true;
    setPendingDownload(href);
    setError(null);
    setAnnouncement(`Preparing ${title}…`);
    try {
      const response = await fetch(href);
      if (!response.ok) {
        throw new Error(
          (await responseErrorMessage(response)) ?? `Helm could not prepare ${title}.`,
        );
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = responseFileName(response, fallbackFileName);
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      setAnnouncement(`${title} is ready.`);
    } catch (downloadError) {
      setAnnouncement("");
      setError({
        message:
          downloadError instanceof Error
            ? downloadError.message
            : `Helm could not prepare ${title}.`,
        details: ["No download was saved. Check the local server and try again."],
      });
    } finally {
      downloadInFlight.current = false;
      setPendingDownload(null);
    }
  }

  const importingAsNewProject = source?.format === "json" && target === "new";
  const destinationUnavailable = source?.format === "csv" && !project;
  const canPreview =
    source !== null &&
    reason.trim().length > 0 &&
    !destinationUnavailable &&
    (!importingAsNewProject || repositoryRoot.trim().length > 0);
  const markdownView = savedViews.find(({ id }) => id === markdownSavedViewId) ?? null;

  return (
    <section aria-label="Project data" {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.header)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Data portability</p>
          <h2 {...stylex.props(styles.title)}>Back up, export, or import</h2>
        </div>
        <Database size={22} aria-hidden="true" {...stylex.props(styles.headerIcon)} />
      </header>
      <p {...stylex.props(styles.description)}>
        SQLite preserves this Helm instance exactly. JSON moves a complete project, while Markdown
        creates a readable snapshot. Imports always require a preview before they write.
      </p>

      <div aria-label="Data downloads" {...stylex.props(styles.downloadGrid)}>
        <DownloadLink
          href={downloadHref("sqlite")}
          title="SQLite backup"
          detail="Exact database and event cursors"
          icon={<Database size={17} aria-hidden="true" />}
          pending={false}
          disabled={pendingDownload !== null}
        />
        {project ? (
          <>
            <DownloadLink
              href={downloadHref("json", project.id)}
              title="JSON export"
              detail={`Complete portable data for ${project.name}`}
              icon={<FileJson size={17} aria-hidden="true" />}
              pending={pendingDownload === downloadHref("json", project.id)}
              disabled={pendingDownload !== null}
              onDownload={downloadData}
              fallbackFileName="helm-project.json"
            />
            <div {...stylex.props(styles.downloadChoice)}>
              <DownloadLink
                href={downloadHref("markdown", project.id, markdownView?.id)}
                title="Markdown export"
                detail={
                  markdownView
                    ? `Readable current state and history in ${markdownView.name}`
                    : `Readable current state and history for ${project.name}`
                }
                icon={<FileText size={17} aria-hidden="true" />}
                pending={pendingDownload === downloadHref("markdown", project.id, markdownView?.id)}
                disabled={pendingDownload !== null}
                onDownload={downloadData}
                fallbackFileName="helm-project.md"
              />
              {savedViews.length > 0 ? (
                <label {...stylex.props(styles.scopeLabel)}>
                  Markdown scope
                  <select
                    value={markdownView?.id ?? ""}
                    onChange={(event) => setMarkdownSavedViewId(event.target.value)}
                    {...stylex.props(styles.scopeSelect)}
                  >
                    <option value="">Entire project</option>
                    {savedViews.map((view) => (
                      <option key={view.id} value={view.id}>
                        Saved view: {view.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      <div {...stylex.props(styles.divider)} />

      <form
        aria-label="Preview project import"
        aria-busy={pending !== null}
        onSubmit={requestPreview}
        {...stylex.props(styles.form)}
      >
        <div {...stylex.props(styles.importHeading)}>
          <Upload size={18} aria-hidden="true" />
          <div>
            <h3 {...stylex.props(styles.sectionTitle)}>Import data</h3>
            <p {...stylex.props(styles.hint)}>
              JSON restores a project; CSV creates or updates tasks.
            </p>
          </div>
        </div>

        <fieldset disabled={pending !== null} {...stylex.props(styles.fieldset)}>
          <label htmlFor={`${instanceId}-import-file`} {...stylex.props(styles.label)}>
            JSON or CSV file
          </label>
          <input
            ref={fileInputRef}
            id={`${instanceId}-import-file`}
            type="file"
            accept=".json,.csv,application/json,text/csv"
            aria-describedby={`${instanceId}-file-help`}
            onChange={(event) => void readImportFile(event)}
            {...stylex.props(styles.fileInput)}
          />
          <p id={`${instanceId}-file-help`} {...stylex.props(styles.hint)}>
            {fileName
              ? `${fileName} selected.`
              : "Maximum size: 64 MiB for JSON and 2 MiB for CSV. Helm validates the selected file on preview."}
          </p>

          {source?.format === "json" && project ? (
            <>
              <label htmlFor={`${instanceId}-target`} {...stylex.props(styles.label)}>
                Import destination
              </label>
              <select
                id={`${instanceId}-target`}
                value={target}
                onChange={(event) => {
                  if (isImportTarget(event.target.value)) changeTarget(event.target.value);
                }}
                {...stylex.props(styles.input)}
              >
                <option value="current">Merge into matching {project.name}</option>
                <option value="new">Create a new project</option>
              </select>
              {target === "current" ? (
                <p {...stylex.props(styles.hint)}>
                  The export must have this project&apos;s identity and repository root. Existing
                  records merge only at their expected version; stale, immutable, or historical
                  differences are reported as conflicts.
                </p>
              ) : null}
            </>
          ) : source?.format === "csv" ? (
            <p {...stylex.props(styles.destination, destinationUnavailable && styles.warning)}>
              {project
                ? `CSV tasks will update ${project.name}.`
                : "CSV needs an existing project. Restore JSON or create a project first."}
            </p>
          ) : source?.format === "json" ? (
            <p {...stylex.props(styles.destination)}>JSON will create a new project.</p>
          ) : null}

          {importingAsNewProject ? (
            <>
              <label htmlFor={`${instanceId}-repository-root`} {...stylex.props(styles.label)}>
                Repository root for the imported project
              </label>
              <input
                id={`${instanceId}-repository-root`}
                value={repositoryRoot}
                onChange={(event) => {
                  setRepositoryRoot(event.target.value);
                  invalidatePreview();
                }}
                placeholder="/Users/you/projects/example"
                autoComplete="off"
                spellCheck={false}
                required
                {...stylex.props(styles.input)}
              />
            </>
          ) : null}

          <label htmlFor={`${instanceId}-reason`} {...stylex.props(styles.label)}>
            Import reason
          </label>
          <textarea
            id={`${instanceId}-reason`}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              invalidatePreview();
            }}
            rows={3}
            maxLength={1_000}
            placeholder="Why this data belongs in Helm"
            required
            {...stylex.props(styles.textarea)}
          />

          <Button type="submit" disabled={!canPreview || pending !== null}>
            {pending === "read"
              ? "Reading file…"
              : pending === "preview"
                ? "Building preview…"
                : "Preview import"}
          </Button>
        </fieldset>
      </form>

      {error ? <ErrorNotice notice={error} /> : null}

      {preview ? (
        <ImportPreviewPanel
          headingRef={previewHeadingRef}
          preview={preview}
          executing={pending === "execute"}
          pending={pending !== null}
          onExecute={() => void executePreview()}
        />
      ) : null}

      <output aria-live="polite" {...stylex.props(styles.status)}>
        {announcement}
      </output>
    </section>
  );
}

function DownloadLink({
  href,
  title,
  detail,
  icon,
  pending,
  disabled,
  onDownload,
  fallbackFileName,
}: {
  href: string;
  title: string;
  detail: string;
  icon: React.ReactNode;
  pending: boolean;
  disabled: boolean;
  onDownload?: (
    event: ReactMouseEvent<HTMLAnchorElement>,
    href: string,
    title: string,
    fallbackFileName: string,
  ) => void;
  fallbackFileName?: string;
}) {
  return (
    <a
      href={href}
      download
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
      onClick={
        disabled
          ? (event) => event.preventDefault()
          : onDownload && fallbackFileName
            ? (event) => onDownload(event, href, title, fallbackFileName)
            : undefined
      }
      {...stylex.props(styles.downloadLink, disabled && styles.downloadLinkDisabled)}
    >
      <span {...stylex.props(styles.downloadIcon)}>{icon}</span>
      <span {...stylex.props(styles.downloadCopy)}>
        <strong>{title}</strong>
        <small>{pending ? "Preparing download…" : detail}</small>
      </span>
      <Download size={15} aria-hidden="true" />
    </a>
  );
}

function ErrorNotice({ notice }: { notice: ImportNotice }) {
  return (
    <div role="alert" {...stylex.props(styles.error)}>
      <AlertTriangle size={17} aria-hidden="true" />
      <div>
        <strong>{notice.message}</strong>
        {notice.details.length > 0 ? (
          <ul {...stylex.props(styles.errorDetails)}>
            {notice.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function ImportPreviewPanel({
  headingRef,
  preview,
  executing,
  pending,
  onExecute,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  preview: ProjectImportPreview;
  executing: boolean;
  pending: boolean;
  onExecute: () => void;
}) {
  return (
    <section aria-label="Import preview" aria-busy={pending} {...stylex.props(styles.preview)}>
      <header {...stylex.props(styles.previewHeader)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Authoritative dry run</p>
          <h3 ref={headingRef} tabIndex={-1} {...stylex.props(styles.previewTitle)}>
            {preview.executable ? "Ready to import" : "Import is blocked"}
          </h3>
        </div>
        {preview.executable ? (
          <CheckCircle2 size={21} aria-label="Executable preview" {...stylex.props(styles.ready)} />
        ) : (
          <AlertTriangle size={21} aria-label="Blocked preview" {...stylex.props(styles.blocked)} />
        )}
      </header>

      <dl aria-label="Import change counts" {...stylex.props(styles.counts)}>
        <Count label="Creates" value={preview.creates.length} />
        <Count label="Updates" value={preview.updates.length} />
        <Count label="No changes" value={preview.noOps.length} />
        <Count label="Conflicts" value={preview.conflicts.length} danger />
        <Count label="Unsupported" value={preview.unsupported.length} danger />
      </dl>

      <div {...stylex.props(styles.previewLists)}>
        <ChangeList label="Creates" items={preview.creates} />
        <ChangeList label="Updates" items={preview.updates} />
        <ChangeList label="No changes" items={preview.noOps} />
        <DiagnosticList label="Conflicts" items={preview.conflicts} />
        <DiagnosticList label="Unsupported" items={preview.unsupported} />
      </div>

      <div {...stylex.props(styles.previewFooter)}>
        <p {...stylex.props(styles.hint)}>
          Any change to the file, destination, repository root, or reason requires another preview.
        </p>
        <Button type="button" disabled={!preview.executable || pending} onClick={onExecute}>
          {executing ? "Importing…" : `Import ${itemCount(preview)} changes`}
        </Button>
      </div>
    </section>
  );
}

function Count({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div {...stylex.props(styles.count, danger && value > 0 && styles.countDanger)}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ChangeList({ label, items }: { label: string; items: readonly ProjectImportChange[] }) {
  const visibleItems = items.slice(0, previewDetailLimit);
  return (
    <section aria-label={`${label} details`} {...stylex.props(styles.previewList)}>
      <h4>{label}</h4>
      {items.length > 0 ? (
        <>
          <ul>
            {visibleItems.map((item) => (
              <li
                key={`${item.entityType}:${item.sourceId}:${item.targetId ?? "new"}:${item.message}`}
              >
                <strong>{item.entityType.replaceAll("_", " ")}</strong> · {item.message}
                <span {...stylex.props(styles.identifier)}>
                  Source {item.sourceId}
                  {item.targetId ? ` → ${item.targetId}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {items.length > visibleItems.length ? (
            <p {...stylex.props(styles.truncationNotice)}>
              Showing the first {visibleItems.length} of {items.length} details.
            </p>
          ) : null}
        </>
      ) : (
        <p>None.</p>
      )}
    </section>
  );
}

function DiagnosticList({
  label,
  items,
}: {
  label: string;
  items: readonly (ProjectImportConflict | ProjectImportUnsupported)[];
}) {
  const visibleItems = items.slice(0, previewDetailLimit);
  return (
    <section aria-label={`${label} details`} {...stylex.props(styles.previewList)}>
      <h4>{label}</h4>
      {items.length > 0 ? (
        <>
          <ul>
            {visibleItems.map((item) => (
              <li
                key={`${item.category}:${item.code}:${item.sourceId ?? "none"}:${item.targetId ?? "none"}:${item.path.join(".")}:${item.message}`}
              >
                <strong>{item.code.replaceAll("_", " ")}</strong> · {item.message}
                <span {...stylex.props(styles.identifier)}>
                  {item.entityType ? item.entityType.replaceAll("_", " ") : "Import"}
                  {item.sourceId ? ` · Source ${item.sourceId}` : ""}
                  {item.path.length > 0 ? ` · ${item.path.join(".")}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {items.length > visibleItems.length ? (
            <p {...stylex.props(styles.truncationNotice)}>
              Showing the first {visibleItems.length} of {items.length} details.
            </p>
          ) : null}
        </>
      ) : (
        <p>None.</p>
      )}
    </section>
  );
}

const styles = stylex.create({
  root: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    display: "grid",
    gap: tokens.space4,
    padding: tokens.space5,
    width: "100%",
    "@media (max-width: 600px)": { padding: tokens.space4 },
  },
  header: {
    alignItems: "start",
    display: "flex",
    gap: tokens.space4,
    justifyContent: "space-between",
  },
  headerIcon: { color: tokens.accent },
  eyebrow: {
    color: tokens.accent,
    fontSize: 11,
    fontWeight: 750,
    letterSpacing: "0.09em",
    margin: 0,
    textTransform: "uppercase",
  },
  title: { fontSize: 20, letterSpacing: "-0.02em", margin: `${tokens.space1} 0 0` },
  description: { color: tokens.foregroundMuted, fontSize: 13, lineHeight: 1.55, margin: 0 },
  downloadGrid: {
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  downloadLink: {
    alignItems: "center",
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    display: "flex",
    gap: tokens.space2,
    minHeight: 64,
    padding: tokens.space3,
    textDecoration: "none",
    ":hover": { borderColor: tokens.accent },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  downloadLinkDisabled: { cursor: "wait", opacity: 0.65, pointerEvents: "none" },
  downloadIcon: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderRadius: 6,
    color: tokens.accent,
    display: "inline-flex",
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  downloadCopy: {
    display: "grid",
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  downloadChoice: { display: "grid", gap: tokens.space1 },
  scopeLabel: {
    color: tokens.foregroundMuted,
    display: "grid",
    fontSize: 10,
    fontWeight: 700,
    gap: tokens.space1,
  },
  scopeSelect: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    fontSize: 11,
    minHeight: 30,
    paddingInline: tokens.space2,
    width: "100%",
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  divider: { backgroundColor: tokens.border, height: 1 },
  form: { display: "grid", gap: tokens.space3 },
  importHeading: { alignItems: "start", display: "flex", gap: tokens.space2 },
  sectionTitle: { fontSize: 15, margin: 0 },
  fieldset: { border: 0, display: "grid", gap: tokens.space2, margin: 0, padding: 0 },
  label: { fontSize: 12, fontWeight: 700, marginBlockStart: tokens.space1 },
  fileInput: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "dashed",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    fontSize: 13,
    minHeight: 44,
    padding: tokens.space2,
    width: "100%",
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  input: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    minHeight: 40,
    paddingInline: tokens.space3,
    width: "100%",
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  textarea: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    lineHeight: 1.45,
    padding: tokens.space3,
    resize: "vertical",
    width: "100%",
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  hint: { color: tokens.foregroundMuted, fontSize: 11, lineHeight: 1.45, margin: 0 },
  destination: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: tokens.radius2,
    color: tokens.foregroundMuted,
    fontSize: 12,
    margin: `${tokens.space1} 0`,
    padding: tokens.space3,
  },
  warning: { color: tokens.danger },
  error: {
    alignItems: "start",
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.danger,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.danger,
    display: "flex",
    fontSize: 12,
    gap: tokens.space2,
    lineHeight: 1.45,
    padding: tokens.space3,
  },
  errorDetails: { margin: `${tokens.space1} 0 0`, paddingInlineStart: tokens.space5 },
  status: { color: tokens.foregroundMuted, fontSize: 12, margin: 0, minHeight: 18 },
  preview: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space4,
    padding: tokens.space4,
  },
  previewHeader: {
    alignItems: "start",
    display: "flex",
    justifyContent: "space-between",
  },
  previewTitle: {
    fontSize: 18,
    margin: `${tokens.space1} 0 0`,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  ready: { color: tokens.accent },
  blocked: { color: tokens.danger },
  counts: {
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
    margin: 0,
    "@media (max-width: 680px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
  },
  count: {
    backgroundColor: tokens.surface,
    borderRadius: tokens.radius2,
    display: "grid",
    gap: tokens.space1,
    padding: tokens.space2,
  },
  countDanger: { color: tokens.danger },
  previewLists: { display: "grid", gap: tokens.space2 },
  previewList: {
    backgroundColor: tokens.surface,
    borderRadius: tokens.radius2,
    fontSize: 12,
    lineHeight: 1.45,
    padding: tokens.space3,
  },
  identifier: {
    color: tokens.foregroundMuted,
    display: "block",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 10,
    overflowWrap: "anywhere",
  },
  truncationNotice: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    margin: `${tokens.space2} 0 0`,
  },
  previewFooter: {
    alignItems: "center",
    display: "flex",
    gap: tokens.space4,
    justifyContent: "space-between",
    "@media (max-width: 600px)": { alignItems: "stretch", flexDirection: "column" },
  },
});
