import { describe, expect, it } from "vitest";

import { richTextDocumentSchema, richTextToPlainText } from "./rich-text";

describe("rich text", () => {
  it.each([
    [
      "document wrapper",
      {
        version: 1,
        doc: { type: "doc", content: [] },
        source: "untrusted-import",
      },
      [],
    ],
    [
      "document node",
      {
        version: 1,
        doc: { type: "doc", content: [], source: "untrusted-import" },
      },
      ["doc"],
    ],
    [
      "nested content node",
      {
        version: 1,
        doc: {
          type: "doc",
          content: [{ type: "paragraph", source: "untrusted-import" }],
        },
      },
      ["doc", "content", 0],
    ],
    [
      "nested mark",
      {
        version: 1,
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Helm",
                  marks: [{ type: "strong", source: "untrusted-import" }],
                },
              ],
            },
          ],
        },
      },
      ["doc", "content", 0, "content", 0, "marks", 0],
    ],
  ])("rejects unknown structural keys on the %s", (_label, input, expectedPath) => {
    const result = richTextDocumentSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        code: "unrecognized_keys",
        keys: ["source"],
        path: expectedPath,
      }),
    );
  });

  it("accepts extension-owned JSON attributes without weakening structural validation", () => {
    const input = {
      version: 1,
      doc: {
        type: "doc",
        attrs: {
          extensionState: {
            enabled: true,
            mode: null,
            weights: [1, 2.5],
          },
        },
        content: [
          {
            type: "heading",
            attrs: { level: 2, textAlign: "center" },
            content: [
              {
                type: "text",
                text: "Portable work",
                marks: [
                  {
                    type: "link",
                    attrs: {
                      href: "https://example.test/work",
                      metadata: { imported: true, labels: ["portable", "safe"] },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    expect(richTextDocumentSchema.parse(input)).toEqual(input);
  });

  it("projects supported rich text to stable plain text", () => {
    const document = richTextDocumentSchema.parse({
      version: 1,
      doc: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Release plan" }],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Ship", marks: [{ type: "strong" }] },
              { type: "hardBreak" },
              { type: "text", text: "safely" },
            ],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Preview" }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Import" }] }],
              },
            ],
          },
        ],
      },
    });

    expect(richTextToPlainText(document)).toBe("Release plan\nShip\nsafely\nPreview\nImport");
  });
});
