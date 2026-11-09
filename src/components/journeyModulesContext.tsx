"use client";

import { createContext, useContext } from "react";
import { missingModule, moduleLabel, STEP_MODULE, TRIGGER_MODULE } from "@/lib/journeyModules";
import type { ModuleId } from "@/lib/modules/registry";

/**
 * The workspace's enabled modules, for the journey builder's trigger and step pickers (journeyModules.ts). Null —
 * no provider — offers everything, so a builder rendered without it behaves as it always did.
 */
export const JourneyModulesContext = createContext<ReadonlySet<string> | null>(null);

/** Why a trigger or step type isn't offered here ("needs Automotive / Workshop"), or null when it is. */
export function useModuleBlock(): { trigger: (type: string) => string | null; step: (type: string) => string | null } {
  const enabled = useContext(JourneyModulesContext);
  const why = (needed: ModuleId | undefined) => {
    const off = enabled ? missingModule(needed, enabled) : null;
    return off ? `needs ${moduleLabel(off)}` : null;
  };
  return { trigger: (type) => why(TRIGGER_MODULE[type]), step: (type) => why(STEP_MODULE[type]) };
}
