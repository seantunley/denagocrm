"use client";

import { useEffect, useRef, useState } from "react";
import { Plate, PlateContent, PlateElement, usePlateEditor } from "platejs/react";
import { BasicBlocksPlugin, BasicMarksPlugin } from "@platejs/basic-nodes/react";
import { IndentPlugin } from "@platejs/indent/react";
import { ListPlugin } from "@platejs/list/react";
import { toggleList } from "@platejs/list";
import { LinkPlugin } from "@platejs/link/react";
import { upsertLink } from "@platejs/link";
import { MergeFieldPlugin } from "@/components/doceditor/RichText";
import type { EmailPreview } from "@/app/actions/emails";

/* eslint-disable @typescript-eslint/no-explicit-any */

function LinkElement(props: any) {
  return (
    <PlateElement {...props} as="a" attributes={{ ...props.attributes, href: props.element.url }} className="text-orange-600 underline">
      {props.children}
    </PlateElement>
  );
}

/** Plate stores a list item as a flagged paragraph; draw the bullet / number for it. */
function BlockList(props: any) {
  if (!props.element.listStyleType) return;
  return function List(p: any) {
    const Tag = p.element.listStyleType === "decimal" ? "ol" : "ul";
    return (
      <Tag style={{ listStyleType: p.element.listStyleType, margin: 0, paddingLeft: 22 * (p.element.indent ?? 1) }} start={p.element.listStart}>
        <li>{p.children}</li>
      </Tag>
    );
  };
}

const TARGETS = ["p", "h2", "h3", "blockquote"];

/**
 * Whether the <details> this editor sits in is open. Settings lists every
 * template folded shut; rendering a server preview for each one on page load
 * fired a dozen-plus server renders nobody was looking at.
 */
function useOpenInDetails(ref: React.RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = ref.current?.closest("details");
    if (!details) {
      setOpen(true);
      return;
    }
    const sync = () => setOpen(details.open);
    sync();
    details.addEventListener("toggle", sync);
    return () => details.removeEventListener("toggle", sync);
  }, [ref]);
  return open;
}

/** Debounced server preview — only the newest answer is shown, and only while the template is open. */
function useLivePreview(
  preview: (fd: FormData) => Promise<EmailPreview>,
  fields: Record<string, string>,
  enabled: boolean,
  refreshKey?: string,
) {
  const [shown, setShown] = useState<EmailPreview>({});
  const seq = useRef(0);
  const key = JSON.stringify(fields);
  useEffect(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(JSON.parse(key) as Record<string, string>)) fd.set(k, v);
      const res = await preview(fd).catch(() => ({ error: "Preview unavailable — check your connection." }));
      if (mine === seq.current) setShown(res);
    }, 450);
    return () => clearTimeout(t);
  }, [key, preview, refreshKey, enabled]);
  return shown;
}

/**
 * A text message template: plain text (an SMS can't carry formatting), a
 * running length with the number of SMS parts, and the real message with
 * sample details underneath.
 */
export function SmsTemplateEditor({
  initialBody,
  fields,
  fieldHelp,
  requiredField,
  preview,
}: {
  initialBody: string;
  fields: readonly string[];
  fieldHelp: Record<string, string>;
  requiredField: string | null;
  preview: (formData: FormData) => Promise<EmailPreview>;
}) {
  const [body, setBody] = useState(initialBody);
  const ref = useRef<HTMLTextAreaElement>(null);
  const shown = useLivePreview(preview, { body }, useOpenInDetails(ref));
  const insert = (token: string) => {
    if (!token) return;
    const el = ref.current;
    const at = el?.selectionStart ?? body.length;
    const next = `${body.slice(0, at)}{{${token}}}${body.slice(el?.selectionEnd ?? at)}`;
    setBody(next);
  };
  const sample = shown.text ?? "";
  const parts = Math.max(1, Math.ceil(sample.length / 153));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="label">Text message</label>
        <select
          onChange={(e) => {
            insert(e.target.value);
            e.currentTarget.value = "";
          }}
          defaultValue=""
          className="h-7 rounded border border-border bg-background px-1 text-xs"
          title="Insert a field — filled in for each customer when the text is sent"
        >
          <option value="">＋ Insert field</option>
          {fields.map((f) => (
            <option key={f} value={f}>
              {fieldHelp[f] ?? f}
              {f === requiredField ? " (required)" : ""}
            </option>
          ))}
        </select>
      </div>
      <textarea ref={ref} name="body" className="input text-sm" rows={4} value={body} onChange={(e) => setBody(e.target.value)} required maxLength={640} />
      <div className="label">Preview — what the customer receives (sample details)</div>
      {shown.error ? (
        <div className="text-sm text-red-600">{shown.error}</div>
      ) : (
        <div className="max-w-sm rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{sample || "…"}</div>
      )}
      <p className="text-xs text-muted-foreground">
        {sample.length} characters · {parts} SMS part{parts === 1 ? "" : "s"}. Words in {"{{double braces}}"} are filled in for each customer.
      </p>
    </div>
  );
}

