import { MODULE_REGISTRY, type ModuleId } from "./modules/registry";

/**
 * Journey triggers and steps that belong to a module (Sean, 2026-11-09: "are automotive triggers removed when
 * automotive module is not selected?" — they were not). With the module off the builder doesn't offer them,
 * publishing a journey that uses one is refused with the reason, and the scheduler doesn't sweep for them.
 * Pure: the builder (browser), the publish action and the scheduler all read this one map.
 */
export const TRIGGER_MODULE: Readonly<Record<string, ModuleId>> = {
  // Job cards, vehicles, test drives and the deliveries board are the Automotive / Workshop pack's.
  job_completed: "automotive",
  vehicle_delivered: "automotive",
  test_drive_booked: "automotive",
  test_drive_completed: "automotive",
  test_drive_no_show: "automotive",
  delivered: "automotive",
  delivery_scheduled: "automotive",
  // Swept from vehicles: purchase dates, service history.
  purchase_anniversary: "automotive",
  win_back: "automotive",
  service_due: "automotive",
};

export const STEP_MODULE: Readonly<Record<string, ModuleId>> = {
  send_service_reminder: "automotive",
};

/** The module a trigger or step type needs that `enabled` lacks, or null when it is available. */
export function missingModule(needed: ModuleId | undefined, enabled: ReadonlySet<string>): ModuleId | null {
  return needed && !enabled.has(needed) ? needed : null;
}

export const moduleLabel = (id: ModuleId): string => MODULE_REGISTRY.find((mod) => mod.id === id)?.label ?? id;

/** Every step type in a journey definition, nested ones included (branches and loops keep theirs in config). */
export function stepTypesIn(definition: unknown): Set<string> {
  const types = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.type === "string" && typeof record.id === "string") types.add(record.type);
      Object.values(record).forEach(visit);
    }
  };
  visit(definition);
  return types;
}

/** Why a journey can't run in this workspace — one line per trigger or step whose module is off. Empty: it can. */
export function journeyModuleProblems(
  triggers: ReadonlyArray<{ type: string }>,
  definition: unknown,
  enabled: ReadonlySet<string>,
  labels: { trigger: (type: string) => string; step: (type: string) => string },
): string[] {
  const problems: string[] = [];
  for (const trigger of triggers) {
    const off = missingModule(TRIGGER_MODULE[trigger.type], enabled);
    if (off) problems.push(`The trigger “${labels.trigger(trigger.type)}” needs the ${moduleLabel(off)} module.`);
  }
  for (const type of stepTypesIn(definition)) {
    const off = missingModule(STEP_MODULE[type], enabled);
    if (off) problems.push(`The step “${labels.step(type)}” needs the ${moduleLabel(off)} module.`);
  }
  return problems;
}
