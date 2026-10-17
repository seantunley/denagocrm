"use client";
import { useId } from "react";
import { X } from "lucide-react";
import { isReplyToAddress, parseAddressList } from "@/lib/replyToAddresses";

/** Uncommitted text is included too: clicking Send never drops the last address. */
export default function EmailRecipients({ label, name, value, onChange, required = false, disabled = false }: {
  label: string; name: string; value: string; onChange: (value: string) => void; required?: boolean; disabled?: boolean;
}) {
  const id = useId();
  const parts = value.split(/[,;]/);
  const input = parts.pop() ?? "";
  const chips = parts.map((part) => part.trim()).filter(Boolean);
  const parsed = parseAddressList(value, 10);
  const commit = () => { if (input.trim()) onChange([...chips, input.trim(), ""].join(", ")); };
  return <div className="min-w-0 flex-1">
    <label htmlFor={id} className="sr-only">{label}</label>
    <input type="hidden" name={name} value={value} />
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background/40 px-2 py-1.5 focus-within:border-primary">
      {chips.map((email, index) => <span key={`${email}-${index}`} className={`inline-flex max-w-full items-center gap-1 rounded-md px-2 py-1 text-xs ${isReplyToAddress(email) ? "bg-muted text-foreground" : "bg-red-500/10 text-red-300"}`}>
        <span className="break-all">{email}</span>
        <button type="button" disabled={disabled} aria-label={`Remove ${email} from ${label}`} onClick={() => onChange([...chips.filter((_, i) => i !== index), input].join(", "))} className="rounded p-0.5 focus-visible:ring-2 focus-visible:ring-primary"><X className="size-3" /></button>
      </span>)}
      <input id={id} type="text" inputMode="email" autoComplete="off" spellCheck={false} value={input} required={required && chips.length === 0} disabled={disabled} aria-invalid={!parsed.ok || undefined} aria-describedby={!parsed.ok ? `${id}-error` : undefined}
        onChange={(e) => onChange([...chips, e.target.value].join(", "))} onBlur={commit}
        onKeyDown={(e) => { if (["Enter", ";", ","].includes(e.key)) { e.preventDefault(); commit(); } }}
        placeholder={chips.length ? "Add another…" : "name@example.com"} className="min-w-28 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground" />
    </div>
    {!parsed.ok && <p id={`${id}-error`} className="mt-1 text-xs text-red-300">Check {label}: {parsed.invalid.join(", ")}</p>}
  </div>;
}
