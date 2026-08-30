import "server-only";
import { conditionsMet, localClock } from "@/lib/dashboard/conditions";
import { SECTION } from "@/lib/dashboard/config";
import { viewerConditionContext } from "@/lib/dashboard/viewer";
import { checklistHostSignals } from "./hostRecords";
import type { ChecklistRevisionItem } from "./types";

const VISIBILITY = SECTION.shape.visibility;

/** Resolve and freeze the steps applicable to this record and viewer. */
export async function visibleChecklistItems(
  items: readonly ChecklistRevisionItem[],
  hostType: string,
  hostId: string,
  tenantId: string,
  at = new Date(),
): Promise<ChecklistRevisionItem[]> {
  const [base, signals] = await Promise.all([
    viewerConditionContext(),
    checklistHostSignals(hostType, hostId, tenantId),
  ]);
  const clock = localClock(at);
  const context = {
    ...base,
    now: at,
    localMinutes: clock.minutes,
    localWeekday: clock.weekday,
    signals,
  };
  return items.filter((item) => {
    if (item.visibility == null) return true;
    const parsed = VISIBILITY.safeParse(item.visibility);
    return parsed.success && conditionsMet(parsed.data, context);
  });
}
