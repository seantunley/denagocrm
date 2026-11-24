"use client";

import { useEffect } from "react";
import { markSeen } from "@/lib/help/whatsNewSeen";

/** Opening "What's new" clears the dot for the entries shown (lib/help/whatsNewSeen.ts). Renders nothing. */
export default function MarkWhatsNewSeen({ ids }: { ids: string[] }) {
  const key = ids.join(",");
  useEffect(() => {
    markSeen(key ? key.split(",") : []);
  }, [key]);
  return null;
}
