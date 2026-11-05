"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_RECORD_LABELS, type RecordLabels } from "@/lib/recordLabels";

/**
 * What this workspace calls leads, deals and job cards, for the client components in the shell (the menu, search,
 * the phone's bottom bar, quick actions). Read once by the (app) layout, as the activity types are; outside the shell
 * the built-in words stand.
 */
const RecordLabelsContext = createContext<RecordLabels>(DEFAULT_RECORD_LABELS);

export function RecordLabelsProvider({ labels, children }: { labels?: RecordLabels; children: ReactNode }) {
  return <RecordLabelsContext.Provider value={labels ?? DEFAULT_RECORD_LABELS}>{children}</RecordLabelsContext.Provider>;
}

export const useRecordLabels = (): RecordLabels => useContext(RecordLabelsContext);
