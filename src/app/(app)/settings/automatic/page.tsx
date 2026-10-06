import Link from "next/link";
import { requireTenantOwner } from "@/lib/auth";
import { SettingsWorkspace, SettingsSection } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { AUTOMATIONS, type Automation, type AutomationReach } from "@/lib/automationRegister";
import { readAutomationSwitches } from "@/app/actions/automationSettings";
import { SIGNING_EMAILS, type SigningEmailKind } from "@/lib/signing/emailTemplates";
import { AutomationSwitch } from "./AutomationSwitch";

export const dynamic = "force-dynamic";

// No icons: SettingsSection is a client component, and an icon component can't
// cross from this server page to it.
const GROUPS: { reach: AutomationReach; title: string; description: string }[] = [
  {
    reach: "customer",
    title: "Can message your customers",
    description: "Nothing here contacts a customer unless it is switched on — here, or on the screen it names.",
  },
  { reach: "staff", title: "Notifies your team", description: "Messages and notifications to the people in this workspace only." },
  { reach: "nobody", title: "Housekeeping", description: "Background work that sends nothing to anyone." },
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
        {/* What it actually sends — each message opens in its editor, to read and change. */}
        {a.messages?.length ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-xs">
            {a.messages.map((kind) => {
              const def = SIGNING_EMAILS[kind as SigningEmailKind];
              return def ? (
                <li key={kind}>
                  <Link href={`/settings?tab=email&open=${kind}#template-${kind}`} className="text-primary underline">
                    {def.label.replace(/ \((email|SMS|WhatsApp)\)$/, "")} ({def.channel === "sms" ? "SMS" : def.channel === "whatsapp" ? "WhatsApp" : "email"}) — view / edit
                  </Link>
                </li>
              ) : null;
            })}
          </ul>
        ) : a.messagesAt ? (
          <p className="pt-1 text-xs">
            <Link href={a.messagesAt.href} className="text-primary underline">
              The wording is written on {a.messagesAt.label} — view / edit
            </Link>
          </p>
        ) : null}
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
          <SettingsSection key={group.reach} title={group.title} description={group.description}>
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
