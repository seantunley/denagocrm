"use client";

import { useEffect } from "react";
import { markRead } from "@/lib/help/readStore";

/** Opening a guide ticks it on this person's guided paths (lib/help/readStore.ts). Renders nothing. */
export default function MarkHelpRead({ storageKey, slug }: { storageKey: string; slug: string }) {
  useEffect(() => {
    markRead(storageKey, slug);
  }, [storageKey, slug]);
  return null;
}
