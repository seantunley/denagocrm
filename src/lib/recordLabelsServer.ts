import "server-only";
import { cache } from "react";
import { getSetting } from "./settings";
import { parseRecordLabels, RECORD_LABELS_KEY, type RecordLabels } from "./recordLabels";

/** This workspace's names for its records, once per request. Never throws: the built-in words on any failure. */
export const getRecordLabels = cache(async (): Promise<RecordLabels> =>
  parseRecordLabels(await getSetting(RECORD_LABELS_KEY).catch(() => null)),
);
