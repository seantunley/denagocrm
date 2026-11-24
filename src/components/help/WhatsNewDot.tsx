"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useSettingsViewer } from "@/components/SettingsViewer";
import { WHATS_NEW, parseSeen, unseenCount, whatsNewFor } from "@/lib/help/whatsNew";
import { readSeenRaw, subscribeSeen } from "@/lib/help/whatsNewSeen";

/** How many "what's new" entries this person has not opened yet, on this device. 0 on the server and until the page is live. */
export function useUnseenWhatsNew(): number {
  const seen = useSettingsViewer();
  const raw = useSyncExternalStore(subscribeSeen, readSeenRaw, () => null);
  return useMemo(() => {
    if (raw === null) return 0;
    const entries = whatsNewFor(WHATS_NEW, { owner: seen?.viewer.isOwner ?? false, modules: seen?.enabled ?? null });
    return unseenCount(entries, parseSeen(raw));
  }, [raw, seen]);
}

/** A dot on the help icon while there is something new. Position it with `className`; the parent must be `relative`. */
export default function WhatsNewDot({ className = "" }: { className?: string }) {
  const unseen = useUnseenWhatsNew();
  if (unseen === 0) return null;
  return (
    <span className={`pointer-events-none absolute size-2 rounded-full bg-primary ring-2 ring-sidebar ${className}`}>
      <span className="sr-only">{unseen} new in the help centre</span>
    </span>
  );
}
