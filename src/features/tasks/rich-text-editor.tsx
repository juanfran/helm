import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import * as stylex from "@stylexjs/stylex";
import { Bold, List } from "lucide-react";

import type { RichTextDocument } from "../../domain/tasks";
import { tokens } from "../../styles/tokens.stylex";

export function RichTextEditor({
  value,
  onChange,
  editable = true,
}: {
  value: RichTextDocument;
  onChange: (document: RichTextDocument) => void;
  editable?: boolean;
}) {
  const contentClassName = stylex.props(styles.content).className;
  const editor = useEditor({
    extensions: [StarterKit],
    content: value.doc,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        ...(contentClassName ? { class: contentClassName } : {}),
        "aria-label": "Description",
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      onChange({ version: 1, doc: currentEditor.getJSON() as RichTextDocument["doc"] });
    },
  });

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editable, editor]);

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.toolbar)} aria-label="Description formatting">
        <button
          type="button"
          aria-label="Bold"
          aria-pressed={editor?.isActive("bold") ?? false}
          disabled={!editable}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          {...stylex.props(styles.tool)}
        >
          <Bold size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Bullet list"
          aria-pressed={editor?.isActive("bulletList") ?? false}
          disabled={!editable}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          {...stylex.props(styles.tool)}
        >
          <List size={15} aria-hidden="true" />
        </button>
      </div>
      <EditorContent editor={editor} {...stylex.props(styles.editor)} />
    </div>
  );
}

const styles = stylex.create({
  root: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    overflow: "hidden",
    ":focus-within": { borderColor: tokens.accent },
  },
  toolbar: {
    alignItems: "center",
    backgroundColor: tokens.surfaceMuted,
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "flex",
    gap: tokens.space1,
    padding: tokens.space1,
  },
  tool: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: 5,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    cursor: "pointer",
    display: "inline-flex",
    height: 30,
    justifyContent: "center",
    width: 30,
    ":hover": { backgroundColor: tokens.surface, color: tokens.foreground },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  editor: { minHeight: 116 },
  content: {
    color: tokens.foreground,
    lineHeight: 1.55,
    minHeight: 116,
    outline: "none",
    padding: tokens.space3,
  },
});
