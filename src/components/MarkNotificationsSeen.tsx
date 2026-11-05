"use client";

import { useEffect, useRef } from "react";
import { markNotificationsRead } from "@/app/actions/collaboration";

/**
 * Opening the notifications page reads them, once it is actually viewed (a client effect, like MarkLeadViewed — a
 * write during a server render can be skipped by a prefetch). The bell's count clears with it.
 */
export default function MarkNotificationsSeen({ unread }: { unread: number }) {
  const done = useRef(false);
  useEffect(() => {
    if (!unread || done.current) return;
    done.current = true;
    markNotificationsRead().catch(() => {});
  }, [unread]);
  return null;
}
