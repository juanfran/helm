import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
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
