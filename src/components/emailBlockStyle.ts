import { Extension } from "@tiptap/core";

/**
 * Alignment and indent for paragraphs and headings — the two block controls on
 * Outlook's ribbon (Sean, 2026-10-15: "Can we not build this as our email editor?").
 *
 * Written as inline styles (text-align, margin-left), because that is all a mail
 * client reliably honours; a class would mean nothing in the customer's inbox.
 * One small extension rather than another package: it is two attributes.
 */

export const EMAIL_INDENT_STEP_PX = 40;
const MAX_INDENT = 6;
const ALIGNMENTS = ["left", "center", "right", "justify"] as const;
export type EmailAlignment = (typeof ALIGNMENTS)[number];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    emailBlockStyle: {
      setEmailAlign: (align: EmailAlignment) => ReturnType;
      indentEmailBlock: () => ReturnType;
      outdentEmailBlock: () => ReturnType;
    };
  }
}

const TYPES = ["paragraph", "heading"];

export const EmailBlockStyle = Extension.create({
  name: "emailBlockStyle",
  addGlobalAttributes() {
    return [
      {
        types: TYPES,
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) => {
              const align = element.style.textAlign;
              return (ALIGNMENTS as readonly string[]).includes(align) && align !== "left" ? align : null;
            },
            renderHTML: (attrs) => (attrs.textAlign ? { style: `text-align:${attrs.textAlign}` } : {}),
          },
          indent: {
            default: 0,
            parseHTML: (element) => Math.min(MAX_INDENT, Math.max(0, Math.round((parseInt(element.style.marginLeft, 10) || 0) / EMAIL_INDENT_STEP_PX))),
            renderHTML: (attrs) => (attrs.indent ? { style: `margin-left:${attrs.indent * EMAIL_INDENT_STEP_PX}px` } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    // Every paragraph or heading the selection touches.
    const eachBlock = (change: (attrs: Record<string, unknown>) => Record<string, unknown>) =>
      ({ tr, state, dispatch }: { tr: import("@tiptap/pm/state").Transaction; state: import("@tiptap/pm/state").EditorState; dispatch?: (tr: import("@tiptap/pm/state").Transaction) => void }) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!TYPES.includes(node.type.name)) return;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...change(node.attrs) });
          changed = true;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };
    return {
      setEmailAlign: (align) => eachBlock(() => ({ textAlign: align === "left" ? null : align })),
      indentEmailBlock: () => eachBlock((attrs) => ({ indent: Math.min(MAX_INDENT, (Number(attrs.indent) || 0) + 1) })),
      outdentEmailBlock: () => eachBlock((attrs) => ({ indent: Math.max(0, (Number(attrs.indent) || 0) - 1) })),
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-]": () => this.editor.commands.indentEmailBlock(),
      "Mod-[": () => this.editor.commands.outdentEmailBlock(),
    };
  },
});

/**
 * A pasted or chosen picture, made ready for an email: shrunk to at most
 * `maxWidth` pixels across and re-encoded, so a full-screen screenshot does not
 * go out at full size. PNG keeps a screenshot's text crisp; a photo, or a PNG
 * that is still too big, becomes JPEG. Null when the browser cannot read it.
 */
export async function emailReadyImage(file: Blob, maxWidth = 1600, maxBytes = 2.5 * 1024 * 1024): Promise<string | null> {
  if (!/^image\/(png|jpeg|gif|webp)$/i.test(file.type)) return null;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = canvas.toDataURL("image/png");
  // base64 is 4 characters per 3 bytes.
  if (file.type !== "image/jpeg" && png.length * 0.75 <= maxBytes) return png;
  for (const quality of [0.86, 0.75, 0.6]) {
    const jpeg = canvas.toDataURL("image/jpeg", quality);
    if (jpeg.length * 0.75 <= maxBytes) return jpeg;
  }
  return null;
}
