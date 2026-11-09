"use client";

import { useState, useTransition } from "react";
import { Send } from "lucide-react";
import { requestSupplierDocument } from "@/app/actions/documentRequests";
import { REQUEST_DAYS, REQUEST_DEFAULT_DAYS } from "@/lib/documentRequestRules";

/**
 * "Ask the supplier for it" beside a missing supplier paper in the deal file. Email it to the supplier, or make the
 * link to send yourself (WhatsApp) — shown here once, to copy. Nothing is sent until Send is pressed.
 */
export default function DocumentRequestButton({ quoteId, vendor, documentType }: {
  quoteId: string;
  vendor: { id: string; name: string; email: string | null };
  documentType: string;
}) {
  const [open, setOpen] = useState(false);
  const [send, setSend] = useState<"email" | "link">(vendor.email ? "email" : "link");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ error?: string; success?: string; link?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-[11px] font-medium text-primary hover:underline">
        Ask {vendor.name}
      </button>
    );
  }
  return (
    <form
      className="mt-1.5 grid gap-2 rounded-lg border border-border bg-muted/20 p-2.5 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(async () => setResult((await requestSupplierDocument(quoteId, form)) ?? null));
      }}
    >
      <input type="hidden" name="vendorId" value={vendor.id} />
      <input type="hidden" name="documentType" value={documentType} />
      <p className="font-medium">Ask {vendor.name} to upload their {documentType.toLowerCase()}</p>
      <div className="flex gap-3">
        <label className="flex items-center gap-1.5"><input type="radio" name="send" value="email" checked={send === "email"} onChange={() => setSend("email")} />Email it</label>
        <label className="flex items-center gap-1.5"><input type="radio" name="send" value="link" checked={send === "link"} onChange={() => setSend("link")} />Copy the link</label>
      </div>
      {send === "email" && (
        <input name="to" type="email" required defaultValue={vendor.email ?? ""} placeholder="supplier@example.com" className="input h-8 text-xs" aria-label="Supplier email" />
      )}
      <label className="flex items-center gap-2 text-muted-foreground">
        Works for
        <select name="days" defaultValue={REQUEST_DEFAULT_DAYS} className="input h-8 w-24 text-xs">
          {REQUEST_DAYS.map((days) => <option key={days} value={days}>{days} days</option>)}
        </select>
      </label>
      {result?.error && <p className="text-red-400">{result.error}</p>}
      {result?.success && <p className="text-emerald-400">{result.success}</p>}
      {result?.link && (
        <div className="flex items-center gap-2">
          <input readOnly value={result.link} className="input h-8 flex-1 text-[11px]" aria-label="Upload link" onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="btn-secondary btn-sm" onClick={() => { void navigator.clipboard.writeText(result.link!); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
        </div>
      )}
      {!result?.success && (
        <div className="flex gap-2">
          <button type="submit" disabled={pending} className="btn-primary btn-sm"><Send className="size-3.5" />{pending ? "Sending…" : send === "email" ? "Send request" : "Make link"}</button>
          <button type="button" onClick={() => setOpen(false)} className="btn-secondary btn-sm">Cancel</button>
        </div>
      )}
    </form>
  );
}
