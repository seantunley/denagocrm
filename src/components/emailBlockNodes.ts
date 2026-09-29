"use client";

/**
 * Tiptap nodes for the email building blocks — the editor half.
 *
 * Why NODES rather than `insertContent(html)`: Tiptap parses inserted HTML into
 * its schema and drops every attribute the schema does not know, so a pasted
 * bulletproof button would come back out of `getHTML()` stripped of the inline
 * styles that made it bulletproof. An atom node owns its markup: `renderHTML`
 * emits the exact table (via the pure generators in `@/lib/emailBlockHtml`, so
 * editor output and send output cannot drift), and `parseHTML` recognises that
 * table by its `data-email-block` marker when a saved template is reopened —
 * giving the author back an editable block, not frozen table soup.
 *
 * All three are atoms: selectable, draggable, deletable as one unit, with their
 * parameters living in attributes rather than in editable text.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import {
  emailButtonHtml,
  emailDividerHtml,
  emailSpacerHtml,
  type EmailButtonAlign,
} from "@/lib/emailBlockHtml";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    emailBlocks: {
      insertEmailButton: (attrs: { label: string; url: string; color?: string; align?: EmailButtonAlign }) => ReturnType;
      updateEmailButton: (attrs: { label: string; url: string; color?: string; align?: EmailButtonAlign }) => ReturnType;
      insertEmailDivider: () => ReturnType;
      insertEmailSpacer: (height?: number) => ReturnType;
    };
  }
}

/**
 * Turn one generator's output into what ProseMirror renders.
 *
 * A real DOM node, parsed from the generator string, so the editor shows and
 * `getHTML()` emits EXACTLY what will be sent. The editor never renders on the
 * server (`immediatelyRender: false`), so `document` is present on every path
 * that matters — but a guard beats a build-time crash if that ever changes: the
 * fallback emits the marker table, which parses back into the same node.
 */
function domFromHtml(html: string, fallbackMarker: string): { dom: HTMLElement } | [string, Record<string, string>] {
  if (typeof document === "undefined") return ["table", { "data-email-block": fallbackMarker }];
  const template = document.createElement("template");
  template.innerHTML = html;
  return { dom: template.content.firstElementChild as HTMLElement };
}

export const EmailButton = Node.create({
  name: "emailButton",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      label: { default: "Open" },
      url: { default: "#" },
      color: { default: undefined },
      align: { default: "center" },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'table[data-email-block="button"]',
        getAttrs: (element) => ({
          label: element.getAttribute("data-label") ?? "Open",
          url: element.getAttribute("data-url") ?? "#",
          color: element.getAttribute("data-color") ?? undefined,
          align: element.getAttribute("data-align") === "left" ? "left" : "center",
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return domFromHtml(
      emailButtonHtml({
        label: String(node.attrs.label ?? ""),
        url: String(node.attrs.url ?? ""),
        color: node.attrs.color ? String(node.attrs.color) : undefined,
        align: node.attrs.align === "left" ? "left" : "center",
      }),
      "button",
    );
  },

  addCommands() {
    return {
      insertEmailButton:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
      updateEmailButton:
        (attrs) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, attrs),
    };
  },
});

export const EmailDivider = Node.create({
  name: "emailDivider",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'table[data-email-block="divider"]' }];
  },

  renderHTML() {
    return domFromHtml(emailDividerHtml(), "divider");
  },

  addCommands() {
    return {
      insertEmailDivider:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
});

export const EmailSpacer = Node.create({
  name: "emailSpacer",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      height: { default: 24 },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'table[data-email-block="spacer"]',
        getAttrs: (element) => ({ height: Number(element.getAttribute("data-height")) || 24 }),
      },
    ];
  },

  renderHTML({ node }) {
    return domFromHtml(emailSpacerHtml(Number(node.attrs.height) || 24), "spacer");
  },

  addCommands() {
    return {
      insertEmailSpacer:
        (height = 24) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { height } }),
    };
  },
});

// mergeAttributes is unused today but re-exported so a future block does not
// re-derive how Tiptap composes attribute sets.
export { mergeAttributes };
