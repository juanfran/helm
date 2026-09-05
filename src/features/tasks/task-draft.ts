import { useEffect, useState, type SetStateAction } from "react";
import { z } from "zod";

import { customFieldValueSchema } from "../../domain/customization";
import {
  richTextDocumentSchema,
  tagInputSchema,
  taskPrioritySchema,
  type Task,
} from "../../domain/tasks";

const fieldsSchema = z.object({
  title: z.string(),
  description: richTextDocumentSchema,
  expectedOutcome: z.string(),
  acceptanceCriteria: z.string(),
  agentContext: z.string(),
  checklist: z.string(),
  priority: taskPrioritySchema,
  position: z.string(),
  notBefore: z.string(),
  dueAt: z.string(),
  size: z.string(),
  tagInputs: z.array(
    tagInputSchema.extend({
      draftId: z.string(),
      name: z.string(),
      description: z.string(),
      color: z.string(),
    }),
  ),
  requiredCapabilities: z.string(),
  referencedPaths: z.string(),
  customFieldValues: z.record(z.string(), customFieldValueSchema.nullable()),
});
const draftSchema = z.object({ baseVersion: z.number(), base: fieldsSchema, values: fieldsSchema });
type Fields = z.infer<typeof fieldsSchema>;
type Draft = z.infer<typeof draftSchema>;
const memoryDrafts = new Map<string, Draft>();

/** Keep completion evidence and identity when editing other fields or reordering checklist lines. */
export function reconcileChecklist(text: string, saved: Task["checklist"]): Task["checklist"] {
  const remaining = [...saved];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = remaining.findIndex((item) => item.text === line);
      if (index >= 0) return remaining.splice(index, 1)[0]!;
      return { id: crypto.randomUUID(), text: line, checked: false };
    });
}

export function taskDraftFields(task: Task): Fields {
  return {
    title: task.title,
    description: task.description,
    expectedOutcome: task.expectedOutcome,
    acceptanceCriteria: task.acceptanceCriteria,
    agentContext: task.agentContext,
    checklist: task.checklist.map((item) => item.text).join("\n"),
    priority: task.priority,
    position: String(task.position),
    notBefore: task.notBefore ?? "",
    dueAt: task.dueAt ?? "",
    size: task.size ?? "",
    requiredCapabilities: task.requiredCapabilities.join("\n"),
    referencedPaths: task.referencedPaths.join("\n"),
    tagInputs: task.tags.map(({ id, name, description, color, exclusiveGroup }) => ({
      draftId: id,
      name,
      description,
      color,
      exclusiveGroup,
    })),
    customFieldValues: Object.fromEntries(
      task.customFields.map((assignment) => [
        assignment.definition.id,
        assignment.source === "explicit" ? assignment.value : null,
      ]),
    ),
  };
}

function freshDraft(task: Task): Draft {
  const values = taskDraftFields(task);
  return { baseVersion: task.version, base: values, values };
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function useTaskDraft(task: Task) {
  const key = `helm.task-draft.v1.${task.projectId}.${task.id}`;
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [draft, setDraft] = useState<Draft>(() => {
    const memory = memoryDrafts.get(key);
    if (memory) return memory;
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) {
        const parsed = draftSchema.safeParse(JSON.parse(saved));
        if (parsed.success) return parsed.data;
      }
    } catch {
      /* The live form remains usable without browser storage. */
    }
    return freshDraft(task);
  });
  const dirty = !same(draft.values, draft.base);
  const conflict = dirty && draft.baseVersion < task.version;

  if (!dirty && draft.baseVersion < task.version) setDraft(freshDraft(task));

  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(key, JSON.stringify(draft));
      else sessionStorage.removeItem(key);
      memoryDrafts.delete(key);
      // oxlint-disable-next-line react/set-state-in-effect -- Reflect the result of synchronizing with browser storage.
      setStorageAvailable(true);
    } catch {
      if (dirty) memoryDrafts.set(key, draft);
      else memoryDrafts.delete(key);
      setStorageAvailable(false);
    }
  }, [draft, dirty, key]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function field<K extends keyof Fields>(
    name: K,
  ): [Fields[K], (value: SetStateAction<Fields[K]>) => void] {
    return [
      draft.values[name],
      (value) =>
        setDraft((current) => ({
          ...current,
          values: {
            ...current.values,
            [name]: typeof value === "function" ? value(current.values[name]) : value,
          },
        })),
    ];
  }

  function rebase() {
    const latest = taskDraftFields(task);
    // Only locally edited fields replace the latest version; unrelated agent changes survive.
    const edits = Object.fromEntries(
      Object.entries(draft.values).filter(
        ([name, value]) => !same(value, Reflect.get(draft.base, name)),
      ),
    );
    setDraft({
      baseVersion: task.version,
      base: latest,
      values: fieldsSchema.parse({ ...latest, ...edits }),
    });
  }

  return {
    field,
    dirty,
    conflict,
    storageAvailable,
    baseVersion: draft.baseVersion,
    accept: (saved: Task) => setDraft(freshDraft(saved)),
    discard: () => setDraft(freshDraft(task)),
    rebase,
  };
}
