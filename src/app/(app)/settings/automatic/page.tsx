import Link from "next/link";
import { MessageSquareWarning, Users, Cog } from "lucide-react";
import { requireTenantOwner } from "@/lib/auth";
import { SettingsWorkspace, SettingsSection } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { AUTOMATIONS, type Automation, type AutomationReach } from "@/lib/automationRegister";
import { readAutomationSwitches } from "@/app/actions/automationSettings";
import { AutomationSwitch } from "./AutomationSwitch";

export const dynamic = "force-dynamic";

const GROUPS: { reach: AutomationReach; title: string; description: string; icon: typeof Users }[] = [
  {
    reach: "customer",
    title: "Can message your customers",
    description: "Nothing here contacts a customer unless it is switched on — here, or on the screen it names.",
    icon: MessageSquareWarning,
  },
  { reach: "staff", title: "Notifies your team", description: "Messages and notifications to the people in this workspace only.", icon: Users },
  { reach: "nobody", title: "Housekeeping", description: "Background work that sends nothing to anyone.", icon: Cog },
];

/**
 * EVERYTHING the CRM does by itself, in one place (automationRegister.ts).
 * Nothing runs that isn't on this page — tests/automationRegister.test.ts fails
 * the build if a background job or automatic message is added without it.
 */
export default async function AutomaticJobsPage() {
  await requireTenantOwner();
  const switches = await readAutomationSwitches();

  const row = (a: Automation) => (
    <li key={a.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{a.label}</p>
        <p className="text-sm text-muted-foreground">{a.does}</p>
        <p className="text-xs text-muted-foreground">
          {a.when}
          {a.channels?.length ? ` · ${a.channels.join(", ")}` : ""}
        </p>
      </div>
      <div className="shrink-0 sm:pl-4">
        {a.setting ? (
          <AutomationSwitch settingKey={a.setting.key} initial={switches[a.setting.key] ?? a.setting.defaultOn} label={a.label} />
        ) : a.managedAt ? (
          <Link href={a.managedAt.href} className="text-sm text-primary underline">
            Set up in {a.managedAt.label}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">Always on</span>
        )}
        {a.setting && a.managedAt && (
          <Link href={a.managedAt.href} className="mt-1 block text-xs text-muted-foreground underline">
            Details in {a.managedAt.label}
          </Link>
        )}
      </div>
    </li>
  );

  return (
    <SettingsWorkspace
      current="automatic"
      title="Automatic jobs & messages"
      description="Everything the CRM does on its own — what it sends, to whom, and when — with the switch for each. If it isn't on this page, it doesn't run."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="space-y-6">
        {GROUPS.map((group) => (
          <SettingsSection key={group.reach} icon={group.icon} title={group.title} description={group.description}>
            <ul className="divide-y divide-border/50">{AUTOMATIONS.filter((a) => a.reaches === group.reach).map(row)}</ul>
          </SettingsSection>
        ))}
        <p className="text-sm text-muted-foreground">
          How the background work is doing — what&apos;s queued, stuck or failed — is on{" "}
          <Link href="/settings/queues" className="text-primary underline">Background queues</Link>.
        </p>
      </div>
    </SettingsWorkspace>
  );
}
