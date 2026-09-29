import { requireOwner } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import ActivityTypesSettings from "@/components/settings/ActivityTypesSettings";
import { ACTIVITY_TYPES_KEY, resolveActivityTypes } from "@/lib/activityTypes";

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
  const types = resolveActivityTypes(await getSetting(ACTIVITY_TYPES_KEY));

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
