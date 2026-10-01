"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { SettingsViewer } from "@/lib/settings-navigation";

type Value = { viewer: SettingsViewer; enabled?: ReadonlySet<string> };

const Ctx = createContext<Value | null>(null);

/**
 * Who is looking, for settings navigation. Provided once by the app shell so the
 * ~30 settings pages' side nav filters itself instead of each page passing it.
 */
export function SettingsViewerProvider({
  isOwner,
  permissions,
  enabledModules,
  children,
}: {
  isOwner: boolean;
  permissions: string[];
  enabledModules?: string[];
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ viewer: { isOwner, permissions }, enabled: enabledModules ? new Set(enabledModules) : undefined }),
    [isOwner, permissions, enabledModules],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside the app shell — callers then leave their groups unfiltered (the pages guard themselves). */
export function useSettingsViewer(): Value | null {
  return useContext(Ctx);
}
