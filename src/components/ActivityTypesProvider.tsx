"use client";

import { createContext, useContext, type ReactNode } from "react";
import {
  activityTypeEmoji,
  activityTypeLabel,
  SYSTEM_ACTIVITY_TYPES,
  type ActivityType,
} from "@/lib/activityTypes";

/**
 * The workspace's activity types, handed to every client component that renders
 * a type picker or a type icon.
 *
 * A context rather than a prop threaded through each one: the pickers live in
 * QuickCreateDialog (mounted once in the shell and opened from six places), the
 * follow-up prompt, and the schedule/edit forms on lead and contact pages. Only
 * the (app) layout can read the setting — `getSetting` resolves the tenant from
 * the request scope — so the list enters the client tree exactly once, at the
 * shell, the same way the brand and the weather cities do.
 *
 * The default is the built-in list, NOT an empty one: a component rendered
 * outside the shell (a test, a print layout, a modal route) then still shows a
 * working picker instead of an empty <select>.
 */
const ActivityTypesContext = createContext<readonly ActivityType[]>(SYSTEM_ACTIVITY_TYPES);

export function ActivityTypesProvider({
  types,
  children,
}: {
  types?: readonly ActivityType[];
  children: ReactNode;
}) {
  return (
    <ActivityTypesContext.Provider value={types?.length ? types : SYSTEM_ACTIVITY_TYPES}>
      {children}
    </ActivityTypesContext.Provider>
  );
}

export function useActivityTypes(): readonly ActivityType[] {
  return useContext(ActivityTypesContext);
}

/**
 * A type's emoji, for server components that render one.
 *
 * The lists on the lead and contact pages are server-rendered, so they cannot
 * read the context themselves — this one-element client component can, which is
 * cheaper than threading the whole type list down through every page that
 * renders an ActivityPanel. The label rides along as the tooltip, so a custom
 * emoji nobody recognises is still identifiable.
 */
export function ActivityTypeIcon({ type, className }: { type: string; className?: string }) {
  const types = useActivityTypes();
  return (
    <span className={className} title={activityTypeLabel(types, type)}>
      {activityTypeEmoji(types, type)}
    </span>
  );
}
