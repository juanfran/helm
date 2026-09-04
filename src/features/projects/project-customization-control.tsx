import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { Archive, ArrowDown, ArrowUp, Plus, SlidersHorizontal, X } from "lucide-react";

import type { TaskTag } from "../../domain/tasks";
import {
  MAX_CUSTOM_FIELD_DEFINITIONS,
  MAX_CUSTOM_FIELD_TEXT_LENGTH,
  customFieldDefinitionDraftSchema,
  customFieldTypeSchema,
  type AddCustomFieldDefinitionInput,
  type CustomFieldDefinition,
  type CustomFieldDefinitionDraft,
  type CustomFieldType,
  type CustomFieldValue,
  type ProjectCustomizationSnapshot,
  type ReorderCustomFieldDefinitionsInput,
  type RetireCustomFieldDefinitionInput,
  type ReviewModeOverride,
  type SetTagReviewModeOverrideInput,
} from "../../domain/customization";
import type { CustomizationCommandResponse } from "../../server/customization-adapter";
import { tokens } from "../../styles/tokens.stylex";

type CommandError = Extract<CustomizationCommandResponse, { readonly ok: false }>["error"];
type VisibleError = CommandError | { readonly type: "UnexpectedError"; readonly message: string };

type DraftState = {
  key: string;
  label: string;
  description: string;
  type: CustomFieldType;
  textMinLength: string;
  textMaxLength: string;
  textHasDefault: boolean;
  textDefault: string;
  numberMin: string;
  numberMax: string;
  numberInteger: boolean;
  numberHasDefault: boolean;
  numberDefault: string;
  booleanDefault: "" | "true" | "false";
  dateMin: string;
  dateMax: string;
  dateDefault: string;
  selectOptions: string;
  selectDefault: string;
};

function emptyDraft(): DraftState {
  return {
    key: "",
    label: "",
    description: "",
    type: "text",
    textMinLength: "0",
    textMaxLength: String(MAX_CUSTOM_FIELD_TEXT_LENGTH),
    textHasDefault: false,
    textDefault: "",
    numberMin: "",
    numberMax: "",
    numberInteger: false,
    numberHasDefault: false,
    numberDefault: "",
    booleanDefault: "",
    dateMin: "",
    dateMax: "",
    dateDefault: "",
    selectOptions: "",
    selectDefault: "",
  };
}

function optionalNumber(value: string) {
  return value.trim() === "" ? null : Number(value);
}

function selectOptions(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      return separator < 0
        ? { id: line, label: "" }
        : {
            id: line.slice(0, separator).trim(),
            label: line.slice(separator + 1).trim(),
          };
    });
}

function parseDraft(
  state: DraftState,
):
  | { readonly ok: true; readonly definition: CustomFieldDefinitionDraft }
  | { readonly ok: false; readonly issues: readonly string[] } {
  const common = {
    key: state.key,
    display: { label: state.label, description: state.description },
  };
  let input: unknown;

  switch (state.type) {
    case "text":
      input = {
        ...common,
        type: state.type,
        validation: {
          minLength: Number(state.textMinLength),
          maxLength: Number(state.textMaxLength),
        },
        defaultValue: state.textHasDefault ? { type: state.type, value: state.textDefault } : null,
      };
      break;
    case "number":
      input = {
        ...common,
        type: state.type,
        validation: {
          min: optionalNumber(state.numberMin),
          max: optionalNumber(state.numberMax),
          integer: state.numberInteger,
        },
        defaultValue: state.numberHasDefault
          ? { type: state.type, value: Number(state.numberDefault) }
          : null,
      };
      break;
    case "boolean":
      input = {
        ...common,
        type: state.type,
        validation: {},
        defaultValue:
          state.booleanDefault === ""
            ? null
            : { type: state.type, value: state.booleanDefault === "true" },
      };
      break;
    case "date":
      input = {
        ...common,
        type: state.type,
        validation: { min: state.dateMin || null, max: state.dateMax || null },
        defaultValue: state.dateDefault ? { type: state.type, value: state.dateDefault } : null,
      };
      break;
    case "single_select":
      input = {
        ...common,
        type: state.type,
        validation: { options: selectOptions(state.selectOptions) },
        defaultValue: state.selectDefault ? { type: state.type, value: state.selectDefault } : null,
      };
      break;
  }

  const result = customFieldDefinitionDraftSchema.safeParse(input);
  return result.success
    ? { ok: true, definition: result.data }
    : {
        ok: false,
        issues: result.error.issues.map((issue) => {
          const path = issue.path.join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        }),
      };
}

function fieldTypeLabel(type: CustomFieldType) {
  switch (type) {
    case "text":
      return "Text";
    case "number":
      return "Number";
    case "boolean":
      return "Boolean";
    case "date":
      return "Date";
    case "single_select":
      return "Single select";
  }
  const unhandled: never = type;
  throw new Error(`Unsupported custom-field type: ${String(unhandled)}`);
}

function defaultLabel(value: CustomFieldValue | null) {
  if (value === null) return "No default";
  switch (value.type) {
    case "boolean":
      return value.value ? "True" : "False";
    case "text":
    case "single_select":
    case "date":
    case "number":
      return String(value.value);
  }
  const unhandled: never = value;
  throw new Error(`Unsupported custom-field value: ${String(unhandled)}`);
}

