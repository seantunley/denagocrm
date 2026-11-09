"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Send, Truck } from "lucide-react";
import { bookVendorDelivery, type BookingTarget } from "@/app/actions/vendorDeliveries";

export type BookingVendor = { id: string; name: string; email: string | null };

/**
 * "Book delivery": the transport supplier, the day, from → to and a note for the driver. Email it to the supplier,
 * book and copy the message to send yourself (WhatsApp), or — arranged already by phone — just record it.
 * Only "Email it" sends anything, and only when Send booking is pressed.
 */
export default function BookDeliveryForm({ target, vendors, defaults }: {
  target: BookingTarget;
  vendors: BookingVendor[];
  defaults: { date: string; from: string; to: string };
}) {
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const vendor = vendors.find((v) => v.id === vendorId);
  const [send, setSend] = useState<"email" | "copy" | "record">(vendors[0]?.email ? "email" : "copy");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ error?: string; success?: string; message?: string; whatsapp?: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  if (vendors.length === 0) {
    return <p className="text-[11px] text-muted-foreground">Add a delivery company in <Link href="/settings/vendors" className="text-primary hover:underline">Settings → Suppliers</Link> to book deliveries.</p>;
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
        <Truck className="size-3" />Book delivery
      </button>
    );
  }
  return (
    <form
      className="grid gap-1.5 rounded-lg border border-border bg-muted/20 p-2.5 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        start(async () => setResult((await bookVendorDelivery(target, form)) ?? null));
      }}
    >
      <select
        name="vendorId"
        value={vendorId}
        onChange={(event) => {
          setVendorId(event.target.value);
          if (send !== "record") setSend(vendors.find((v) => v.id === event.target.value)?.email ? "email" : "copy");
        }}
        className="input h-8 text-xs"
        aria-label="Delivery company"
      >
        {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
      <input type="date" name="date" required defaultValue={defaults.date} className="input h-8 text-xs" aria-label="Delivery date" />
      <input name="from" required defaultValue={defaults.from} placeholder="Collect from" aria-label="Collect from" className="input h-8 text-xs" />
      <input name="to" required defaultValue={defaults.to} placeholder="Deliver to" aria-label="Deliver to" className="input h-8 text-xs" />
      <textarea name="note" rows={2} placeholder="Note for the driver (optional)" aria-label="Note for the driver" className="input text-xs" />
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <label className="flex items-center gap-1.5"><input type="radio" name="send" value="email" checked={send === "email"} onChange={() => setSend("email")} />Email it</label>
        <label className="flex items-center gap-1.5"><input type="radio" name="send" value="copy" checked={send === "copy"} onChange={() => setSend("copy")} />Copy for WhatsApp</label>
        <label className="flex items-center gap-1.5"><input type="radio" name="send" value="record" checked={send === "record"} onChange={() => setSend("record")} />Already arranged — just record it</label>
      </div>
      {send === "email" && (
        <input key={vendorId} name="email" type="email" required defaultValue={vendor?.email ?? ""} placeholder="bookings@example.com" aria-label="Delivery company email" className="input h-8 text-xs" />
      )}
      {result?.error && <p className="text-red-400">{result.error}</p>}
      {result?.success && <p className="text-emerald-400">{result.success}</p>}
      {result?.message && (
        <>
          <textarea readOnly value={result.message} rows={6} className="input text-[11px]" aria-label="Booking message" onFocus={(event) => event.currentTarget.select()} />
          <div className="flex gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={() => { void navigator.clipboard.writeText(result.message!); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
            {result.whatsapp && (
              <a href={`${result.whatsapp}?text=${encodeURIComponent(result.message)}`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">Open WhatsApp</a>
            )}
          </div>
        </>
      )}
      {!result?.success && (
        <div className="flex gap-2">
          <button type="submit" disabled={pending} className="btn-primary btn-sm">{send !== "record" && <Send className="size-3.5" />}{pending ? "Booking…" : send === "email" ? "Send booking" : send === "record" ? "Record booking" : "Book"}</button>
          <button type="button" onClick={() => setOpen(false)} className="btn-secondary btn-sm">Cancel</button>
        </div>
      )}
    </form>
  );
}
