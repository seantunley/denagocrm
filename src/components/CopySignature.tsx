"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { SIGNATURE_GUIDES } from "@/lib/signatureCopy";

/**
 * Copy my signature — for Gmail, Outlook or a phone, so email sent outside the
 * CRM matches (lib/signatureCopy.ts). `html` and `text` are built on the server
 * from the same signature the send path uses; this only puts them on the
 * clipboard and says where to paste.
 *
 * The designed copy goes on the clipboard as HTML with the plain text beside
 * it, so a mail app's signature box pastes the design and a plain box pastes
 * the text. A browser that can't put HTML on the clipboard is told so — it is
 * never handed the plain text while being told it has the design.
 */
export default function CopySignature({ html, text, usesOwnHtml }: { html: string; text: string; usesOwnHtml: boolean }) {
  const [copied, setCopied] = useState<"designed" | "plain" | null>(null);

  const done = (which: "designed" | "plain") => {
    setCopied(which);
    window.setTimeout(() => setCopied((now) => (now === which ? null : now)), 2500);
  };

  async function copyDesigned() {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      toast.error("This browser can't copy a designed signature. Try Chrome, Edge or Safari — or use Copy as plain text.");
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      done("designed");
      toast.success("Signature copied — paste it into your mail app's signature box.");
    } catch {
      toast.error("Your browser didn't allow the copy. Click the button again, or use Copy as plain text.");
    }
  }

  async function copyPlain() {
    try {
      await navigator.clipboard.writeText(text);
      done("plain");
      toast.success("Signature copied as plain text.");
    } catch {
      toast.error("Your browser didn't allow the copy. Select the text below and copy it yourself.");
    }
  }

  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-4 py-2.5 text-sm text-muted-foreground">Use this signature in Gmail, Outlook or on your phone</summary>
      <div className="space-y-4 px-4 pb-4">
        <p className="text-sm text-muted-foreground">
          Emails you write in the CRM are signed for you. Copy the same signature into your other mail apps so everything you send matches.
          {usesOwnHtml ? " This copies your own HTML signature, since that is what your emails use." : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={copyDesigned} className="btn-primary btn-sm inline-flex items-center gap-1.5">
            {copied === "designed" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            {copied === "designed" ? "Copied" : "Copy my signature"}
          </button>
          <button type="button" onClick={copyPlain} className="btn-secondary btn-sm inline-flex items-center gap-1.5">
            {copied === "plain" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            {copied === "plain" ? "Copied" : "Copy as plain text"}
          </button>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          {copied === "designed" ? "Signature copied" : copied === "plain" ? "Signature copied as plain text" : ""}
        </span>

        <div className="space-y-2">
          {SIGNATURE_GUIDES.map((guide) => (
            <details key={guide.id} className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{guide.name}</summary>
              <div className="space-y-2 px-3 pb-3">
                <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                  {guide.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                {guide.note && <p className="text-xs text-muted-foreground">{guide.note}</p>}
              </div>
            </details>
          ))}
        </div>

        <div>
          <p className="label">Plain text version</p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">{text}</pre>
        </div>
        <p className="text-xs text-muted-foreground">
          The pasted signature is a copy. If your details, the logo or the workspace design change, copy and paste it again. Menu names in Gmail and Outlook change from time to time — look for Signature in their settings.
        </p>
      </div>
    </details>
  );
}
