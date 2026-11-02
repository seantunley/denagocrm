import { canAccessContact, canAccessJobCard, canAccessLead, canAccessQuote, canAccessVehicle, type PermissionUser } from "./permissions";
import type { ListedKind, ListedRecord, ListedSlot } from "./assistantListedRules";

const CAN_OPEN: Record<ListedKind, (user: PermissionUser, id: string) => Promise<boolean>> = {
  lead: canAccessLead,
  quote: canAccessQuote,
  contact: canAccessContact,
  vehicle: canAccessVehicle,
  jobcard: canAccessJobCard,
};

/**
 * An earlier answer's list (assistantListedRules), as THIS person may see it NOW: each record through the same
 * access check its page uses, in this workspace. One reassigned, deleted or put out of reach since is an empty
 * place — still numbered and still its kind, so the places after it keep theirs ("the first quote" too), and with
 * no id or name, so it is not shown again.
 * A check that fails counts as "can't open".
 */
export async function listedNow(user: PermissionUser, listed: ListedRecord[]): Promise<ListedSlot[]> {
  // ponytail: one access check per record (at most MAX_LISTED); batch per kind if this shows in the timings.
  return Promise.all(listed.map(async (r): Promise<ListedSlot> => ((await CAN_OPEN[r.kind](user, r.id).catch(() => false)) ? r : { kind: r.kind, gone: true })));
}
