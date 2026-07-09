"use client";

import { useEffect, useRef } from "react";
import { markLeadViewed } from "@/app/actions/leads";

/**
 * Reliably marks a lead as opened once the page is actually viewed (a client
 * effect fires on real navigation, unlike a write during server render which a
 * cached/prefetched render can skip). Clears the NEW pill on the board.
 */
export default function MarkLeadViewed({ leadId, viewed }: { leadId: string; viewed: boolean }) {
  const done = useRef(false);
  useEffect(() => {
    if (viewed || done.current) return;
    done.current = true;
    markLeadViewed(leadId).catch(() => {});
  }, [leadId, viewed]);
  return null;
}
