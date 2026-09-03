import { z } from "zod";

export const actorSchema = z.object({
  type: z.enum(["human", "agent", "system"]),
  id: z.string().trim().min(1),
});
export type Actor = z.infer<typeof actorSchema>;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

type TipTapNode = {
  type: string;
  text?: string;
  attrs?: Record<string, JsonValue>;
  marks?: Array<{ type: string; attrs?: Record<string, JsonValue> }>;
  content?: TipTapNode[];
};

const tipTapNodeSchema: z.ZodType<TipTapNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    attrs: z.record(z.string(), jsonValueSchema).optional(),
    marks: z
      .array(
        z.object({
          type: z.string(),
          attrs: z.record(z.string(), jsonValueSchema).optional(),
        }),
      )
      .optional(),
    content: z.array(tipTapNodeSchema).optional(),
  }),
);

export const richTextDocumentSchema = z.object({
  version: z.literal(1),
  doc: z.object({
    type: z.literal("doc"),
    content: z.array(tipTapNodeSchema).optional(),
  }),
});
export type RichTextDocument = z.infer<typeof richTextDocumentSchema>;

export const emptyRichTextDocument: RichTextDocument = {
  version: 1,
  doc: { type: "doc", content: [] },
};

export const checklistItemSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  checked: z.boolean(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sequence: z.number().int().positive(),
  title: z.string(),
  lifecycle: z.enum(["backlog", "ready"]),
  description: richTextDocumentSchema,
  descriptionText: z.string(),
  expectedOutcome: z.string(),
  acceptanceCriteria: z.string(),
  agentContext: z.string(),
  checklist: z.array(checklistItemSchema),
  version: z.number().int().positive(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

const taskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: richTextDocumentSchema,
  expectedOutcome: z.string().trim().max(10_000),
  acceptanceCriteria: z.string().trim().max(20_000),
  agentContext: z.string().trim().max(20_000),
  checklist: z.array(checklistItemSchema).max(200),
});

export const createTaskInputSchema = taskFieldsSchema.extend({
  projectId: z.string().trim().min(1),
  lifecycle: z.enum(["backlog", "ready"]),
  expectedVersion: z.literal(0),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const prepareTaskInputSchema = taskFieldsSchema.extend({
  taskId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type PrepareTaskInput = z.infer<typeof prepareTaskInputSchema>;

export const archiveTaskInputSchema = z.object({
  taskId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type ArchiveTaskInput = z.infer<typeof archiveTaskInputSchema>;

export const listTasksInputSchema = z.object({
  projectId: z.string().trim().min(1),
  includeArchived: z.boolean().optional().default(false),
});
export type ListTasksInput = z.infer<typeof listTasksInputSchema>;

export const compiledCreateTaskInputSchema = z.compile(createTaskInputSchema);
export const compiledPrepareTaskInputSchema = z.compile(prepareTaskInputSchema);
export const compiledArchiveTaskInputSchema = z.compile(archiveTaskInputSchema);
export const compiledListTasksInputSchema = z.compile(listTasksInputSchema);

function nodePlainText(value: unknown): string {
  const parsed = tipTapNodeSchema.safeParse(value);
  if (!parsed.success) return "";
  if (parsed.data.type === "hardBreak") return "\n";
  if (parsed.data.text) return parsed.data.text;
  const children = parsed.data.content ?? [];
  const separator = ["doc", "bulletList", "orderedList", "listItem", "blockquote"].includes(
    parsed.data.type,
  )
    ? "\n"
    : "";
  return children.map(nodePlainText).filter(Boolean).join(separator);
}

export function richTextToPlainText(document: RichTextDocument) {
  return nodePlainText(document.doc)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const readyPreparationFields = [
  "expectedOutcome",
  "acceptanceCriteria",
  "checklist",
] as const;

export function missingReadyPreparation(input: {
  expectedOutcome: string;
  acceptanceCriteria: string;
  checklist: readonly ChecklistItem[];
}) {
  return readyPreparationFields.filter((field) => {
    if (field === "checklist") return input.checklist.length === 0;
    return input[field].trim().length === 0;
  });
}
