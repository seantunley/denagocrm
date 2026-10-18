"use client";

import { useId, useState, type ReactNode } from "react";
import { MessageSquare, Phone, StickyNote } from "lucide-react";
import { cn } from "@/lib/utils";

const modes = [
  { key: "note", label: "Internal note", icon: StickyNote },
  { key: "whatsapp", label: "WhatsApp", icon: MessageSquare },
  { key: "call", label: "Log a call", icon: Phone },
] as const;

type Mode = (typeof modes)[number]["key"];

/**
 * The channels to offer: only those the page passed a panel for. Each channel has its OWN permission (email, notes
 * and calls: contacts.edit or leads.edit; WhatsApp: inbox.reply), so the page passes a panel only to someone the
 * server will let use it — never a button that is refused, nor one withheld from someone who may (review of #894).
 */
export function offeredModes(panels: Partial<Record<Mode, ReactNode>>): Mode[] {
  // `canX && <Panel />` passes `false` for a channel that is not theirs.
  return modes.filter(({ key }) => Boolean(panels[key])).map(({ key }) => key);
}

/** Panels stay mounted: switching channels must not discard a draft or attachment. */
export default function CustomerComposer({ email, whatsapp, note, call }: {
  email?: ReactNode; whatsapp?: ReactNode; note?: ReactNode; call?: ReactNode;
}) {
  const panels = { note, whatsapp, call };
  const offered = offeredModes(panels);
  const [mode, setMode] = useState<Mode | undefined>(offered[0]);
  const id = useId();
  if (!email && offered.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card" aria-label="Contact customer or add a record">
      <div className="flex flex-wrap items-center gap-1 border-b border-border p-2">
        {email}
        {modes.filter(({ key }) => offered.includes(key)).map(({ key, label, icon: Icon }) => (
          <button key={key} type="button" aria-pressed={mode === key} aria-controls={`${id}-${key}`} onClick={() => setMode(key)}
            className={cn("inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary", mode === key ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
            <Icon className="size-4" aria-hidden="true" />{label}
          </button>
        ))}
      </div>
      {modes.filter(({ key }) => offered.includes(key)).map(({ key, label }) => <div key={key} id={`${id}-${key}`} hidden={mode !== key} aria-label={label} className="p-4">{panels[key]}</div>)}
    </section>
  );
}