/**
 * The email template editor: formatted text on the left, the real email on the
 * right. The formatted body travels to the server as JSON in a hidden `doc`
 * field, where it is sanitised and turned into email HTML (lib/signing/emailDoc.ts).
 */
export function EmailTemplateEditor({
  initialSubject,
  initialDoc,
  fields,
  fieldHelp,
  requiredField,
  preview,
  refreshKey,
}: {
  initialSubject: string;
  initialDoc: unknown[];
  fields: readonly string[];
  fieldHelp: Record<string, string>;
  requiredField: string | null;
  preview: (formData: FormData) => Promise<EmailPreview>;
  /** Changes when a shared setting the preview depends on (e.g. header style) is saved. */
  refreshKey?: string;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [doc, setDoc] = useState<unknown[]>(initialDoc);
  const root = useRef<HTMLDivElement>(null);
  // Re-rendered on the server (the real brand, logo and button) a moment after typing stops.
  const shown = useLivePreview(preview, { subject, doc: JSON.stringify(doc) }, useOpenInDetails(root), refreshKey);

  const editor = usePlateEditor({
    plugins: [
      BasicBlocksPlugin,
      BasicMarksPlugin,
      IndentPlugin.configure({ inject: { targetPlugins: TARGETS } }),
      ListPlugin.configure({ inject: { targetPlugins: TARGETS }, render: { belowNodes: BlockList as any } }),
      LinkPlugin.withComponent(LinkElement),
      MergeFieldPlugin,
    ],
    value: initialDoc as any,
  });

  const run = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      editor.tf.focus();
      fn();
    } catch {
      /* a formatting command that doesn't apply here is a no-op */
    }
  };
  const mark = (key: string) => run(() => (editor.tf as any)[key]?.toggle?.());
  const block = (type: string) => run(() => (editor.tf as any).toggleBlock?.(type));
  const list = (listStyleType: "disc" | "decimal") => run(() => toggleList(editor as any, { listStyleType }));
  // Link: remember the selection, ask for the address inline, then apply it there.
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const savedSelection = useRef<any>(null);
  const openLink = (e: React.MouseEvent) => {
    e.preventDefault();
    savedSelection.current = editor.selection;
    setLinkUrl("https://");
  };
  const applyLink = () => {
    const url = (linkUrl ?? "").trim();
    setLinkUrl(null);
    if (!url || url === "https://") return;
    try {
      editor.tf.focus();
      if (savedSelection.current) editor.tf.select(savedSelection.current);
      upsertLink(editor as any, { url, text: editor.api.isCollapsed() ? url : undefined });
    } catch {
      /* no usable selection — nothing to link */
    }
  };
  const insertField = (token: string) => {
    if (!token) return;
    try {
      editor.tf.focus();
      (editor.tf as any).insertNodes({ type: "mergeField", token, children: [{ text: "" }] });
    } catch {
      (editor.tf as any).insertText?.(`{{${token}}}`);
    }
  };

  const tb = "h-7 min-w-7 rounded px-1.5 text-xs hover:bg-muted";
  return (
    // Stacked, not side by side: the Settings column is too narrow for two panes.
    <div ref={root} className="space-y-4">
      <div className="space-y-2 min-w-0">
        <label className="label">Subject</label>
        <input name="subject" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} />
        <label className="label">Message</label>
        <input type="hidden" name="doc" value={JSON.stringify(doc)} />
        <div className="rounded-lg border border-border bg-white text-slate-900">
          <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1 py-1 text-slate-700">
            <button type="button" title="Bold" onMouseDown={mark("bold")} className={`${tb} font-bold`}>B</button>
            <button type="button" title="Italic" onMouseDown={mark("italic")} className={`${tb} italic`}>I</button>
            <button type="button" title="Underline" onMouseDown={mark("underline")} className={`${tb} underline`}>U</button>
            <span className="mx-0.5 h-4 w-px bg-slate-200" />
            <button type="button" title="Heading" onMouseDown={block("h2")} className={tb}>H</button>
            <button type="button" title="Normal text" onMouseDown={block("p")} className={tb}>¶</button>
            <button type="button" title="Bullet list" onMouseDown={list("disc")} className={tb}>• List</button>
            <button type="button" title="Numbered list" onMouseDown={list("decimal")} className={tb}>1. List</button>
            <button type="button" title="Add a link to the selected text" onMouseDown={openLink} className={tb}>Link</button>
            <span className="mx-0.5 h-4 w-px bg-slate-200" />
            <select
              onChange={(e) => {
                insertField(e.target.value);
                e.currentTarget.value = "";
              }}
              defaultValue=""
              className="h-7 rounded border border-slate-200 bg-white px-1 text-xs"
              title="Insert a field — filled in for each customer when the email is sent"
            >
              <option value="">＋ Insert field</option>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {fieldHelp[f] ?? f}
                  {f === requiredField ? " (required)" : ""}
                </option>
              ))}
            </select>
          </div>
          {linkUrl !== null && (
            <div className="flex items-center gap-2 border-b border-border bg-slate-50 px-2 py-1.5">
              <input
                autoFocus
                className="h-7 flex-1 rounded border border-slate-300 bg-white px-2 text-xs text-slate-900"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault(); // never submit the template form
                    applyLink();
                  }
                  if (e.key === "Escape") setLinkUrl(null);
                }}
                placeholder="https://… or mailto:…"
                aria-label="Link address"
              />
              <button type="button" className="btn-primary btn-sm" onClick={applyLink}>Add link</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setLinkUrl(null)}>Cancel</button>
            </div>
          )}
          <Plate editor={editor} onChange={({ value }: any) => setDoc(value)}>
            <PlateContent className="min-h-48 px-3 py-2 text-[15px] leading-relaxed outline-none [&_.slate-p]:my-2 [&_.slate-h2]:my-2 [&_.slate-h2]:text-lg [&_.slate-h2]:font-semibold [&_.slate-blockquote]:border-l-2 [&_.slate-blockquote]:pl-3 [&_.slate-blockquote]:text-slate-600" />
          </Plate>
        </div>
        <p className="text-xs text-muted-foreground">
          Orange tags are filled in for each customer.
          {requiredField === "signing_link" && " A line holding only the signing link becomes the “Open & sign” button."}
          {requiredField === "code" && " The verification code must stay in the message."}
        </p>
      </div>
      <div className="min-w-0">
        <div className="label mb-2">Preview — exactly what the customer receives (sample details)</div>
        <div className="rounded-lg border border-border overflow-hidden bg-[#f1f5f9]">
          <div className="border-b border-border bg-white px-3 py-2 text-xs text-slate-700">
            <span className="text-slate-500">Subject: </span>
            {shown.subject ?? subject}
          </div>
          {shown.error ? (
            <div className="p-4 text-sm text-red-600">{shown.error}</div>
          ) : (
            // sandbox="" — the preview can show HTML but never run anything.
            <iframe title="Email preview" sandbox="" srcDoc={shown.html ?? ""} className="block h-[460px] w-full bg-[#f1f5f9]" />
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Logo, colour and footer come from Settings → Company profile and Branding.
        </p>
      </div>
    </div>
  );
}
