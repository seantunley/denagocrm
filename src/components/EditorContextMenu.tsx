"use client";

import { useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TextPromptDialog } from "@/components/TextPromptDialog";
import { pasteKind } from "@/lib/clipboardPaste";

/**
 * Right-click inside a message: Cut, Copy, Paste, links, tables — Outlook's menu
 * (Sean, 2026-10-15: "right click does not give me paste options or the right
 * menu we built"). The app-wide menu (AppContextMenu) leaves typing areas to the
 * browser because it could not paste; this one can — the browser asks once for
 * permission to read the clipboard, and if it refuses, the menu says to use Ctrl+V.
 *
 * Shift+right-click still opens the browser's own menu (spelling suggestions live
 * there), and a long-press on a phone keeps the phone's text handles.
 */
export function EditorContextMenu({
  editor,
  onPastedImages,
  className,
  children,
}: {
  editor: Editor;
  /** RichTextEditor's own picture handling; false when this editor takes no pictures. */
  onPastedImages: (files: File[]) => boolean;
  className?: string;
  children: ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const touch = useRef(false);

  async function copy() {
    const { dom, text } = editor.view.serializeForClipboard(editor.state.selection.content());
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([dom.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return true;
    } catch {
      toast.error("Your browser didn't allow copying from this menu — press Ctrl+C instead.");
      return false;
    }
  }

  async function paste(plain: boolean) {
    editor.commands.focus();
    try {
      if (plain) {
        const text = await navigator.clipboard.readText();
        if (text) editor.view.pasteText(text);
        return;
      }
      for (const item of await navigator.clipboard.read()) {
        const kind = pasteKind(item.types);
        if (kind === "image") {
          const type = item.types.find((t) => t.startsWith("image/")) ?? "image/png";
          const file = new File([await item.getType(type)], "Pasted picture", { type });
          if (!onPastedImages([file])) toast.error("Pictures can't be pasted here.");
        } else if (kind === "html") {
          editor.view.pasteHTML(await (await item.getType("text/html")).text());
        } else if (kind === "text") {
          editor.view.pasteText(await (await item.getType("text/plain")).text());
        }
      }
    } catch {
      toast.error("Your browser didn't allow pasting from this menu — press Ctrl+V instead.");
    }
  }

  function applyLink(url: string) {
    const chain = editor.chain().focus();
    // Nothing selected: put the address itself in as the link, as Outlook does.
    if (editor.state.selection.empty && !editor.isActive("link")) {
      chain.insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
    } else {
      chain.extendMarkRange("link").setLink({ href: url }).run();
    }
  }

  const selected = !editor.state.selection.empty;
  const href = String(editor.getAttributes("link").href ?? "");
  const inLink = editor.isActive("link");
  const inTable = editor.isActive("table");
  const run = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => command(editor.chain().focus()).run();

  return (
    <div
      className={className}
      onPointerDown={(event) => { touch.current = event.pointerType !== "mouse"; }}
      onContextMenu={(event) => {
        if (event.shiftKey || touch.current) return;
        event.preventDefault();
        // React bubbles events out of the menu's portal to here: a right-click ON the menu does nothing.
        if (!event.currentTarget.contains(event.target as Node)) return;
        setAt({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      <DropdownMenu open={at !== null} onOpenChange={(open) => { if (!open) setAt(null); }}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden style={{ position: "fixed", left: at?.x ?? 0, top: at?.y ?? 0, width: 0, height: 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={2}
          className="min-w-56"
          // Back to the message, not to the invisible anchor.
          onCloseAutoFocus={(event) => { event.preventDefault(); editor.commands.focus(); }}
        >
          <DropdownMenuItem disabled={!selected} onSelect={() => void copy().then((ok) => ok && editor.chain().focus().deleteSelection().run())}>
            Cut<DropdownMenuShortcut>Ctrl+X</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!selected} onSelect={() => void copy()}>
            Copy<DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void paste(false)}>
            Paste<DropdownMenuShortcut>Ctrl+V</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void paste(true)}>
            Paste as plain text<DropdownMenuShortcut>Ctrl+Shift+V</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setLinkOpen(true)}>{inLink ? "Edit link…" : "Link…"}</DropdownMenuItem>
          {inLink && /^(https?:|mailto:)/i.test(href) && (
            <DropdownMenuItem onSelect={() => window.open(href, "_blank", "noopener,noreferrer")}>Open link</DropdownMenuItem>
          )}
          {inLink && <DropdownMenuItem onSelect={() => run((c) => c.extendMarkRange("link").unsetLink())}>Remove link</DropdownMenuItem>}
          {inTable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => run((c) => c.addRowBefore())}>Insert row above</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run((c) => c.addRowAfter())}>Insert row below</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run((c) => c.addColumnBefore())}>Insert column left</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run((c) => c.addColumnAfter())}>Insert column right</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run((c) => c.deleteRow())}>Delete row</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run((c) => c.deleteColumn())}>Delete column</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => run((c) => c.deleteTable())}>Delete table</DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => run((c) => c.unsetAllMarks().clearNodes())}>Clear formatting</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run((c) => c.selectAll())}>
            Select all<DropdownMenuShortcut>Ctrl+A</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Shift + right-click for spelling</DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>
      {linkOpen && (
        <TextPromptDialog
          open
          onOpenChange={setLinkOpen}
          title={inLink ? "Edit link" : "Insert link"}
          description="Paste the full destination URL."
          label="Link URL"
          defaultValue={href || "https://"}
          submitLabel="Apply link"
          onSubmit={applyLink}
        />
      )}
    </div>
  );
}
