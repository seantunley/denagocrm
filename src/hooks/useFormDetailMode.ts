"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  readFormDetailMode,
  writeFormDetailMode,
  type CreateFormKey,
  type FormDetailMode,
} from "@/lib/createFormDetail";

/** Fired after a write so every form on the page agrees with storage. */
const CHANGE_EVENT = "denago:create-form-detail";

/**
 * The last choice made in THIS page, kept in memory as well as in storage: in a
 * private window or with site data blocked the write is swallowed, and without
 * this the toggle would read back the old value and appear to do nothing.
 */
const chosen = new Map<CreateFormKey, FormDetailMode>();

/** Even touching `window.localStorage` throws when site data is blocked. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

/**
 * Compact or expanded, remembered per device.
 *
 * localStorage is the external store here. The server snapshot is the
 * documented default (compact), so server and client markup agree and the
 * remembered choice is applied in the first client render after hydration.
 */
export function useFormDetailMode(form: CreateFormKey): [boolean, (expanded: boolean) => void] {
  const mode = useSyncExternalStore<FormDetailMode>(
    subscribe,
    () => chosen.get(form) ?? readFormDetailMode(storage(), form),
    () => "compact",
  );

  const setExpanded = useCallback(
    (expanded: boolean) => {
      const next: FormDetailMode = expanded ? "expanded" : "compact";
      chosen.set(form, next);
      writeFormDetailMode(storage(), form, next);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [form],
  );

  return [mode === "expanded", setExpanded];
}
