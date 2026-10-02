import { requireOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import ActivityTypesSettings from "@/components/settings/ActivityTypesSettings";
import { ACTIVITY_TYPES_KEY, activityTypeAvailable, resolveActivityTypes } from "@/lib/activityTypes";
import { getEnabledModuleIds } from "@/lib/modules/enabled";

export const dynamic = "force-dynamic";

/**
 * What this workspace can schedule.
 *
 * Filed under Sales & CRM beside the pipeline: it is the same kind of decision —
 * the vocabulary this business works in — and the settings index is a catalogue,
 * so anything not listed there is effectively unfindable.
 *
 * `requireOwner` here as well as in the action. The action is what actually
 * protects the write; this stops a member being shown a screen whose every
 * control would refuse them.
 */
export default async function ActivityTypesSettingsPage() {
  await requireOwner();
  // A built-in that needs a module this workspace lacks (test drive → automotive)
  // is not offered here at all. Leaving it out of the save is safe: the action
  // restores an omitted built-in untouched.
  const enabledModules = await getEnabledModuleIds().catch(() => null);
  const types = resolveActivityTypes(await getSetting(ACTIVITY_TYPES_KEY)).filter(
    (type) => !enabledModules || activityTypeAvailable(type.key, enabledModules),
  );

  return (
    <SettingsWorkspace
      current="activity-types"
      title="Activity types"
      description="What your team can put in the diary. Rename the built-in ones, hide the ones you never use, and add your own — each with its own name, icon and whether it carries a location."
      groups={SETTINGS_NAV_GROUPS}
    >
      <ActivityTypesSettings initial={types} />
    </SettingsWorkspace>
  );
}