function validationLabel(definition: CustomFieldDefinition) {
  switch (definition.type) {
    case "text":
      return `Length ${definition.validation.minLength}–${definition.validation.maxLength}`;
    case "number": {
      const minimum = definition.validation.min ?? "any";
      const maximum = definition.validation.max ?? "any";
      return `Range ${minimum}–${maximum} · ${definition.validation.integer ? "Whole numbers" : "Decimals allowed"}`;
    }
    case "boolean":
      return "True or false";
    case "date":
      return `Dates ${definition.validation.min ?? "any"}–${definition.validation.max ?? "any"}`;
    case "single_select":
      return `Options: ${definition.validation.options.map((option) => option.label).join(", ")}`;
  }
  const unhandled: never = definition;
  throw new Error(`Unsupported custom-field definition: ${String(unhandled)}`);
}

function compareDefinitions(left: CustomFieldDefinition, right: CustomFieldDefinition) {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function compareTags(left: TaskTag, right: TaskTag) {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export type ProjectCustomizationControlProps = {
  customization: ProjectCustomizationSnapshot;
  tagDefinitions: readonly TaskTag[];
  onAddFieldDefinition: (
    input: AddCustomFieldDefinitionInput,
  ) => Promise<CustomizationCommandResponse>;
  onRetireFieldDefinition: (
    input: RetireCustomFieldDefinitionInput,
  ) => Promise<CustomizationCommandResponse>;
  onReorderFieldDefinitions: (
    input: ReorderCustomFieldDefinitionsInput,
  ) => Promise<CustomizationCommandResponse>;
  onChangeTagReviewModeOverride: (
    input: SetTagReviewModeOverrideInput,
  ) => Promise<CustomizationCommandResponse>;
};

export function ProjectCustomizationControl({
  customization,
  tagDefinitions,
  onAddFieldDefinition,
  onRetireFieldDefinition,
  onReorderFieldDefinitions,
  onChangeTagReviewModeOverride,
}: ProjectCustomizationControlProps) {
  const [draft, setDraft] = useState(emptyDraft);
  const [createOpen, setCreateOpen] = useState(false);
  const [retiringDefinition, setRetiringDefinition] = useState<CustomFieldDefinition | null>(null);
  const [retireReason, setRetireReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<VisibleError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const createLabelRef = useRef<HTMLInputElement>(null);
  const retireReasonRef = useRef<HTMLTextAreaElement>(null);
  const instanceId = useId();

  const activeDefinitions = useMemo(
    () =>
      customization.definitions
        .filter((definition) => definition.retiredAt === null)
        .toSorted(compareDefinitions),
    [customization.definitions],
  );
  const retiredDefinitions = useMemo(
    () =>
      customization.definitions
        .filter((definition) => definition.retiredAt !== null)
        .toSorted(compareDefinitions),
    [customization.definitions],
  );
  const orderedTags = useMemo(() => tagDefinitions.toSorted(compareTags), [tagDefinitions]);
  const controlsDisabled = pending !== null;
  const limitReached = customization.definitions.length >= MAX_CUSTOM_FIELD_DEFINITIONS;
  const dialogOpen = createOpen || retiringDefinition !== null;

  async function runCommand(
    pendingMessage: string,
    successMessage: string,
    execute: () => Promise<CustomizationCommandResponse>,
  ) {
    if (pending !== null) return false;
    setPending(pendingMessage);
    setAnnouncement("");
    setError(null);
    try {
      const response = await execute();
      if (!response.ok) {
        setError(response.error);
        return false;
      }
      setAnnouncement(
        `${successMessage} Configuration version ${response.customization.projectVersion}.`,
      );
      return true;
    } catch {
      setError({
        type: "UnexpectedError",
        message: "Helm could not save the project configuration. Check the local server and retry.",
      });
      return false;
    } finally {
      setPending(null);
    }
  }

  function changeCreateOpen(open: boolean) {
    if (controlsDisabled) return;
    setCreateOpen(open);
    setError(null);
    if (!open) setDraft(emptyDraft());
  }

  async function createDefinition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseDraft(draft);
    if (!parsed.ok) {
      setError({
        type: "InvalidCustomizationInputError",
        message: "Check the custom-field configuration.",
        issues: parsed.issues,
      });
      return;
    }

    const input: AddCustomFieldDefinitionInput = {
      projectId: customization.projectId,
      definition: parsed.definition,
      expectedProjectVersion: customization.projectVersion,
      idempotencyKey: crypto.randomUUID(),
    };
    const saved = await runCommand(
      "Creating custom field",
      `${parsed.definition.display.label} created.`,
      () => onAddFieldDefinition(input),
    );
    if (saved) {
      setDraft(emptyDraft());
      setCreateOpen(false);
    }
  }

  async function reorderDefinition(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= activeDefinitions.length) return;
    const reordered = activeDefinitions.map((definition) => definition.id);
    [reordered[index], reordered[destination]] = [reordered[destination]!, reordered[index]!];
    await runCommand("Reordering custom fields", "Custom fields reordered.", () =>
      onReorderFieldDefinitions({
        projectId: customization.projectId,
        orderedFieldIds: reordered,
        expectedProjectVersion: customization.projectVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
  }

  function openRetireDialog(definition: CustomFieldDefinition) {
    if (controlsDisabled) return;
    setRetireReason("");
    setError(null);
    setRetiringDefinition(definition);
  }

  function changeRetireOpen(open: boolean) {
    if (controlsDisabled) return;
    if (!open) {
      setRetiringDefinition(null);
      setRetireReason("");
      setError(null);
    }
  }

  async function retireDefinition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (retiringDefinition === null || retireReason.trim() === "") return;
    const input: RetireCustomFieldDefinitionInput = {
      projectId: customization.projectId,
      fieldId: retiringDefinition.id,
      reason: retireReason,
      expectedProjectVersion: customization.projectVersion,
      idempotencyKey: crypto.randomUUID(),
    };
    const saved = await runCommand(
      `Retiring ${retiringDefinition.display.label}`,
      `${retiringDefinition.display.label} retired.`,
      () => onRetireFieldDefinition(input),
    );
    if (saved) {
      setRetiringDefinition(null);
      setRetireReason("");
    }
  }

  async function changeTagOverride(tag: TaskTag, value: string) {
    const reviewModeOverride: ReviewModeOverride =
      value === "required" || value === "direct" ? value : null;
    const action =
      reviewModeOverride === null
        ? `Use the project review policy for tag ${tag.name}.`
        : reviewModeOverride === "required"
          ? `Require human review for tag ${tag.name}.`
          : `Allow direct completion for tag ${tag.name}.`;
    await runCommand(`Saving ${tag.name} review policy`, `${tag.name} review policy saved.`, () =>
      onChangeTagReviewModeOverride({
        projectId: customization.projectId,
        tagId: tag.id,
        reviewModeOverride,
        expectedProjectVersion: customization.projectVersion,
        reason: action,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
  }

  function currentTagMode(tagId: string): ReviewModeOverride {
    return customization.tagReviewRules.find((rule) => rule.tagId === tagId)?.reviewMode ?? null;
  }

  return (
    <section
      aria-label="Project customization"
      aria-busy={controlsDisabled}
      {...stylex.props(styles.root)}
    >
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headingGroup)}>
          <span aria-hidden="true" {...stylex.props(styles.headingIcon)}>
            <SlidersHorizontal size={18} />
          </span>
          <div>
            <h2 {...stylex.props(styles.title)}>Project customization</h2>
            <p {...stylex.props(styles.subtitle)}>
              Typed task metadata and tag-specific agent completion policy.
            </p>
          </div>
        </div>
        <div aria-label="Configuration state" {...stylex.props(styles.versionBadge)}>
          Configuration v{customization.projectVersion}
        </div>
      </header>

      {!dialogOpen && error ? <ErrorNotice error={error} /> : null}
      <output aria-live="polite" {...stylex.props(styles.status)}>
        {pending ? `${pending}…` : announcement}
      </output>

      <div {...stylex.props(styles.sectionHeading)}>
        <div>
          <h3 {...stylex.props(styles.sectionTitle)}>Custom fields</h3>
          <p {...stylex.props(styles.sectionCopy)}>
            Definitions are shared by the human interface and connected agents.
          </p>
        </div>

        <Dialog.Root open={createOpen} onOpenChange={changeCreateOpen}>
          <Dialog.Trigger
            disabled={controlsDisabled || limitReached}
            {...stylex.props(styles.primaryButton)}
          >
            <Plus size={15} aria-hidden="true" />
            Add custom field
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
            <Dialog.Popup initialFocus={createLabelRef} {...stylex.props(styles.dialog)}>
              <DialogHeader
                title="Add custom field"
                description="Define its stable machine key, human display, validation, and optional default."
                closeLabel="Close add custom field"
                disabled={controlsDisabled}
              />
              {error ? <ErrorNotice error={error} /> : null}
              <form
                aria-label="Add custom field"
                onSubmit={createDefinition}
                {...stylex.props(styles.form)}
              >
                <fieldset disabled={controlsDisabled} {...stylex.props(styles.fieldset)}>
                  <div {...stylex.props(styles.twoColumns)}>
                    <Field label="Display label" htmlFor={`${instanceId}-field-label`}>
                      <input
                        ref={createLabelRef}
                        id={`${instanceId}-field-label`}
                        value={draft.label}
                        onChange={(event) =>
                          setDraft((currentDraft) => ({
                            ...currentDraft,
                            label: event.target.value,
                          }))
                        }
                        maxLength={120}
                        required
                        {...stylex.props(styles.input)}
                      />
                    </Field>
                    <Field
                      label="Machine key"
                      htmlFor={`${instanceId}-field-key`}
                      hint="Lowercase letters, numbers, and underscores."
                    >
                      <input
                        id={`${instanceId}-field-key`}
                        value={draft.key}
                        onChange={(event) =>
                          setDraft((currentDraft) => ({ ...currentDraft, key: event.target.value }))
                        }
                        placeholder="release_risk"
                        maxLength={80}
                        autoCapitalize="none"
                        spellCheck={false}
                        required
                        {...stylex.props(styles.input)}
                      />
                    </Field>
                  </div>
                  <Field label="Description" htmlFor={`${instanceId}-field-description`}>
                    <textarea
                      id={`${instanceId}-field-description`}
                      value={draft.description}
                      onChange={(event) =>
                        setDraft((currentDraft) => ({
                          ...currentDraft,
                          description: event.target.value,
                        }))
                      }
                      rows={2}
                      maxLength={1_000}
                      {...stylex.props(styles.textarea)}
                    />
                  </Field>
                  <Field label="Field type" htmlFor={`${instanceId}-field-type`}>
                    <select
                      id={`${instanceId}-field-type`}
                      value={draft.type}
                      onChange={(event) => {
                        const parsed = customFieldTypeSchema.safeParse(event.target.value);
                        if (parsed.success) {
                          setDraft((currentDraft) => ({ ...currentDraft, type: parsed.data }));
                        }
                      }}
                      {...stylex.props(styles.input)}
                    >
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="boolean">Boolean</option>
                      <option value="date">Date</option>
                      <option value="single_select">Single select</option>
                    </select>
                  </Field>
                  <TypeConfiguration draft={draft} instanceId={instanceId} onChange={setDraft} />
                </fieldset>
                <div {...stylex.props(styles.dialogActions)}>
                  <Dialog.Close
                    disabled={controlsDisabled}
                    {...stylex.props(styles.secondaryButton)}
                  >
                    Cancel
                  </Dialog.Close>
                  <button
                    type="submit"
                    disabled={controlsDisabled}
                    {...stylex.props(styles.primaryButton)}
                  >
                    {pending === "Creating custom field" ? "Creating…" : "Create field"}
                  </button>
                </div>
              </form>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </div>

      {limitReached ? (
        <p role="note" {...stylex.props(styles.limitNote)}>
          This project has reached the {MAX_CUSTOM_FIELD_DEFINITIONS}-field definition limit.
        </p>
      ) : null}

      <div {...stylex.props(styles.definitionGroups)}>
        <DefinitionList
          title="Active fields"
          description="Active fields appear on task forms and can be reordered."
          definitions={activeDefinitions}
          emptyMessage="No active custom fields yet."
          disabled={controlsDisabled}
          onMove={(index, direction) => void reorderDefinition(index, direction)}
          onRetire={openRetireDialog}
        />
        <DefinitionList
          title="Retired fields"
          description="Historical values remain attached to tasks and visible in audit history."
          definitions={retiredDefinitions}
          emptyMessage="No retired custom fields."
          retired
          disabled={controlsDisabled}
          onMove={() => undefined}
          onRetire={() => undefined}
        />
      </div>

      <section
        aria-labelledby={`${instanceId}-tag-policy-title`}
        {...stylex.props(styles.tagSection)}
      >
        <div>
          <h3 id={`${instanceId}-tag-policy-title`} {...stylex.props(styles.sectionTitle)}>
            Tag review policy
          </h3>
          <p {...stylex.props(styles.sectionCopy)}>
            Tag overrides apply above the project default and below an explicit task override.
          </p>
        </div>
        {orderedTags.length === 0 ? (
          <p {...stylex.props(styles.empty)}>No project tags are available.</p>
        ) : (
          <ul aria-label="Tag review policies" {...stylex.props(styles.tagList)}>
            {orderedTags.map((tag) => {
              const mode = currentTagMode(tag.id);
              return (
                <li key={tag.id} {...stylex.props(styles.tagRow)}>
                  <div {...stylex.props(styles.tagIdentity)}>
                    <span aria-hidden="true" {...stylex.props(styles.tagDot)} />
                    <span>
                      <strong {...stylex.props(styles.tagName)}>{tag.name}</strong>
                      <span {...stylex.props(styles.tagDescription)}>{tag.description}</span>
                    </span>
                  </div>
                  <label htmlFor={`${instanceId}-tag-${tag.id}`} {...stylex.props(styles.srOnly)}>
                    Review policy for {tag.name}
                  </label>
                  <select
                    id={`${instanceId}-tag-${tag.id}`}
                    value={mode ?? ""}
                    disabled={controlsDisabled}
                    onChange={(event) => void changeTagOverride(tag, event.target.value)}
                    {...stylex.props(styles.policySelect)}
                  >
                    <option value="">Inherit project policy</option>
                    <option value="required">Require human review</option>
                    <option value="direct">Complete directly</option>
                  </select>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog.Root open={retiringDefinition !== null} onOpenChange={changeRetireOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
          <Dialog.Popup initialFocus={retireReasonRef} {...stylex.props(styles.smallDialog)}>
            <DialogHeader
              title={`Retire ${retiringDefinition?.display.label ?? "custom field"}?`}
              description="The field disappears from active task forms. Existing task values are preserved."
              closeLabel="Close retire custom field"
              disabled={controlsDisabled}
            />
            {error ? <ErrorNotice error={error} /> : null}
            <form
              aria-label="Retire custom field"
              onSubmit={retireDefinition}
              {...stylex.props(styles.form)}
            >
              <Field
                label="Reason for retirement"
                htmlFor={`${instanceId}-retire-reason`}
                hint="Recorded in the project activity history."
              >
                <textarea
                  ref={retireReasonRef}
                  id={`${instanceId}-retire-reason`}
                  value={retireReason}
                  onChange={(event) => setRetireReason(event.target.value)}
                  rows={3}
                  maxLength={1_000}
                  required
                  disabled={controlsDisabled}
                  {...stylex.props(styles.textarea)}
                />
              </Field>
              <div {...stylex.props(styles.dialogActions)}>
                <Dialog.Close disabled={controlsDisabled} {...stylex.props(styles.secondaryButton)}>
                  Keep field
                </Dialog.Close>
                <button
                  type="submit"
                  disabled={controlsDisabled || retireReason.trim() === ""}
                  {...stylex.props(styles.dangerButton)}
                >
                  {pending?.startsWith("Retiring ") ? "Retiring…" : "Retire field"}
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

function DialogHeader({
  title,
  description,
  closeLabel,
  disabled,
}: {
  title: string;
  description: string;
  closeLabel: string;
  disabled: boolean;
}) {
  return (
    <header {...stylex.props(styles.dialogHeader)}>
      <div>
        <Dialog.Title {...stylex.props(styles.dialogTitle)}>{title}</Dialog.Title>
        <Dialog.Description {...stylex.props(styles.dialogDescription)}>
          {description}
        </Dialog.Description>
      </div>
      <Dialog.Close
        aria-label={closeLabel}
        disabled={disabled}
        {...stylex.props(styles.closeButton)}
      >
        <X size={16} aria-hidden="true" />
      </Dialog.Close>
    </header>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.field)}>
      <label htmlFor={htmlFor} {...stylex.props(styles.inputLabel)}>
        {label}
      </label>
      {children}
      {hint ? <span {...stylex.props(styles.hint)}>{hint}</span> : null}
    </div>
  );
}

function TypeConfiguration({
  draft,
  instanceId,
  onChange,
}: {
  draft: DraftState;
  instanceId: string;
  onChange: React.Dispatch<React.SetStateAction<DraftState>>;
}) {
  switch (draft.type) {
    case "text":
      return (
        <fieldset {...stylex.props(styles.configuration)}>
          <legend {...stylex.props(styles.configurationTitle)}>Text validation and default</legend>
          <div {...stylex.props(styles.twoColumns)}>
            <Field label="Minimum length" htmlFor={`${instanceId}-text-min`}>
              <input
                id={`${instanceId}-text-min`}
                type="number"
                min={0}
                max={MAX_CUSTOM_FIELD_TEXT_LENGTH}
                step={1}
                value={draft.textMinLength}
                onChange={(event) =>
                  onChange((current) => ({ ...current, textMinLength: event.target.value }))
                }
                required
                {...stylex.props(styles.input)}
              />
            </Field>
            <Field label="Maximum length" htmlFor={`${instanceId}-text-max`}>
              <input
                id={`${instanceId}-text-max`}
                type="number"
                min={0}
                max={MAX_CUSTOM_FIELD_TEXT_LENGTH}
                step={1}
                value={draft.textMaxLength}
                onChange={(event) =>
                  onChange((current) => ({ ...current, textMaxLength: event.target.value }))
                }
                required
                {...stylex.props(styles.input)}
              />
            </Field>
          </div>
          <Checkbox
            label="Set a text default"
            checked={draft.textHasDefault}
            onChange={(checked) => onChange((current) => ({ ...current, textHasDefault: checked }))}
          />
          {draft.textHasDefault ? (
            <Field label="Default text" htmlFor={`${instanceId}-text-default`}>
              <input
                id={`${instanceId}-text-default`}
                value={draft.textDefault}
                onChange={(event) =>
                  onChange((current) => ({ ...current, textDefault: event.target.value }))
                }
                maxLength={MAX_CUSTOM_FIELD_TEXT_LENGTH}
                {...stylex.props(styles.input)}
              />
            </Field>
          ) : null}
        </fieldset>
      );
    case "number":
      return (
        <fieldset {...stylex.props(styles.configuration)}>
          <legend {...stylex.props(styles.configurationTitle)}>
            Number validation and default
          </legend>
          <div {...stylex.props(styles.twoColumns)}>
            <Field label="Minimum number" htmlFor={`${instanceId}-number-min`}>
              <input
                id={`${instanceId}-number-min`}
                type="number"
                step="any"
                value={draft.numberMin}
                onChange={(event) =>
                  onChange((current) => ({ ...current, numberMin: event.target.value }))
                }
                {...stylex.props(styles.input)}
              />
            </Field>
            <Field label="Maximum number" htmlFor={`${instanceId}-number-max`}>
              <input
                id={`${instanceId}-number-max`}
                type="number"
                step="any"
                value={draft.numberMax}
                onChange={(event) =>
                  onChange((current) => ({ ...current, numberMax: event.target.value }))
                }
                {...stylex.props(styles.input)}
              />
            </Field>
          </div>
          <Checkbox
            label="Require whole numbers"
            checked={draft.numberInteger}
            onChange={(checked) => onChange((current) => ({ ...current, numberInteger: checked }))}
          />
          <Checkbox
            label="Set a number default"
            checked={draft.numberHasDefault}
            onChange={(checked) =>
              onChange((current) => ({ ...current, numberHasDefault: checked }))
            }
          />
          {draft.numberHasDefault ? (
            <Field label="Default number" htmlFor={`${instanceId}-number-default`}>
              <input
                id={`${instanceId}-number-default`}
                type="number"
                step="any"
                value={draft.numberDefault}
                onChange={(event) =>
                  onChange((current) => ({ ...current, numberDefault: event.target.value }))
                }
                required
                {...stylex.props(styles.input)}
              />
            </Field>
          ) : null}
        </fieldset>
      );
    case "boolean":
      return (
        <fieldset {...stylex.props(styles.configuration)}>
          <legend {...stylex.props(styles.configurationTitle)}>
            Boolean validation and default
          </legend>
          <p {...stylex.props(styles.configurationCopy)}>
            Boolean fields accept true or false and need no additional validation.
          </p>
          <Field label="Default boolean" htmlFor={`${instanceId}-boolean-default`}>
            <select
              id={`${instanceId}-boolean-default`}
              value={draft.booleanDefault}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "" || value === "true" || value === "false") {
                  onChange((current) => ({ ...current, booleanDefault: value }));
                }
              }}
              {...stylex.props(styles.input)}
            >
              <option value="">No default</option>
              <option value="true">True</option>
              <option value="false">False</option>
            </select>
          </Field>
        </fieldset>
      );
    case "date":
      return (
        <fieldset {...stylex.props(styles.configuration)}>
          <legend {...stylex.props(styles.configurationTitle)}>Date validation and default</legend>
          <div {...stylex.props(styles.twoColumns)}>
            <Field label="Earliest date" htmlFor={`${instanceId}-date-min`}>
              <input
                id={`${instanceId}-date-min`}
                type="date"
                value={draft.dateMin}
                onChange={(event) =>
                  onChange((current) => ({ ...current, dateMin: event.target.value }))
                }
                {...stylex.props(styles.input)}
              />
            </Field>
            <Field label="Latest date" htmlFor={`${instanceId}-date-max`}>
              <input
                id={`${instanceId}-date-max`}
                type="date"
                value={draft.dateMax}
                onChange={(event) =>
                  onChange((current) => ({ ...current, dateMax: event.target.value }))
                }
                {...stylex.props(styles.input)}
              />
            </Field>
          </div>
          <Field label="Default date" htmlFor={`${instanceId}-date-default`}>
            <input
              id={`${instanceId}-date-default`}
              type="date"
              value={draft.dateDefault}
              onChange={(event) =>
                onChange((current) => ({ ...current, dateDefault: event.target.value }))
              }
              {...stylex.props(styles.input)}
            />
          </Field>
        </fieldset>
      );
    case "single_select":
      return (
        <fieldset {...stylex.props(styles.configuration)}>
          <legend {...stylex.props(styles.configurationTitle)}>
            Single-select validation and default
          </legend>
          <Field
            label="Options"
            htmlFor={`${instanceId}-select-options`}
            hint="One stable identifier and label per line, for example: high: High"
          >
            <textarea
              id={`${instanceId}-select-options`}
              value={draft.selectOptions}
              onChange={(event) =>
                onChange((current) => ({ ...current, selectOptions: event.target.value }))
              }
              placeholder={"low: Low\nhigh: High"}
              rows={4}
              required
              {...stylex.props(styles.textarea)}
            />
          </Field>
          <Field
            label="Default option identifier"
            htmlFor={`${instanceId}-select-default`}
            hint="Leave blank for no default."
          >
            <input
              id={`${instanceId}-select-default`}
              value={draft.selectDefault}
              onChange={(event) =>
                onChange((current) => ({ ...current, selectDefault: event.target.value }))
              }
              placeholder="low"
              maxLength={80}
              {...stylex.props(styles.input)}
            />
          </Field>
        </fieldset>
      );
  }
  const unhandled: never = draft.type;
  throw new Error(`Unsupported custom-field type: ${String(unhandled)}`);
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label {...stylex.props(styles.checkboxLabel)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        {...stylex.props(styles.checkbox)}
      />
      {label}
    </label>
  );
}

function DefinitionList({
  title,
  description,
  definitions,
  emptyMessage,
  retired = false,
  disabled,
  onMove,
  onRetire,
}: {
  title: string;
  description: string;
  definitions: readonly CustomFieldDefinition[];
  emptyMessage: string;
  retired?: boolean;
  disabled: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onRetire: (definition: CustomFieldDefinition) => void;
}) {
  return (
    <section aria-label={title} {...stylex.props(styles.definitionGroup)}>
      <div {...stylex.props(styles.listHeader)}>
        <div>
          <h4 {...stylex.props(styles.listTitle)}>{title}</h4>
          <p {...stylex.props(styles.listDescription)}>{description}</p>
        </div>
        <span {...stylex.props(styles.count)}>{definitions.length}</span>
      </div>
      {definitions.length === 0 ? (
        <p {...stylex.props(styles.empty)}>{emptyMessage}</p>
      ) : (
        <ol aria-label={title} {...stylex.props(styles.definitionList)}>
          {definitions.map((definition, index) => (
            <li
              key={definition.id}
              {...stylex.props(styles.definitionCard, retired && styles.retiredCard)}
            >
              <div {...stylex.props(styles.definitionContent)}>
                <div {...stylex.props(styles.definitionHeading)}>
                  <strong {...stylex.props(styles.definitionLabel)}>
                    {definition.display.label}
                  </strong>
                  <span {...stylex.props(styles.typeBadge)}>{fieldTypeLabel(definition.type)}</span>
                  {retired ? <span {...stylex.props(styles.retiredBadge)}>Retired</span> : null}
                </div>
                <code {...stylex.props(styles.machineKey)}>{definition.key}</code>
                {definition.display.description ? (
                  <p {...stylex.props(styles.definitionDescription)}>
                    {definition.display.description}
                  </p>
                ) : null}
                <p {...stylex.props(styles.definitionMetadata)}>
                  <span>{validationLabel(definition)}</span>
                  <span aria-hidden="true">·</span>
                  <span>Default: {defaultLabel(definition.defaultValue)}</span>
                  <span aria-hidden="true">·</span>
                  <span>Position {definition.position + 1}</span>
                </p>
              </div>
              {!retired ? (
                <div
                  aria-label={`Actions for ${definition.display.label}`}
                  {...stylex.props(styles.cardActions)}
                >
                  <button
                    type="button"
                    aria-label={`Move ${definition.display.label} up`}
                    title="Move up"
                    disabled={disabled || index === 0}
                    onClick={() => onMove(index, -1)}
                    {...stylex.props(styles.iconButton)}
                  >
                    <ArrowUp size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${definition.display.label} down`}
                    title="Move down"
                    disabled={disabled || index === definitions.length - 1}
                    onClick={() => onMove(index, 1)}
                    {...stylex.props(styles.iconButton)}
                  >
                    <ArrowDown size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onRetire(definition)}
                    {...stylex.props(styles.retireButton)}
                  >
                    <Archive size={14} aria-hidden="true" />
                    Retire {definition.display.label}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ErrorNotice({ error }: { error: VisibleError }) {
  const conflict = error.type === "CustomizationVersionConflictError";
  return (
    <div role="alert" {...stylex.props(styles.errorNotice)}>
      <strong {...stylex.props(styles.errorTitle)}>
        {conflict ? "Configuration version conflict" : "Configuration was not saved"}
      </strong>
      <p {...stylex.props(styles.errorMessage)}>{error.message}</p>
      {"issues" in error && error.issues?.length ? (
        <ul {...stylex.props(styles.errorDetails)}>
          {error.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {conflict ? (
        <div {...stylex.props(styles.conflictDetails)}>
          <span>Displayed version: {error.expectedVersion}</span>
          <span>Current server version: {error.currentVersion}</span>
          {error.changeSummary ? <span>{error.changeSummary}</span> : null}
          <span>Reload the project configuration before retrying.</span>
        </div>
      ) : null}
    </div>
  );
}

const interactiveFocus = {
  ":focus-visible": {
    outlineColor: tokens.accent,
    outlineOffset: 2,
    outlineStyle: "solid",
    outlineWidth: 2,
  },
} as const;

const styles = stylex.create({
  root: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    display: "grid",
    gap: tokens.space5,
    padding: tokens.space5,
  },
  header: {
    alignItems: "start",
    display: "flex",
    gap: tokens.space4,
    justifyContent: "space-between",
    "@media (max-width: 600px)": { alignItems: "stretch", flexDirection: "column" },
  },
  headingGroup: { alignItems: "start", display: "flex", gap: tokens.space3 },
  headingIcon: {
    alignItems: "center",
    backgroundColor: tokens.surfaceMuted,
    borderRadius: tokens.radius2,
    color: tokens.accent,
    display: "inline-flex",
    justifyContent: "center",
    minHeight: 36,
    minWidth: 36,
  },
  title: { fontSize: 20, fontWeight: 760, letterSpacing: "-0.02em", margin: 0 },
  subtitle: {
    color: tokens.foregroundMuted,
    fontSize: 13,
    lineHeight: 1.5,
    marginBlockEnd: 0,
    marginBlockStart: tokens.space1,
  },
  versionBadge: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: 999,
    color: tokens.foregroundMuted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
    fontWeight: 700,
    paddingBlock: 6,
    paddingInline: tokens.space3,
    whiteSpace: "nowrap",
  },
  status: { color: tokens.foregroundMuted, fontSize: 12, margin: 0, minHeight: 18 },
  sectionHeading: {
    alignItems: "end",
    display: "flex",
    gap: tokens.space4,
    justifyContent: "space-between",
    "@media (max-width: 600px)": { alignItems: "stretch", flexDirection: "column" },
  },
  sectionTitle: { fontSize: 16, fontWeight: 750, margin: 0 },
  sectionCopy: {
    color: tokens.foregroundMuted,
    fontSize: 12,
    lineHeight: 1.5,
    marginBlockEnd: 0,
    marginBlockStart: tokens.space1,
  },
  primaryButton: {
    ...interactiveFocus,
    alignItems: "center",
    backgroundColor: tokens.accent,
    borderColor: tokens.accent,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.background,
    cursor: "pointer",
    display: "inline-flex",
    fontSize: 13,
    fontWeight: 700,
    gap: tokens.space1,
    justifyContent: "center",
    minHeight: 36,
    paddingInline: tokens.space3,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":hover": { opacity: 0.88 },
  },
  secondaryButton: {
    ...interactiveFocus,
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
    minHeight: 36,
    paddingInline: tokens.space3,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":hover": { borderColor: tokens.accent },
  },
  dangerButton: {
    ...interactiveFocus,
    alignItems: "center",
    backgroundColor: tokens.danger,
    borderColor: tokens.danger,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.background,
    cursor: "pointer",
    display: "inline-flex",
    fontSize: 13,
    fontWeight: 700,
    justifyContent: "center",
    minHeight: 36,
    paddingInline: tokens.space3,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":hover": { opacity: 0.88 },
  },
  limitNote: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: tokens.radius2,
    color: tokens.foregroundMuted,
    fontSize: 12,
    margin: 0,
    padding: tokens.space3,
  },
  definitionGroups: { display: "grid", gap: tokens.space4 },
  definitionGroup: {
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    overflow: "hidden",
  },
  listHeader: {
    alignItems: "start",
    backgroundColor: tokens.surfaceMuted,
    display: "flex",
    gap: tokens.space3,
    justifyContent: "space-between",
    padding: tokens.space3,
  },
  listTitle: { fontSize: 13, fontWeight: 750, margin: 0 },
  listDescription: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    lineHeight: 1.45,
    marginBlockEnd: 0,
    marginBlockStart: 2,
  },
  count: {
    backgroundColor: tokens.surface,
    borderRadius: 999,
    color: tokens.foregroundMuted,
    fontSize: 11,
    fontWeight: 700,
    minWidth: 24,
    paddingBlock: 3,
    paddingInline: 7,
    textAlign: "center",
  },
  definitionList: { display: "grid", listStyle: "none", margin: 0, padding: 0 },
  definitionCard: {
    alignItems: "center",
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    display: "grid",
    gap: tokens.space4,
    gridTemplateColumns: "minmax(0, 1fr) auto",
    padding: tokens.space3,
    ":first-child": { borderBlockStartWidth: 0 },
    "@media (max-width: 720px)": { alignItems: "stretch", gridTemplateColumns: "1fr" },
  },
  retiredCard: { opacity: 0.72 },
  definitionContent: { display: "grid", gap: tokens.space1, minWidth: 0 },
  definitionHeading: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.space2,
  },
  definitionLabel: { fontSize: 14 },
  typeBadge: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: 999,
    color: tokens.foregroundMuted,
    fontSize: 10,
    fontWeight: 700,
    paddingBlock: 2,
    paddingInline: 7,
  },
  retiredBadge: {
    borderColor: tokens.border,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    fontSize: 10,
    fontWeight: 700,
    paddingBlock: 1,
    paddingInline: 7,
  },
  machineKey: {
    color: tokens.accent,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
  },
  definitionDescription: {
    color: tokens.foregroundMuted,
    fontSize: 12,
    lineHeight: 1.45,
    margin: 0,
  },
  definitionMetadata: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    flexWrap: "wrap",
    fontSize: 10,
    gap: tokens.space1,
    margin: 0,
  },
  cardActions: { alignItems: "center", display: "flex", gap: tokens.space1 },
  iconButton: {
    ...interactiveFocus,
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "inline-flex",
    justifyContent: "center",
    minHeight: 32,
    minWidth: 32,
    padding: 0,
    ":disabled": { cursor: "not-allowed", opacity: 0.35 },
    ":hover": { borderColor: tokens.accent },
  },
  retireButton: {
    ...interactiveFocus,
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.danger,
    cursor: "pointer",
    display: "inline-flex",
    fontSize: 11,
    fontWeight: 700,
    gap: tokens.space1,
    minHeight: 32,
    paddingInline: tokens.space2,
    ":disabled": { cursor: "not-allowed", opacity: 0.35 },
    ":hover": { borderColor: tokens.danger },
  },
  empty: { color: tokens.foregroundMuted, fontSize: 12, margin: 0, padding: tokens.space3 },
  tagSection: { display: "grid", gap: tokens.space3 },
  tagList: {
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  tagRow: {
    alignItems: "center",
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    display: "grid",
    gap: tokens.space4,
    gridTemplateColumns: "minmax(0, 1fr) minmax(220px, 300px)",
    padding: tokens.space3,
    ":first-child": { borderBlockStartWidth: 0 },
    "@media (max-width: 640px)": { alignItems: "stretch", gridTemplateColumns: "1fr" },
  },
  tagIdentity: {
    alignItems: "center",
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "8px 1fr",
  },
  tagDot: { backgroundColor: tokens.accent, borderRadius: 999, height: 8, width: 8 },
  tagName: { display: "block", fontSize: 13 },
  tagDescription: {
    color: tokens.foregroundMuted,
    display: "block",
    fontSize: 11,
    marginBlockStart: 2,
  },
  policySelect: {
    ...interactiveFocus,
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    minHeight: 36,
    paddingInline: tokens.space2,
    width: "100%",
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
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
    gap: tokens.space4,
    left: "50%",
    maxHeight: "calc(100dvh - 32px)",
    maxWidth: "calc(100vw - 32px)",
    overflowY: "auto",
    padding: tokens.space5,
    position: "fixed",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: 620,
    zIndex: 51,
  },
  smallDialog: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    color: tokens.foreground,
    display: "grid",
    gap: tokens.space4,
    left: "50%",
    maxHeight: "calc(100dvh - 32px)",
    maxWidth: "calc(100vw - 32px)",
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
  dialogTitle: { fontSize: 20, fontWeight: 760, letterSpacing: "-0.02em", margin: 0 },
  dialogDescription: {
    color: tokens.foregroundMuted,
    fontSize: 13,
    lineHeight: 1.5,
    marginBlockEnd: 0,
    marginBlockStart: tokens.space1,
  },
  closeButton: {
    ...interactiveFocus,
    alignItems: "center",
    backgroundColor: tokens.surfaceMuted,
    borderColor: "transparent",
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    justifyContent: "center",
    minHeight: 32,
    minWidth: 32,
    padding: 0,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":hover": { borderColor: tokens.border },
  },
  form: { display: "grid", gap: tokens.space4 },
  fieldset: { border: 0, display: "grid", gap: tokens.space3, margin: 0, minWidth: 0, padding: 0 },
  field: { display: "grid", gap: tokens.space1, minWidth: 0 },
  twoColumns: {
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    "@media (max-width: 520px)": { gridTemplateColumns: "1fr" },
  },
  inputLabel: { fontSize: 12, fontWeight: 700 },
  input: {
    ...interactiveFocus,
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    fontSize: 13,
    minHeight: 38,
    paddingInline: tokens.space2,
    width: "100%",
    ":disabled": { cursor: "not-allowed", opacity: 0.5 },
  },
  textarea: {
    ...interactiveFocus,
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    fontFamily: "inherit",
    fontSize: 13,
    lineHeight: 1.45,
    minHeight: 72,
    padding: tokens.space2,
    resize: "vertical",
    width: "100%",
    ":disabled": { cursor: "not-allowed", opacity: 0.5 },
  },
  hint: { color: tokens.foregroundMuted, fontSize: 10, lineHeight: 1.4 },
  configuration: {
    backgroundColor: tokens.surfaceMuted,
    border: 0,
    borderRadius: tokens.radius2,
    display: "grid",
    gap: tokens.space3,
    margin: 0,
    minWidth: 0,
    padding: tokens.space3,
  },
  configurationTitle: { fontSize: 12, fontWeight: 750, padding: 0 },
  configurationCopy: { color: tokens.foregroundMuted, fontSize: 11, lineHeight: 1.45, margin: 0 },
  checkboxLabel: {
    alignItems: "center",
    display: "flex",
    fontSize: 12,
    fontWeight: 650,
    gap: tokens.space2,
  },
  checkbox: { ...interactiveFocus, accentColor: tokens.accent, height: 16, margin: 0, width: 16 },
  dialogActions: { display: "flex", gap: tokens.space2, justifyContent: "flex-end" },
  errorNotice: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.danger,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 3,
    borderRadius: 6,
    color: tokens.danger,
    display: "grid",
    gap: tokens.space1,
    padding: tokens.space3,
  },
  errorTitle: { fontSize: 13 },
  errorMessage: { fontSize: 12, lineHeight: 1.45, margin: 0 },
  errorDetails: {
    display: "grid",
    fontSize: 11,
    gap: 2,
    margin: 0,
    paddingInlineStart: tokens.space4,
  },
  conflictDetails: { display: "grid", fontSize: 11, gap: 2 },
  srOnly: {
    clip: "rect(0, 0, 0, 0)",
    clipPath: "inset(50%)",
    height: 1,
    overflow: "hidden",
    position: "absolute",
    whiteSpace: "nowrap",
    width: 1,
  },
});
