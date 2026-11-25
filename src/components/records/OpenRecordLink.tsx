"use client";

import type { ReactNode } from "react";
import { fullRecordHref, type RecordRef } from "@/lib/records/ref";
import { openRecord } from "./drawerNav";

/**
 * A record's name in a list. A plain click opens it in the drawer beside the list;
 * Ctrl/Cmd/Shift-click, a middle click or "open in new tab" still go to the full
 * page, because it is a real link to it.
 */
export default function OpenRecordLink({ record, className, children }: { record: RecordRef; className?: string; children: ReactNode }) {
  return (
    <a
      href={fullRecordHref(record)}
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openRecord(record, event.currentTarget);
      }}
    >
      {children}
    </a>
  );
}
