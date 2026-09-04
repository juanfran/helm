import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import * as stylex from "@stylexjs/stylex";
import { Check, ChevronsUpDown, FolderGit2, Plus, X } from "lucide-react";

import { Button } from "../../components/ui/button";
import type { CreateProjectInput, Project, SelectActiveProjectInput } from "../../domain/projects";
import { tokens } from "../../styles/tokens.stylex";

type ProjectSwitcherCommandResponse = { ok: true } | { ok: false; error: { message: string } };

export type ProjectSwitcherProps = {
  projects: readonly Project[];
  activeProject: Project;
  activeProjectVersion: number;
  onSelect: (input: SelectActiveProjectInput) => Promise<ProjectSwitcherCommandResponse>;
  onCreate: (input: CreateProjectInput) => Promise<ProjectSwitcherCommandResponse>;
};

export function ProjectSwitcher({
  projects,
  activeProject,
  activeProjectVersion,
  onSelect,
  onCreate,
}: ProjectSwitcherProps) {
  const availableProjects = useMemo(() => {
    if (projects.some((project) => project.id === activeProject.id)) return projects;
    return [activeProject, ...projects];
  }, [activeProject, projects]);
  const selectItems = useMemo(
    () =>
      availableProjects.map((project) => ({
        label: project.name,
        value: project.id,
      })),
    [availableProjects],
  );
  const [switchPending, setSwitchPending] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [repositoryRoot, setRepositoryRoot] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const repositoryInputRef = useRef<HTMLInputElement>(null);
  const selectionIntentRef = useRef<SelectActiveProjectInput | null>(null);
  const createIntentRef = useRef<CreateProjectInput | null>(null);
  const instanceId = useId();
  const detailId = `${instanceId}-detail`;
  const repositoryInputId = `${instanceId}-repository-root`;
  const repositoryHelpId = `${instanceId}-repository-root-help`;
  const repositoryErrorId = `${instanceId}-repository-root-error`;

  async function selectProject(projectId: string | null) {
    if (!projectId || projectId === activeProject.id || switchPending) return;

    setSwitchPending(true);
    setSwitchError(null);
    const previousIntent = selectionIntentRef.current;
    const intent =
      previousIntent?.projectId === projectId &&
      previousIntent.expectedVersion === activeProjectVersion
        ? previousIntent
        : {
            projectId,
            expectedVersion: activeProjectVersion,
            idempotencyKey: crypto.randomUUID(),
          };
    selectionIntentRef.current = intent;
    try {
      const response = await onSelect(intent);
      selectionIntentRef.current = null;
      if (!response.ok) setSwitchError(response.error.message);
    } catch {
      setSwitchError("Helm could not switch projects. Check that the local server is running.");
    } finally {
      setSwitchPending(false);
    }
  }

  function setDialogOpen(open: boolean) {
    if (createPending) return;
    setAddOpen(open);
    if (!open) {
      setRepositoryRoot("");
      setCreateError(null);
      createIntentRef.current = null;
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const canonicalInput = repositoryRoot.trim();
    if (!canonicalInput || createPending) return;

    setCreatePending(true);
    setCreateError(null);
    const previousIntent = createIntentRef.current;
    const intent =
      previousIntent?.repositoryRoot === canonicalInput
        ? previousIntent
        : {
            repositoryRoot: canonicalInput,
            idempotencyKey: crypto.randomUUID(),
          };
    createIntentRef.current = intent;
    try {
      const response = await onCreate(intent);
      createIntentRef.current = null;
      if (response.ok) {
        setRepositoryRoot("");
        setAddOpen(false);
      } else {
        setCreateError(response.error.message);
      }
    } catch {
      setCreateError("Helm could not create the project. Check that the local server is running.");
    } finally {
      setCreatePending(false);
    }
  }

  return (
    <section
      aria-label="Project switcher"
      aria-busy={switchPending || createPending}
      {...stylex.props(styles.root)}
    >
      <Select.Root
        items={selectItems}
        value={activeProject.id}
        disabled={switchPending || createPending}
        onValueChange={(projectId) => void selectProject(projectId)}
      >
        <Select.Label {...stylex.props(styles.label)}>Active project</Select.Label>
        <div {...stylex.props(styles.controls)}>
          <Select.Trigger aria-describedby={detailId} {...stylex.props(styles.trigger)}>
            <span {...stylex.props(styles.triggerIcon)} aria-hidden="true">
              <FolderGit2 size={16} />
            </span>
            <Select.Value {...stylex.props(styles.triggerValue)}>
              {(projectId) =>
                availableProjects.find((project) => project.id === projectId)?.name ??
                activeProject.name
              }
            </Select.Value>
            <Select.Icon {...stylex.props(styles.selectIcon)}>
              <ChevronsUpDown size={15} aria-hidden="true" />
            </Select.Icon>
          </Select.Trigger>

          <Select.Portal>
            <Select.Positioner
              side="bottom"
              align="start"
              sideOffset={6}
              {...stylex.props(styles.positioner)}
            >
              <Select.Popup {...stylex.props(styles.popup)}>
                <Select.List {...stylex.props(styles.list)}>
                  {availableProjects.map((project) => (
                    <Select.Item
                      key={project.id}
                      value={project.id}
                      label={`${project.name}, project ${project.sequence}, version ${project.version}`}
                      className={(state) =>
                        stylex.props(
                          styles.item,
                          state.highlighted && styles.itemHighlighted,
                          state.selected && styles.itemSelected,
                        ).className
                      }
                    >
                      <span {...stylex.props(styles.itemIndicatorSlot)}>
                        <Select.ItemIndicator {...stylex.props(styles.itemIndicator)}>
                          <Check size={14} />
                        </Select.ItemIndicator>
                      </span>
                      <Select.ItemText {...stylex.props(styles.itemText)}>
                        <span {...stylex.props(styles.itemHeading)}>
                          <span {...stylex.props(styles.itemName)}>{project.name}</span>
                          {project.id === activeProject.id ? (
                            <span {...stylex.props(styles.activeBadge)}>Active</span>
                          ) : null}
                        </span>
                        <span {...stylex.props(styles.itemPath)}>{project.repositoryRoot}</span>
                        <span {...stylex.props(styles.itemMetadata)}>
                          Project #{project.sequence} · v{project.version}
                        </span>
                      </Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </div>
      </Select.Root>

      <p id={detailId} {...stylex.props(styles.detail)}>
        <span>{activeProject.repositoryRoot}</span>
        <span aria-hidden="true">·</span>
        <span>Project v{activeProject.version}</span>
        <span aria-hidden="true">·</span>
        <span>Selection v{activeProjectVersion}</span>
      </p>

      <Dialog.Root open={addOpen} onOpenChange={setDialogOpen}>
        <Dialog.Trigger
          disabled={switchPending || createPending}
          {...stylex.props(styles.addTrigger)}
        >
          <Plus size={14} aria-hidden="true" />
          Add project
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
          <Dialog.Popup initialFocus={repositoryInputRef} {...stylex.props(styles.dialog)}>
            <div {...stylex.props(styles.dialogHeader)}>
              <div>
                <Dialog.Title {...stylex.props(styles.dialogTitle)}>Add local project</Dialog.Title>
                <Dialog.Description {...stylex.props(styles.dialogDescription)}>
                  Connect another local Git repository and make it active in Helm.
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label="Close add project"
                disabled={createPending}
                {...stylex.props(styles.closeButton)}
              >
                <X size={16} aria-hidden="true" />
              </Dialog.Close>
            </div>

            <form
              aria-label="Add local project"
              onSubmit={createProject}
              {...stylex.props(styles.form)}
            >
              <label htmlFor={repositoryInputId} {...stylex.props(styles.inputLabel)}>
                Repository root
              </label>
              <input
                ref={repositoryInputRef}
                id={repositoryInputId}
                name="repositoryRoot"
                value={repositoryRoot}
                onChange={(event) => setRepositoryRoot(event.target.value)}
                placeholder="/Users/you/projects/example"
                autoComplete="off"
                spellCheck={false}
                required
                disabled={createPending}
                aria-describedby={
                  createError ? `${repositoryHelpId} ${repositoryErrorId}` : repositoryHelpId
                }
                aria-invalid={createError ? true : undefined}
                {...stylex.props(styles.input)}
              />
              <p id={repositoryHelpId} {...stylex.props(styles.hint)}>
                Helm verifies the folder and its .git entry before writing.
              </p>
              {createError ? (
                <p id={repositoryErrorId} role="alert" {...stylex.props(styles.error)}>
                  {createError}
                </p>
              ) : null}
              <div {...stylex.props(styles.dialogActions)}>
                <Dialog.Close disabled={createPending} {...stylex.props(styles.cancelButton)}>
                  Cancel
                </Dialog.Close>
                <Button
                  type="submit"
                  disabled={createPending || repositoryRoot.trim().length === 0}
                >
                  {createPending ? "Creating…" : "Create and switch"}
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <span aria-live="polite" {...stylex.props(styles.status)}>
        {switchPending ? "Switching project…" : null}
      </span>
      {switchError ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {switchError}
        </p>
      ) : null}
    </section>
  );
}

const styles = stylex.create({
  root: {
    alignItems: "end",
    display: "grid",
    gap: tokens.space1,
    gridTemplateColumns: "minmax(220px, 360px) auto",
    maxWidth: 560,
    position: "relative",
    width: "100%",
    "@media (max-width: 600px)": {
      alignItems: "stretch",
      gridTemplateColumns: "1fr",
      maxWidth: "none",
    },
  },
  label: {
    color: tokens.foregroundMuted,
    cursor: "default",
    fontSize: 11,
    fontWeight: 750,
    gridColumn: "1",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  controls: {
    gridColumn: "1",
    minWidth: 0,
  },
  trigger: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "grid",
    fontSize: 14,
    fontWeight: 700,
    gap: tokens.space2,
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    minHeight: 40,
    paddingInline: tokens.space3,
    textAlign: "start",
    width: "100%",
    ":disabled": { cursor: "not-allowed", opacity: 0.5 },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    ":hover": { borderColor: tokens.accent },
  },
  triggerIcon: {
    alignItems: "center",
    color: tokens.accent,
    display: "inline-flex",
  },
  triggerValue: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  selectIcon: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "inline-flex",
  },
  positioner: { outline: "none", zIndex: 40 },
  popup: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    color: tokens.foreground,
    minWidth: "var(--anchor-width)",
    outline: "none",
    overflow: "hidden",
  },
  list: {
    maxHeight: "min(440px, var(--available-height))",
    overflowY: "auto",
    paddingBlock: tokens.space1,
  },
  item: {
    alignItems: "start",
    cursor: "default",
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "16px minmax(0, 1fr)",
    outline: "none",
    paddingBlock: tokens.space2,
    paddingInline: tokens.space3,
  },
  itemHighlighted: { backgroundColor: tokens.surfaceMuted },
  itemSelected: { color: tokens.accent },
  itemIndicatorSlot: { minHeight: 18, paddingBlockStart: 2 },
  itemIndicator: { alignItems: "center", display: "inline-flex" },
  itemText: { display: "grid", gap: 2, minWidth: 0 },
  itemHeading: {
    alignItems: "center",
    display: "flex",
    gap: tokens.space2,
    minWidth: 0,
  },
  itemName: {
    fontSize: 13,
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  activeBadge: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: 999,
    color: tokens.accent,
    fontSize: 10,
    fontWeight: 750,
    paddingBlock: 2,
    paddingInline: 6,
  },
  itemPath: {
    color: tokens.foregroundMuted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
    overflowWrap: "anywhere",
  },
  itemMetadata: { color: tokens.foregroundMuted, fontSize: 10 },
  detail: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    flexWrap: "wrap",
    fontSize: 10,
    gap: tokens.space1,
    gridColumn: "1",
    margin: 0,
    minWidth: 0,
  },
  addTrigger: {
    alignItems: "center",
    alignSelf: "start",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "inline-flex",
    fontSize: 12,
    fontWeight: 700,
    gap: tokens.space1,
    gridColumn: "2",
    gridRow: "2",
    minHeight: 40,
    paddingInline: tokens.space3,
    whiteSpace: "nowrap",
    ":disabled": { cursor: "not-allowed", opacity: 0.5 },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    ":hover": { borderColor: tokens.accent },
    "@media (max-width: 600px)": {
      gridColumn: "1",
      gridRow: "auto",
      justifyContent: "center",
      width: "100%",
    },
  },
  backdrop: {
    backgroundColor: tokens.overlay,
    inset: 0,
    minHeight: "100dvh",
    position: "fixed",
    zIndex: 50,
  },
  dialog: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    color: tokens.foreground,
    display: "grid",
    gap: tokens.space5,
    left: "50%",
    maxWidth: "calc(100vw - 32px)",
    maxHeight: "calc(100dvh - 32px)",
    overflowY: "auto",
    padding: tokens.space5,
    position: "fixed",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: 480,
    zIndex: 51,
  },
  dialogHeader: {
    alignItems: "start",
    display: "flex",
    gap: tokens.space4,
    justifyContent: "space-between",
  },
  dialogTitle: {
    fontSize: 20,
    fontWeight: 750,
    letterSpacing: "-0.02em",
    margin: 0,
  },
  dialogDescription: {
    color: tokens.foregroundMuted,
    fontSize: 13,
    lineHeight: 1.5,
    marginBlockEnd: 0,
    marginBlockStart: tokens.space1,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    cursor: "pointer",
    display: "inline-flex",
    height: 32,
    justifyContent: "center",
    padding: 0,
    width: 32,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    ":hover": {
      backgroundColor: tokens.surfaceMuted,
      color: tokens.foreground,
    },
  },
  form: { display: "grid", gap: tokens.space2 },
  inputLabel: { fontSize: 12, fontWeight: 700 },
  input: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    minHeight: 42,
    paddingInline: tokens.space3,
    width: "100%",
    ":disabled": { opacity: 0.6 },
    ":focus-visible": {
      borderColor: tokens.accent,
      outlineColor: tokens.accent,
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 1,
    },
  },
  hint: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    lineHeight: 1.45,
    margin: 0,
  },
  dialogActions: {
    display: "flex",
    gap: tokens.space2,
    justifyContent: "end",
    marginBlockStart: tokens.space3,
  },
  cancelButton: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "inline-flex",
    fontSize: 14,
    fontWeight: 650,
    justifyContent: "center",
    minHeight: 36,
    paddingInline: tokens.space4,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    ":hover": { borderColor: tokens.accent },
  },
  status: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    gridColumn: "1 / -1",
    minHeight: 0,
  },
  error: {
    color: tokens.danger,
    fontSize: 12,
    gridColumn: "1 / -1",
    lineHeight: 1.45,
    margin: 0,
  },
});
